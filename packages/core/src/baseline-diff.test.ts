import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { SCHEMA_VERSION, type ExecutionPlan, type VerificationGate } from "@notdone/protocol";
import { afterEach, describe, expect, it } from "vitest";

import { FilesystemArtifactStore } from "./artifact-store.js";
import { BaselineDiffEvidenceError, collectBaselineDiffEvidence } from "./baseline-diff.js";
import { ExecutionRuntime, type ExecutionBackend } from "./runtime.js";
import { LocalVerifier, VerifyOnlyBackend } from "./verify-only.js";
import { preflightWorkspace, type WorkspacePreflightResult } from "./workspace-preflight.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const timestamp = "2026-08-01T12:00:00.000Z";

async function repository(): Promise<{ root: string; preflight: WorkspacePreflightResult }> {
  const root = await mkdtemp(join(tmpdir(), "notdone-baseline-diff-"));
  roots.push(root);
  await execFileAsync("git", ["init", "--quiet"], { cwd: root });
  await writeFile(join(root, "first.txt"), "first\n");
  await writeFile(join(root, "second.txt"), "second\n");
  await execFileAsync("git", ["add", "."], { cwd: root });
  await execFileAsync("git", ["-c", "user.name=NotDone", "-c", "user.email=notdone@example.invalid", "commit", "--quiet", "-m", "initial"], { cwd: root });
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  const preflight = await preflightWorkspace({
    workspaceRoot: root,
    runId: "run.baseline-diff",
    now: () => new Date(timestamp),
    contract: {
      schemaVersion: SCHEMA_VERSION, id: "task.baseline-diff", title: "Baseline diff", createdAt: timestamp, frozenAt: timestamp, mode: "explicit", baseRevision: stdout.trim(),
      claims: [{ id: "claim.baseline-diff", statement: "Collect the baseline diff.", required: true, checks: [{ id: "check.manual", type: "manual", prompt: "manual" }] }],
    },
  });
  return { root, preflight };
}

async function evidence(preflight: WorkspacePreflightResult) {
  const root = await mkdtemp(join(tmpdir(), "notdone-baseline-store-"));
  roots.push(root);
  const store = new FilesystemArtifactStore({ rootDirectory: root, now: () => new Date(timestamp) });
  return { store, result: await collectBaselineDiffEvidence({ preflight, artifactStore: store, now: () => new Date(timestamp) }) };
}

async function payload(store: FilesystemArtifactStore, digest: string) {
  return JSON.parse((await store.read(digest)).toString("utf8")) as { baselineSha: string; trackedDiff: string; untrackedFiles: Array<{ path: string; contentBase64: string }> };
}

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("baseline diff evidence", () => {
  it("captures tracked, staged, unstaged, and untracked workspace changes", async () => {
    const { root, preflight } = await repository();
    await writeFile(join(root, "first.txt"), "staged\n");
    await execFileAsync("git", ["add", "first.txt"], { cwd: root });
    await writeFile(join(root, "second.txt"), "unstaged\n");
    await writeFile(join(root, "untracked.txt"), "untracked\n");
    const { store, result } = await evidence(preflight);
    const captured = await payload(store, result.artifact.digest);

    expect(captured.baselineSha).toBe(preflight.repository.head);
    expect(captured.trackedDiff).toContain("first.txt");
    expect(captured.trackedDiff).toContain("second.txt");
    expect(captured.untrackedFiles).toEqual([{ path: "untracked.txt", contentBase64: Buffer.from("untracked\n").toString("base64") }]);
    expect(result.artifact.metadata).toMatchObject({ runId: "run.baseline-diff", baselineSha: preflight.repository.head, untrackedFileCount: 1 });
    expect(createHash("sha256").update(await store.read(result.artifact.digest)).digest("hex")).toBe(result.artifact.digest);
    expect(JSON.parse((await store.read(result.bundleArtifact.digest)).toString("utf8"))).toMatchObject({ evidence: [{ artifact: result.evidenceBundle.evidence[0]?.artifact }] });
  });

  it("records an empty, stable baseline diff when no files changed", async () => {
    const { preflight } = await repository();
    const first = await evidence(preflight);
    const second = await evidence(preflight);
    expect(await payload(first.store, first.result.artifact.digest)).toMatchObject({ trackedDiff: "", untrackedFiles: [] });
    expect(second.result.artifact.digest).toBe(first.result.artifact.digest);
  });

  it("rejects invalid baselines, Git failures, unsafe preflight roots, and storage failures without exposing content", async () => {
    const { root, preflight } = await repository();
    const invalid = { ...preflight, repository: { ...preflight.repository, head: "--dangerous" }, taskSnapshot: { ...preflight.taskSnapshot, metadata: { ...preflight.taskSnapshot.metadata, repositoryHead: "--dangerous" } } } as WorkspacePreflightResult;
    await expect(evidence(invalid)).rejects.toMatchObject({ code: "invalid-baseline" } satisfies Partial<BaselineDiffEvidenceError>);
    const outside = { ...preflight, repository: { ...preflight.repository, root: join(root, "..") }, taskSnapshot: { ...preflight.taskSnapshot, metadata: { ...preflight.taskSnapshot.metadata, repositoryRoot: join(root, "..") } } } as WorkspacePreflightResult;
    await expect(evidence(outside)).rejects.toMatchObject({ code: "workspace-mismatch" } satisfies Partial<BaselineDiffEvidenceError>);
    await writeFile(join(root, "secret.txt"), "private workspace document");
    await collectBaselineDiffEvidence({ preflight, artifactStore: { store: async () => { throw new Error("disk failure"); } } }).catch((error: unknown) => {
      expect(error).toMatchObject({ code: "artifact-store-failed" } satisfies Partial<BaselineDiffEvidenceError>);
      expect((error as Error).message).not.toContain("private workspace document");
    });
    await rm(join(root, ".git"), { recursive: true, force: true });
    await expect(evidence(preflight)).rejects.toMatchObject({ code: "git-error" } satisfies Partial<BaselineDiffEvidenceError>);
  });
});

