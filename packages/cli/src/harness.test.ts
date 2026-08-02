import { execFile } from "node:child_process";
import { mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { FilesystemArtifactStore, GateLockCoordinator, VerificationReportLedger } from "@notdone/core";
import { SCHEMA_VERSION, type ExecutionBackend, type ExecutionPlan, type TaskContract, type VerificationReport } from "@notdone/protocol";
import { describe, expect, it } from "vitest";

import { harnessReports, harnessStatus, importHarnessEvidence, parseHarnessRequest, runNextHarness, type HarnessRequest } from "./harness.js";

const execute = promisify(execFile);
const timestamp = "2026-08-01T12:00:00.000Z";
const now = () => new Date(timestamp);

async function fixture(): Promise<{ root: string; workspace: string; artifacts: string; head: string }> {
  const root = await mkdtemp(join(tmpdir(), "notdone-cli-harness-"));
  const workspace = join(root, "target");
  const artifacts = join(root, "artifacts");
  await execute("git", ["init", "-q", workspace]);
  await execute("git", ["config", "user.email", "test@example.invalid"], { cwd: workspace });
  await execute("git", ["config", "user.name", "NotDone test"], { cwd: workspace });
  await writeFile(join(workspace, "result.txt"), "done\n");
  await execute("git", ["add", "result.txt"], { cwd: workspace });
  await execute("git", ["commit", "-qm", "baseline"], { cwd: workspace });
  const { stdout } = await execute("git", ["rev-parse", "HEAD"], { cwd: workspace });
  return { root, workspace, artifacts, head: stdout.trim() };
}

function request(head: string, external = true): HarnessRequest {
  const contract: TaskContract = {
    schemaVersion: SCHEMA_VERSION, id: "task.harness", title: "Harness", createdAt: timestamp, frozenAt: timestamp, baseRevision: head, mode: "explicit",
    claims: [{ id: "claim.result", statement: "result exists", required: true, checks: [{ id: "check.result", type: "file", path: "result.txt", expect: { exists: true, contains: "done" } }] }],
  };
  const plan: ExecutionPlan = {
    schemaVersion: SCHEMA_VERSION, id: "plan.harness", createdAt: timestamp,
    steps: [{ schemaVersion: SCHEMA_VERSION, id: "step.codex", capability: "run", verificationGateIds: external ? ["gate.local", "gate.device"] : ["gate.local"] }],
    policy: { schemaVersion: SCHEMA_VERSION, externalNetwork: "allow", loopback: "deny", allowedTools: ["codex-exec"], approvalRequirement: "none" },
    verificationGates: external
      ? [{ schemaVersion: SCHEMA_VERSION, id: "gate.local", required: true }, { schemaVersion: SCHEMA_VERSION, id: "gate.device", required: true, evidenceRequirement: "external" as const }]
      : [{ schemaVersion: SCHEMA_VERSION, id: "gate.local", required: true }],
  };
  return { schemaVersion: SCHEMA_VERSION, runId: external ? "run.device" : "run.local", contract, plan, prompt: "Perform the requested task." };
}

function backend(counter: { count: number }): ExecutionBackend {
  return { manifest: { backendId: "fake-codex", capabilities: ["run"] }, execute: async () => { counter.count += 1; return {}; } };
}

function jsonRequest(value: HarnessRequest): any {
  return JSON.parse(JSON.stringify(value));
}

async function sealedLocalRun() {
  const value = await fixture(); const calls = { count: 0 }; const run = request(value.head, false);
  await runNextHarness({ artifactRoot: value.artifacts, targetWorkspace: value.workspace, request: run, context: { now, createBackend: () => backend(calls) } });
  const store = new FilesystemArtifactStore({ rootDirectory: value.artifacts });
  const transitionRecord = (await store.readImmutableRecords("notdone.gate-unlock-ledger.v1"))[0]!;
  const transition = JSON.parse(transitionRecord.content.toString("utf8")) as {
    effectiveReports: Array<{ artifactId: string; digest: string }>;
    requiredEvidenceBindings: Array<{ artifactId: string; digest: string }>;
  };
  return { value, run, store, transition };
}

describe("public harness commands", () => {
  it("does not turn a successful Codex execution into VERIFIED without external evidence", async () => {
    const value = await fixture(); const calls = { count: 0 };
    try {
      const result = await runNextHarness({ artifactRoot: value.artifacts, targetWorkspace: value.workspace, request: request(value.head), context: { now, createBackend: () => backend(calls) } });
      expect(result.status).toBe("AWAITING_DEVICE_EVIDENCE");
      expect(calls.count).toBe(1);
      const before = await new FilesystemArtifactStore({ rootDirectory: value.artifacts }).readImmutableRecords("notdone.gate-unlock-ledger.v1");
      expect((await harnessStatus(value.artifacts, "run.device")).status).toBe("AWAITING_DEVICE_EVIDENCE");
      const after = await new FilesystemArtifactStore({ rootDirectory: value.artifacts }).readImmutableRecords("notdone.gate-unlock-ledger.v1");
      expect(after).toEqual(before);
    } finally { await rm(value.root, { recursive: true, force: true }); }
  });

  it("imports opaque evidence idempotently without creating a PASS report", async () => {
    const value = await fixture(); const calls = { count: 0 };
    try {
      await runNextHarness({ artifactRoot: value.artifacts, targetWorkspace: value.workspace, request: request(value.head), context: { now, createBackend: () => backend(calls) } });
      const file = join(value.root, "device.bin"); await writeFile(file, Buffer.from("opaque bytes"));
      const first = await importHarnessEvidence({ artifactRoot: value.artifacts, runId: "run.device", gateId: "gate.device", file, capturedAt: timestamp });
      const second = await importHarnessEvidence({ artifactRoot: value.artifacts, runId: "run.device", gateId: "gate.device", file, capturedAt: timestamp });
      expect(second).toEqual(first);
      expect((await harnessReports(value.artifacts, "run.device")).history).toHaveLength(1);
      await expect(importHarnessEvidence({ artifactRoot: value.artifacts, runId: "run.device", gateId: "gate.device", file, capturedAt: timestamp, expectedDigest: "0".repeat(64) })).rejects.toThrow("digest");
    } finally { await rm(value.root, { recursive: true, force: true }); }
  });

  it("does not spawn Codex for a dirty or previously failed task", async () => {
    const value = await fixture(); const calls = { count: 0 };
    try {
      await writeFile(join(value.workspace, "dirty.txt"), "dirty");
      expect((await runNextHarness({ artifactRoot: value.artifacts, targetWorkspace: value.workspace, request: request(value.head, false), context: { now, createBackend: () => backend(calls) } })).status).toBe("BLOCKED");
      expect(calls.count).toBe(0);
    } finally { await rm(value.root, { recursive: true, force: true }); }
  });

  it("does not retry a failed current task as a later task", async () => {
    const value = await fixture(); const calls = { count: 0 }; const failed = request(value.head, false);
    failed.contract.claims[0]!.checks[0] = { id: "check.result", type: "file", path: "missing.txt", expect: { exists: true } };
    try {
      expect((await runNextHarness({ artifactRoot: value.artifacts, targetWorkspace: value.workspace, request: failed, context: { now, createBackend: () => backend(calls) } })).status).toBe("FAILED");
      expect((await runNextHarness({ artifactRoot: value.artifacts, targetWorkspace: value.workspace, request: failed, context: { now, createBackend: () => backend(calls) } })).status).toBe("FAILED");
      expect(calls.count).toBe(1);
    } finally { await rm(value.root, { recursive: true, force: true }); }
  });

  it("records FAILED before external evidence can be awaited when a required contract check fails", async () => {
    const value = await fixture(); const calls = { count: 0 }; const failing = request(value.head);
    failing.contract.claims[0]!.checks[0] = { id: "check.result", type: "file", path: "missing.txt", expect: { exists: true } };
    try {
      expect((await runNextHarness({ artifactRoot: value.artifacts, targetWorkspace: value.workspace, request: failing, context: { now, createBackend: () => backend(calls) } })).status).toBe("FAILED");
    } finally { await rm(value.root, { recursive: true, force: true }); }
  });

  it("rejects external-only plans and contracts without a required claim", () => {
    const externalOnly = jsonRequest(request("a".repeat(40)));
    externalOnly.plan.steps[0].verificationGateIds = ["gate.device"];
    externalOnly.plan.verificationGates = [externalOnly.plan.verificationGates[1]];
    expect(() => parseHarnessRequest(externalOnly)).toThrow("external-only");
    const optionalOnly = jsonRequest(request("a".repeat(40), false));
    optionalOnly.contract.claims[0].required = false;
    expect(() => parseHarnessRequest(optionalOnly)).toThrow("required claim");
  });

  it("stores automatic reports against a bundle containing both proof and baseline evidence", async () => {
    const value = await fixture(); const calls = { count: 0 };
    try {
      await runNextHarness({ artifactRoot: value.artifacts, targetWorkspace: value.workspace, request: request(value.head, false), context: { now, createBackend: () => backend(calls) } });
      const store = new FilesystemArtifactStore({ rootDirectory: value.artifacts });
      const report = (await new VerificationReportLedger(store).effectiveReport("run.local", "gate.local"))!.report;
      const bundle = JSON.parse((await store.read(report.evidenceBundle!.digest!)).toString("utf8")) as { evidence: Array<{ artifact: { artifactId: string } }> };
      expect(bundle.evidence.map((item) => item.artifact.artifactId)).toEqual(expect.arrayContaining([expect.stringMatching(/^artifact\.verification-proof\./u), expect.stringMatching(/^artifact\.baseline-diff\./u)]));
    } finally { await rm(value.root, { recursive: true, force: true }); }
  });

  it("requires a sealed, persisted PASS report with the exact external bundle before status is VERIFIED", async () => {
    const value = await fixture(); const calls = { count: 0 }; const run = request(value.head);
    try {
      await runNextHarness({ artifactRoot: value.artifacts, targetWorkspace: value.workspace, request: run, context: { now, createBackend: () => backend(calls) } });
      const file = join(value.root, "device.bin"); await writeFile(file, "opaque");
      await importHarnessEvidence({ artifactRoot: value.artifacts, runId: run.runId, gateId: "gate.device", file, capturedAt: timestamp });
      const store = new FilesystemArtifactStore({ rootDirectory: value.artifacts });
      const history = await store.readImmutableRecords("notdone.public-cli.run-history.v1");
      const imported = history.map((item) => JSON.parse(item.content.toString("utf8")) as { type: string; payload: { bundle: { artifactId: string; digest: string } } }).find((item) => item.type === "external-evidence")!;
      const evidenceBundle = { schemaVersion: SCHEMA_VERSION, ...imported.payload.bundle };
      const report: VerificationReport = { schemaVersion: SCHEMA_VERSION, id: "report.device.pass", createdAt: timestamp, gateId: "gate.device", verdict: "PASS", evidenceBundle };
      const ledger = new VerificationReportLedger(store); await ledger.append(run.runId, report);
      expect((await harnessStatus(value.artifacts, run.runId)).status).not.toBe("VERIFIED");
      expect(await store.readImmutableRecords("notdone.gate-unlock-ledger.v1")).toEqual([]);
      const automatic = (await ledger.effectiveReport(run.runId, "gate.local"))!.report.evidenceBundle as { schemaVersion: typeof SCHEMA_VERSION; artifactId: string; digest: string };
      await new GateLockCoordinator({ artifactStore: store, reportLedger: ledger }).unlock({ runId: run.runId, plan: run.plan, requiredEvidenceBundles: { "gate.local": automatic, "gate.device": evidenceBundle } });
      expect((await harnessStatus(value.artifacts, run.runId)).status).toBe("VERIFIED");
    } finally { await rm(value.root, { recursive: true, force: true }); }
  });

  it("strictly rejects malformed requests", () => {
    expect(() => parseHarnessRequest({ schemaVersion: SCHEMA_VERSION, runId: "x", prompt: "x", contract: {}, plan: {}, extra: true })).toThrow("unknown field");
  });

  it("fails closed when a sealed historical PASS report artifact is removed", async () => {
    const sealed = await sealedLocalRun();
    try {
      await rm(join(sealed.value.artifacts, ...sealed.store.relativePathForDigest(sealed.transition.effectiveReports[0]!.digest).split("/")));
      expect((await harnessStatus(sealed.value.artifacts, sealed.run.runId)).status).toBe("BLOCKED");
    } finally { await rm(sealed.value.root, { recursive: true, force: true }); }
  });

  it("fails closed when a sealed historical evidence bundle is removed or its evidence is changed", async () => {
    const removed = await sealedLocalRun();
    try {
      await rm(join(removed.value.artifacts, ...removed.store.relativePathForDigest(removed.transition.requiredEvidenceBindings[0]!.digest).split("/")));
      expect((await harnessStatus(removed.value.artifacts, removed.run.runId)).status).toBe("BLOCKED");
    } finally { await rm(removed.value.root, { recursive: true, force: true }); }
    const changed = await sealedLocalRun();
    try {
      const bundle = JSON.parse((await changed.store.read(changed.transition.requiredEvidenceBindings[0]!.digest)).toString("utf8")) as { evidence: Array<{ artifact: { digest: string } }> };
      await writeFile(join(changed.value.artifacts, ...changed.store.relativePathForDigest(bundle.evidence[0]!.artifact.digest).split("/")), "tampered");
      expect((await harnessStatus(changed.value.artifacts, changed.run.runId)).status).toBe("BLOCKED");
    } finally { await rm(changed.value.root, { recursive: true, force: true }); }
  });

  it("keeps a sealed decision verified after a later FAIL report when sealed artifacts remain intact", async () => {
    const sealed = await sealedLocalRun();
    try {
      const evidenceBundle = { schemaVersion: SCHEMA_VERSION, artifactId: sealed.transition.requiredEvidenceBindings[0]!.artifactId, digest: sealed.transition.requiredEvidenceBindings[0]!.digest };
      await new VerificationReportLedger(sealed.store).append(sealed.run.runId, { schemaVersion: SCHEMA_VERSION, id: "report.later.fail", createdAt: "2026-08-01T12:00:01.000Z", gateId: "gate.local", verdict: "FAIL", evidenceBundle });
      expect((await harnessStatus(sealed.value.artifacts, sealed.run.runId)).status).toBe("VERIFIED");
    } finally { await rm(sealed.value.root, { recursive: true, force: true }); }
  });

  it("seals an external PASS on a later run-next without executing Codex again", async () => {
    const value = await fixture(); const calls = { count: 0 }; const run = request(value.head);
    try {
      await runNextHarness({ artifactRoot: value.artifacts, targetWorkspace: value.workspace, request: run, context: { now, createBackend: () => backend(calls) } });
      const file = join(value.root, "device.bin"); await writeFile(file, "opaque");
      const imported = await importHarnessEvidence({ artifactRoot: value.artifacts, runId: run.runId, gateId: "gate.device", file, capturedAt: timestamp });
      const store = new FilesystemArtifactStore({ rootDirectory: value.artifacts });
      const binding = { schemaVersion: SCHEMA_VERSION, artifactId: imported.evidenceBundleId, digest: imported.evidenceBundleDigest };
      await new VerificationReportLedger(store).append(run.runId, { schemaVersion: SCHEMA_VERSION, id: "report.device.external", createdAt: timestamp, gateId: "gate.device", verdict: "PASS", evidenceBundle: binding });
      expect((await runNextHarness({ artifactRoot: value.artifacts, targetWorkspace: value.workspace, request: run, context: { now, createBackend: () => backend(calls) } })).status).toBe("VERIFIED");
      expect(calls.count).toBe(1);
    } finally { await rm(value.root, { recursive: true, force: true }); }
  });

  it("allows only one concurrent owner for the same run", async () => {
    const value = await fixture(); const calls = { count: 0 }; const run = request(value.head, false);
    try {
      const results = await Promise.all(Array.from({ length: 2 }, () => runNextHarness({ artifactRoot: value.artifacts, targetWorkspace: value.workspace, request: run, context: { now, createBackend: () => backend(calls) } })));
      expect(calls.count).toBe(1);
      expect(results.every((entry) => entry.status === "VERIFIED" || entry.status === "BLOCKED")).toBe(true);
    } finally { await rm(value.root, { recursive: true, force: true }); }
  });

  it("rejects a different request bound to the same run id", async () => {
    const value = await fixture(); const calls = { count: 0 }; const first = request(value.head, false); const changed = { ...first, prompt: "A different prompt" };
    try {
      await runNextHarness({ artifactRoot: value.artifacts, targetWorkspace: value.workspace, request: first, context: { now, createBackend: () => backend(calls) } });
      await expect(runNextHarness({ artifactRoot: value.artifacts, targetWorkspace: value.workspace, request: changed, context: { now, createBackend: () => backend(calls) } })).rejects.toThrow("bound to a different request");
    } finally { await rm(value.root, { recursive: true, force: true }); }
  });

  it("uses only the imported external bundle named by the effective report", async () => {
    const value = await fixture(); const calls = { count: 0 }; const run = request(value.head);
    try {
      await runNextHarness({ artifactRoot: value.artifacts, targetWorkspace: value.workspace, request: run, context: { now, createBackend: () => backend(calls) } });
      const one = join(value.root, "one.bin"); const two = join(value.root, "two.bin"); await writeFile(one, "one"); await writeFile(two, "two");
      await importHarnessEvidence({ artifactRoot: value.artifacts, runId: run.runId, gateId: "gate.device", file: one, capturedAt: timestamp });
      const selected = await importHarnessEvidence({ artifactRoot: value.artifacts, runId: run.runId, gateId: "gate.device", file: two, capturedAt: "2026-08-01T12:00:01.000Z" });
      const store = new FilesystemArtifactStore({ rootDirectory: value.artifacts });
      const binding = { schemaVersion: SCHEMA_VERSION, artifactId: selected.evidenceBundleId, digest: selected.evidenceBundleDigest };
      await new VerificationReportLedger(store).append(run.runId, { schemaVersion: SCHEMA_VERSION, id: "report.device.selected", createdAt: "2026-08-01T12:00:02.000Z", gateId: "gate.device", verdict: "PASS", evidenceBundle: binding });
      expect((await runNextHarness({ artifactRoot: value.artifacts, targetWorkspace: value.workspace, request: run, context: { now, createBackend: () => backend(calls) } })).status).toBe("VERIFIED");
      await expect(importHarnessEvidence({ artifactRoot: value.artifacts, runId: run.runId, gateId: "gate.other", file: one, capturedAt: timestamp })).rejects.toThrow("required external");
      await expect(importHarnessEvidence({ artifactRoot: value.artifacts, runId: "run.other", gateId: "gate.device", file: one, capturedAt: timestamp })).rejects.toThrow("existing run");
    } finally { await rm(value.root, { recursive: true, force: true }); }
  });

  it("rejects symlinked in-repository artifacts and oversize evidence before reading it", async () => {
    const value = await fixture(); const calls = { count: 0 };
    try {
      const link = join(value.root, "workspace-link"); await symlink(value.workspace, link);
      await expect(runNextHarness({ artifactRoot: join(link, "artifacts"), targetWorkspace: value.workspace, request: request(value.head), context: { now, createBackend: () => backend(calls) } })).rejects.toThrow("outside the target repository");
      expect((await execute("git", ["status", "--porcelain"], { cwd: value.workspace })).stdout).toBe("");
      await runNextHarness({ artifactRoot: value.artifacts, targetWorkspace: value.workspace, request: request(value.head), context: { now, createBackend: () => backend(calls) } });
      const oversized = join(value.root, "oversized.bin"); await writeFile(oversized, ""); await truncate(oversized, 32 * 1024 * 1024 + 1);
      await expect(importHarnessEvidence({ artifactRoot: value.artifacts, runId: "run.device", gateId: "gate.device", file: oversized, capturedAt: timestamp })).rejects.toThrow("size limit");
    } finally { await rm(value.root, { recursive: true, force: true }); }
  });
});