function plan(gates: VerificationGate[]): ExecutionPlan {
  return { schemaVersion: SCHEMA_VERSION, id: "plan.baseline", createdAt: timestamp, steps: [{ schemaVersion: SCHEMA_VERSION, id: "verify", capability: "verify", verificationGateIds: gates.map((gate) => gate.id) }], verificationGates: gates, policy: { schemaVersion: SCHEMA_VERSION, externalNetwork: "deny", loopback: "deny", allowedTools: [], approvalRequirement: "required" } };
}
function reportBackend(gateId: string, verdict: "PASS" | "FAIL" | "ABSTAIN" | "ERROR", evidenceBundle?: { schemaVersion: typeof SCHEMA_VERSION; artifactId: string; digest?: string }): ExecutionBackend {
  return { manifest: { backendId: "report", capabilities: ["verify"] }, execute: async () => ({ verificationReports: [{ schemaVersion: SCHEMA_VERSION, id: `report.${gateId}`, createdAt: timestamp, gateId, verdict, ...(evidenceBundle === undefined ? {} : { evidenceBundle }) }] }) };
}

describe("required baseline-diff gate binding", () => {
  it("requires a PASS report bound to the exact stored evidence bundle", async () => {
    const { root, preflight } = await repository();
    const { result } = await evidence(preflight);
    const gate = { schemaVersion: SCHEMA_VERSION, id: "gate.required", required: true } as const;
    const runtime = new ExecutionRuntime([new VerifyOnlyBackend(new LocalVerifier(root), [{ gateId: gate.id, input: { type: "regex", value: "evidence", pattern: "evidence" } }], { evidenceBundle: result.evidenceBundleReference })]);
    const passed = await runtime.execute(plan([gate]), { runId: "run.gate", requiredEvidenceBundle: result.evidenceBundleReference });
    const missing = await new ExecutionRuntime([reportBackend(gate.id, "PASS")]).execute(plan([gate]), { runId: "run.missing", requiredEvidenceBundle: result.evidenceBundleReference });
    const mismatch = await new ExecutionRuntime([reportBackend(gate.id, "PASS", { ...result.evidenceBundleReference, digest: "0".repeat(64) })]).execute(plan([gate]), { runId: "run.mismatch", requiredEvidenceBundle: result.evidenceBundleReference });
    expect(passed.run.status).toBe("succeeded");
    expect(missing.failure?.code).toBe("required-gate-failed");
    expect(mismatch.failure?.code).toBe("required-gate-failed");
  });

  it("does not promote FAIL, ABSTAIN, ERROR, or artifact-store failure to PASS; optional gates remain compatible", async () => {
    const required = { schemaVersion: SCHEMA_VERSION, id: "gate.required", required: true } as const;
    for (const verdict of ["FAIL", "ABSTAIN", "ERROR"] as const) {
      const result = await new ExecutionRuntime([reportBackend(required.id, verdict)]).execute(plan([required]), { runId: `run.${verdict}` });
      expect(result.failure?.code).toBe("required-gate-failed");
    }
    const optional = { schemaVersion: SCHEMA_VERSION, id: "gate.optional", required: false } as const;
    const compatible = await new ExecutionRuntime([reportBackend(optional.id, "FAIL")]).execute(plan([optional]), { runId: "run.optional", requiredEvidenceBundle: { schemaVersion: SCHEMA_VERSION, artifactId: "artifact.required", digest: "a".repeat(64) } });
    expect(compatible.run.status).toBe("succeeded");
  });
});
