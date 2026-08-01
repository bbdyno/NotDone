import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  SCHEMA_VERSION,
  canonicalizeJson,
  sha256Json,
  type DigestArtifactReference,
  type ExecutionPlan,
  type VerificationReport,
} from "@notdone/protocol";

import { FilesystemArtifactStore } from "./artifact-store.js";
import { ExternalEvidenceImporter } from "./external-evidence-importer.js";
import { GateLockCoordinator } from "./gate-lock-coordinator.js";
import { ExecutionRuntime, type ExecutionBackend } from "./runtime.js";
import { VerificationReportLedger } from "./verification-report-ledger.js";

const timestamp = "2026-08-01T12:00:00.000Z";

async function fixture(): Promise<{ root: string; store: FilesystemArtifactStore; ledger: VerificationReportLedger }> {
  const root = await mkdtemp(join(tmpdir(), "notdone-report-ledger-"));
  const store = new FilesystemArtifactStore({ rootDirectory: root, now: () => new Date(timestamp) });
  return { root, store, ledger: new VerificationReportLedger(store) };
}

function report(id: string, gateId: string, verdict: VerificationReport["verdict"], createdAt = timestamp, evidenceBundle?: DigestArtifactReference): VerificationReport {
  return {
    schemaVersion: SCHEMA_VERSION,
    id,
    createdAt,
    gateId,
    verdict,
    ...(evidenceBundle === undefined ? {} : { evidenceBundle }),
  };
}

function plan(gates: ExecutionPlan["verificationGates"]): ExecutionPlan {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: "plan.lock",
    createdAt: timestamp,
    steps: [{ schemaVersion: SCHEMA_VERSION, id: "step.verify", capability: "verify", verificationGateIds: gates?.map((gate) => gate.id) }],
    policy: { schemaVersion: SCHEMA_VERSION, externalNetwork: "deny", loopback: "deny", allowedTools: [], approvalRequirement: "required" },
    verificationGates: gates,
  };
}

function binding(id: string, digest = "a".repeat(64)): DigestArtifactReference {
  return { schemaVersion: SCHEMA_VERSION, artifactId: id, digest };
}

async function admittedBundle(store: FilesystemArtifactStore, id: string): Promise<DigestArtifactReference> {
  const evidenceArtifact = await store.store({
    id: `artifact.${id}`,
    mediaType: "application/octet-stream",
    content: `evidence:${id}`,
    createdAt: timestamp,
  });
  const bundle = {
    schemaVersion: SCHEMA_VERSION,
    id,
    createdAt: timestamp,
    evidence: [{
      schemaVersion: SCHEMA_VERSION,
      id: `evidence.${id}`,
      observedAt: timestamp,
      artifact: { schemaVersion: SCHEMA_VERSION, artifactId: evidenceArtifact.id, digest: evidenceArtifact.digest },
    }],
  };
  const bundleArtifact = await store.store({
    id,
    mediaType: "application/vnd.notdone.evidence-bundle+json",
    content: canonicalizeJson(bundle),
    createdAt: timestamp,
  });
  return binding(id, bundleArtifact.digest);
}

async function importedExternalBundle(
  store: FilesystemArtifactStore,
  runId: string,
  gateId: string,
): Promise<DigestArtifactReference> {
  const imported = await new ExternalEvidenceImporter({ artifactStore: store }).import({
    runId,
    gateId,
    content: Buffer.from(`external:${runId}:${gateId}`),
    capturedAt: timestamp,
  });
  return imported.evidenceBundleReference as DigestArtifactReference;
}

function recordPath(store: FilesystemArtifactStore, root: string, collection: string, identity: string): string {
  return join(root, ...store.immutableRecordRelativePath(collection, identity).split("/"));
}

describe("VerificationReportLedger", () => {
  it("preserves FAIL then PASS history and selects the deterministic effective PASS", async () => {
    const { root, ledger, store } = await fixture();
    try {
      await ledger.append("run.history", report("report.fail", "gate.required", "FAIL", "2026-08-01T12:00:00.000Z"));
      await ledger.append("run.history", report("report.pass", "gate.required", "PASS", "2026-08-01T12:01:00.000Z"));
      const history = await new VerificationReportLedger(store).history("run.history");
      expect(history).toHaveLength(2);
      expect((await ledger.history("run.history", "gate.required")).map((entry) => entry.report.verdict)).toEqual(["FAIL", "PASS"]);
      expect((await ledger.effectiveReport("run.history", "gate.required"))?.report.verdict).toBe("PASS");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("selects a later FAIL even when a PASS already exists", async () => {
    const { root, ledger, store } = await fixture();
    try {
      await ledger.append("run.effective", report("report.pass", "gate.required", "PASS", "2026-08-01T12:00:00.000Z"));
      await ledger.append("run.effective", report("report.fail", "gate.required", "FAIL", "2026-08-01T12:01:00.000Z"));
      expect((await new VerificationReportLedger(store).effectiveReport("run.effective", "gate.required"))?.report.verdict).toBe("FAIL");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("uses report id as a stable tie-breaker when timestamps are equal", async () => {
    const { root, ledger } = await fixture();
    try {
      await ledger.append("run.tie", report("report.a", "gate.required", "FAIL"));
      await ledger.append("run.tie", report("report.z", "gate.required", "PASS"));
      expect((await ledger.effectiveReport("run.tie", "gate.required"))?.report.id).toBe("report.z");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("is idempotent for identical reports, rejects content conflicts, and loses no concurrent append", async () => {
    const { root, ledger } = await fixture();
    try {
      const same = report("report.same", "gate.required", "PASS");
      await Promise.all(Array.from({ length: 8 }, () => ledger.append("run.concurrent", same)));
      const conflicting = await Promise.allSettled([
        ledger.append("run.race", report("report.race", "gate.required", "PASS")),
        ledger.append("run.race", report("report.race", "gate.required", "FAIL")),
      ]);
      expect(conflicting.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
      expect(conflicting.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
      await expect(ledger.append("run.concurrent", report("report.same", "gate.required", "FAIL"))).rejects.toMatchObject({ code: "report-id-conflict" });
      await Promise.all(Array.from({ length: 12 }, (_, index) => ledger.append(
        "run.concurrent",
        report(`report.${index}`, "gate.required", "PASS", `2026-08-01T12:00:${String(index).padStart(2, "0")}.000Z`),
      )));
      expect(await ledger.history("run.concurrent", "gate.required")).toHaveLength(13);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("restores history and detects stored artifact and ledger-record tampering", async () => {
    const { root, ledger, store } = await fixture();
    try {
      const persisted = await ledger.append("run.integrity", report("report.pass", "gate.required", "PASS"));
      expect(await new VerificationReportLedger(store).history("run.integrity")).toHaveLength(1);
      await writeFile(join(root, ...store.relativePathForDigest(persisted.artifact.digest).split("/")), "tampered");
      await expect(new VerificationReportLedger(store).history("run.integrity")).rejects.toMatchObject({ code: "integrity-failed" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("rejects replacement, filename, and direct-byte changes to immutable ledger records", async () => {
    const { root, ledger, store } = await fixture();
    const collection = "notdone.verification-report-ledger.v1";
    try {
      await ledger.append("run.records", report("report.first", "gate.required", "PASS"));
      await ledger.append("run.records", report("report.second", "gate.required", "FAIL", "2026-08-01T12:01:00.000Z"));
      const first = recordPath(store, root, collection, sha256Json({ runId: "run.records", reportId: "report.first" }));
      const second = recordPath(store, root, collection, sha256Json({ runId: "run.records", reportId: "report.second" }));
      await writeFile(first, "changed");
      await expect(ledger.history("run.records")).rejects.toMatchObject({ code: "integrity-failed" });
      await rm(root, { recursive: true, force: true });

      const replacement = await fixture();
      await replacement.ledger.append("run.records", report("report.first", "gate.required", "PASS"));
      await replacement.ledger.append("run.records", report("report.second", "gate.required", "FAIL", "2026-08-01T12:01:00.000Z"));
      const replacementFirst = recordPath(replacement.store, replacement.root, collection, sha256Json({ runId: "run.records", reportId: "report.first" }));
      const replacementSecond = recordPath(replacement.store, replacement.root, collection, sha256Json({ runId: "run.records", reportId: "report.second" }));
      await writeFile(replacementFirst, await readFile(replacementSecond));
      await expect(replacement.ledger.history("run.records")).rejects.toMatchObject({ code: "integrity-failed" });
      await rm(replacement.root, { recursive: true, force: true });

      const renamed = await fixture();
      await renamed.ledger.append("run.records", report("report.first", "gate.required", "PASS"));
      const renamedFirst = recordPath(renamed.store, renamed.root, collection, sha256Json({ runId: "run.records", reportId: "report.first" }));
      await rename(renamedFirst, `${renamedFirst}.bad`);
      await expect(renamed.ledger.history("run.records")).rejects.toMatchObject({ code: "integrity-failed" });
      await rm(renamed.root, { recursive: true, force: true });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe("GateLockCoordinator", () => {
  it("keeps missing, failed, abstained, errored, and mismatched evidence gates locked", async () => {
    const { root, ledger, store } = await fixture();
    try {
      const gate = { schemaVersion: SCHEMA_VERSION, id: "gate.required", required: true } as const;
      const executionPlan = plan([gate]);
      const expected = await admittedBundle(store, "bundle.required");
      const coordinator = new GateLockCoordinator({ artifactStore: store, reportLedger: ledger });
      expect((await coordinator.unlock({ runId: "run.locked", plan: executionPlan, requiredEvidenceBundles: { [gate.id]: expected } })).state).toBe("LOCKED");
      for (const verdict of ["FAIL", "ABSTAIN", "ERROR"] as const) {
        await ledger.append(`run.${verdict}`, report(`report.${verdict}`, gate.id, verdict, timestamp, expected));
        expect((await coordinator.unlock({ runId: `run.${verdict}`, plan: executionPlan, requiredEvidenceBundles: { [gate.id]: expected } })).state).toBe("LOCKED");
      }
      await ledger.append("run.mismatch", report("report.mismatch", gate.id, "PASS", timestamp, binding("bundle.other")));
      expect((await coordinator.unlock({ runId: "run.mismatch", plan: executionPlan, requiredEvidenceBundles: { [gate.id]: expected } })).state).toBe("LOCKED");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("requires a real canonical evidence bundle and intact referenced evidence artifacts", async () => {
    const { root, ledger, store } = await fixture();
    try {
      const gate = { schemaVersion: SCHEMA_VERSION, id: "gate.required", required: true } as const;
      const executionPlan = plan([gate]);
      const coordinator = new GateLockCoordinator({ artifactStore: store, reportLedger: ledger });
      const fabricated = binding("bundle.fabricated");
      await ledger.append("run.fabricated", report("report.fabricated", gate.id, "PASS", timestamp, fabricated));
      expect((await coordinator.unlock({ runId: "run.fabricated", plan: executionPlan, requiredEvidenceBundles: { [gate.id]: fabricated } })).state).toBe("LOCKED");

      const nonBundle = await store.store({ id: "bundle.not-json", mediaType: "application/json", content: canonicalizeJson({ value: "not a bundle" }), createdAt: timestamp });
      const nonBundleReference = binding("bundle.not-json", nonBundle.digest);
      await ledger.append("run.not-json", report("report.not-json", gate.id, "PASS", timestamp, nonBundleReference));
      expect((await coordinator.unlock({ runId: "run.not-json", plan: executionPlan, requiredEvidenceBundles: { [gate.id]: nonBundleReference } })).state).toBe("LOCKED");

      const wrongIdArtifact = await store.store({ id: "bundle.wrong-artifact", mediaType: "application/json", content: canonicalizeJson({ schemaVersion: SCHEMA_VERSION, id: "bundle.different", createdAt: timestamp, evidence: [] }), createdAt: timestamp });
      const wrongId = binding("bundle.wrong", wrongIdArtifact.digest);
      await ledger.append("run.wrong-id", report("report.wrong-id", gate.id, "PASS", timestamp, wrongId));
      expect((await coordinator.unlock({ runId: "run.wrong-id", plan: executionPlan, requiredEvidenceBundles: { [gate.id]: wrongId } })).state).toBe("LOCKED");

      const emptyArtifact = await store.store({ id: "bundle.empty", mediaType: "application/json", content: canonicalizeJson({ schemaVersion: SCHEMA_VERSION, id: "bundle.empty", createdAt: timestamp, evidence: [] }), createdAt: timestamp });
      const emptyReference = binding("bundle.empty", emptyArtifact.digest);
      await ledger.append("run.empty", report("report.empty", gate.id, "PASS", timestamp, emptyReference));
      await expect(
        coordinator.unlock({ runId: "run.empty", plan: executionPlan, requiredEvidenceBundles: { [gate.id]: emptyReference } }),
      ).resolves.toMatchObject({ state: "LOCKED", reason: "evidence-integrity-failed" });

      const missingEvidence = await store.store({ id: "bundle.missing-evidence", mediaType: "application/json", content: canonicalizeJson({ schemaVersion: SCHEMA_VERSION, id: "bundle.missing-evidence", createdAt: timestamp, evidence: [{ schemaVersion: SCHEMA_VERSION, id: "evidence.missing", observedAt: timestamp, artifact: binding("artifact.missing") }] }), createdAt: timestamp });
      const missingEvidenceReference = binding("bundle.missing-evidence", missingEvidence.digest);
      await ledger.append("run.missing-evidence", report("report.missing-evidence", gate.id, "PASS", timestamp, missingEvidenceReference));
      expect((await coordinator.unlock({ runId: "run.missing-evidence", plan: executionPlan, requiredEvidenceBundles: { [gate.id]: missingEvidenceReference } })).state).toBe("LOCKED");

      const corruptEvidenceReference = await admittedBundle(store, "bundle.corrupt-evidence");
      const corruptBundle = JSON.parse((await store.read(corruptEvidenceReference.digest)).toString("utf8")) as { evidence: Array<{ artifact: { digest: string } }> };
      await writeFile(join(root, ...store.relativePathForDigest(corruptBundle.evidence[0]!.artifact.digest).split("/")), "corrupted evidence");
      await ledger.append("run.corrupt-evidence", report("report.corrupt-evidence", gate.id, "PASS", timestamp, corruptEvidenceReference));
      expect((await coordinator.unlock({ runId: "run.corrupt-evidence", plan: executionPlan, requiredEvidenceBundles: { [gate.id]: corruptEvidenceReference } })).state).toBe("LOCKED");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("keeps missing external evidence awaiting and seals a single durable immutable unlock", async () => {
    const { root, ledger, store } = await fixture();
    try {
      const automatic = { schemaVersion: SCHEMA_VERSION, id: "gate.automatic", required: true } as const;
      const external = { schemaVersion: SCHEMA_VERSION, id: "gate.external", required: true, evidenceRequirement: "external" } as const;
      const executionPlan = plan([automatic, external]);
      const automaticBinding = await admittedBundle(store, "bundle.automatic");
      const externalBinding = await importedExternalBundle(store, "run.sealed", external.id);
      const bindings = { [automatic.id]: automaticBinding, [external.id]: externalBinding };
      await ledger.append("run.sealed", report("report.automatic", automatic.id, "PASS", timestamp, automaticBinding));
      const coordinator = new GateLockCoordinator({ artifactStore: store, reportLedger: ledger });
      expect((await coordinator.unlock({ runId: "run.sealed", plan: executionPlan, requiredEvidenceBundles: bindings })).state).toBe("AWAITING_EVIDENCE");
      await ledger.append("run.sealed", report("report.external", external.id, "PASS", "2026-08-01T12:01:00.000Z", externalBinding));
      const [first, concurrent] = await Promise.all([
        coordinator.unlock({ runId: "run.sealed", plan: executionPlan, requiredEvidenceBundles: bindings, now: () => new Date("2026-08-01T12:02:00.000Z") }),
        new GateLockCoordinator({ artifactStore: store, reportLedger: new VerificationReportLedger(store) }).unlock({ runId: "run.sealed", plan: executionPlan, requiredEvidenceBundles: bindings, now: () => new Date("2026-08-01T12:02:00.000Z") }),
      ]);
      expect(first.transition?.digest).toBe(concurrent.transition?.digest);
      expect((await new GateLockCoordinator({ artifactStore: store, reportLedger: new VerificationReportLedger(store) }).unlock({ runId: "run.sealed", plan: executionPlan, requiredEvidenceBundles: bindings })).state).toBe("UNLOCKED");
      await ledger.append("run.sealed", report("report.after", automatic.id, "FAIL", "2026-08-01T12:03:00.000Z", automaticBinding));
      expect((await coordinator.unlock({ runId: "run.sealed", plan: executionPlan, requiredEvidenceBundles: bindings })).transition?.digest).toBe(first.transition?.digest);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("classifies absent external reports as awaiting before requiring a binding", async () => {
    const { root, ledger, store } = await fixture();
    try {
      const gate = { schemaVersion: SCHEMA_VERSION, id: "gate.external", required: true, evidenceRequirement: "external" } as const;
      const executionPlan = plan([gate]);
      const coordinator = new GateLockCoordinator({ artifactStore: store, reportLedger: ledger });
      expect(await coordinator.unlock({ runId: "run.external.missing", plan: executionPlan, requiredEvidenceBundles: {} })).toMatchObject({ state: "AWAITING_EVIDENCE" });
      await ledger.append("run.external.abstain", report("report.abstain", gate.id, "ABSTAIN"));
      expect(await coordinator.unlock({ runId: "run.external.abstain", plan: executionPlan, requiredEvidenceBundles: {} })).toMatchObject({ state: "AWAITING_EVIDENCE" });
      await ledger.append("run.external.pass", report("report.pass", gate.id, "PASS"));
      expect(await coordinator.unlock({ runId: "run.external.pass", plan: executionPlan, requiredEvidenceBundles: {} })).toMatchObject({ state: "LOCKED", reason: "missing-evidence-binding" });
      for (const verdict of ["FAIL", "ERROR"] as const) {
        await ledger.append(`run.external.${verdict}`, report(`report.${verdict}`, gate.id, verdict));
        expect(await coordinator.unlock({ runId: `run.external.${verdict}`, plan: executionPlan, requiredEvidenceBundles: {} })).toMatchObject({ state: "LOCKED" });
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("inspects gate state without sealing an unlock transition", async () => {
    const { root, ledger, store } = await fixture();
    try {
      const gate = { schemaVersion: SCHEMA_VERSION, id: "gate.required", required: true } as const;
      const executionPlan = plan([gate]);
      const evidence = await admittedBundle(store, "bundle.inspect");
      await ledger.append("run.inspect", report("report.inspect", gate.id, "PASS", timestamp, evidence));
      const coordinator = new GateLockCoordinator({ artifactStore: store, reportLedger: ledger });
      expect(await coordinator.inspect({ runId: "run.inspect", plan: executionPlan, requiredEvidenceBundles: { [gate.id]: evidence } })).toMatchObject({ state: "UNLOCKED", sealed: false });
      expect(await store.readImmutableRecords("notdone.gate-unlock-ledger.v1")).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("requires importer provenance for external evidence and binds it to the current run and gate", async () => {
    const { root, ledger, store } = await fixture();
    try {
      const gate = { schemaVersion: SCHEMA_VERSION, id: "gate.external", required: true, evidenceRequirement: "external" } as const;
      const executionPlan = plan([gate]);
      const coordinator = new GateLockCoordinator({ artifactStore: store, reportLedger: ledger });
      const baseline = await admittedBundle(store, "bundle.baseline");
      await ledger.append("run.external.baseline", report("report.baseline", gate.id, "PASS", timestamp, baseline));
      expect(await coordinator.unlock({ runId: "run.external.baseline", plan: executionPlan, requiredEvidenceBundles: { [gate.id]: baseline } })).toMatchObject({ state: "LOCKED", reason: "evidence-integrity-failed" });

      const otherRun = await importedExternalBundle(store, "run.other", gate.id);
      await ledger.append("run.external.other-run", report("report.other-run", gate.id, "PASS", timestamp, otherRun));
      expect(await coordinator.unlock({ runId: "run.external.other-run", plan: executionPlan, requiredEvidenceBundles: { [gate.id]: otherRun } })).toMatchObject({ state: "LOCKED", reason: "evidence-integrity-failed" });

      const otherGate = await importedExternalBundle(store, "run.external.other-gate", "gate.other");
      await ledger.append("run.external.other-gate", report("report.other-gate", gate.id, "PASS", timestamp, otherGate));
      expect(await coordinator.unlock({ runId: "run.external.other-gate", plan: executionPlan, requiredEvidenceBundles: { [gate.id]: otherGate } })).toMatchObject({ state: "LOCKED", reason: "evidence-integrity-failed" });

      const valid = await importedExternalBundle(store, "run.external.valid", gate.id);
      await ledger.append("run.external.valid", report("report.valid", gate.id, "PASS", timestamp, valid));
      expect(await coordinator.unlock({ runId: "run.external.valid", plan: executionPlan, requiredEvidenceBundles: { [gate.id]: valid } })).toMatchObject({ state: "UNLOCKED" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("rejects invalid plans before creating a transition and detects transition record tampering", async () => {
    const { root, ledger, store } = await fixture();
    const collection = "notdone.gate-unlock-ledger.v1";
    try {
      const coordinator = new GateLockCoordinator({ artifactStore: store, reportLedger: ledger });
      const valid = plan([{ schemaVersion: SCHEMA_VERSION, id: "gate.required", required: true }]);
      const invalidPlans = [
        { ...valid, steps: [] },
        { ...valid, createdAt: "not-a-timestamp" },
        { ...valid, schemaVersion: "2.0" },
        { ...valid, steps: [{ ...valid.steps[0]!, verificationGateIds: ["gate.unknown"] }] },
        { ...valid, verificationGates: [valid.verificationGates![0]!, valid.verificationGates![0]!] },
      ];
      for (const invalid of invalidPlans) {
        await expect(coordinator.unlock({ runId: "run.invalid", plan: invalid as ExecutionPlan, requiredEvidenceBundles: {} })).rejects.toMatchObject({ code: "invalid-input" });
      }
      expect(await store.readImmutableRecords(collection)).toEqual([]);

      const gate = { schemaVersion: SCHEMA_VERSION, id: "gate.required", required: true } as const;
      const evidence = await admittedBundle(store, "bundle.transition");
      const executionPlan = plan([gate]);
      await ledger.append("run.transition", report("report.transition", gate.id, "PASS", timestamp, evidence));
      expect((await coordinator.unlock({ runId: "run.transition", plan: executionPlan, requiredEvidenceBundles: { [gate.id]: evidence } })).state).toBe("UNLOCKED");
      const path = recordPath(store, root, collection, sha256Json({ runId: "run.transition", planId: executionPlan.id, gateId: "gate.required-verification" }));
      await writeFile(path, "changed");
      await expect(coordinator.unlock({ runId: "run.transition", plan: executionPlan, requiredEvidenceBundles: { [gate.id]: evidence } })).rejects.toMatchObject({ code: "integrity-failed" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe("ExecutionRuntime durable report integration", () => {
  it("persists backend reports and only returns success with the sealed unlock", async () => {
    const { root, ledger, store } = await fixture();
    try {
      const gate = { schemaVersion: SCHEMA_VERSION, id: "gate.required", required: true } as const;
      const expected = await admittedBundle(store, "bundle.required");
      const executionPlan = plan([gate]);
      const backend: ExecutionBackend = {
        manifest: { backendId: "test", capabilities: ["verify"] },
        execute: async () => ({ verificationReports: [report("report.runtime", gate.id, "PASS", timestamp, expected)] }),
      };
      const result = await new ExecutionRuntime([backend]).execute(executionPlan, {
        runId: "run.runtime-ledger",
        requiredEvidenceBundles: { [gate.id]: expected },
        reportLedger: ledger,
        gateCoordinator: new GateLockCoordinator({ artifactStore: store, reportLedger: ledger }),
      });
      expect(result.run.status).toBe("succeeded");
      expect(result.gateUnlockTransition?.effectiveReports).toHaveLength(1);
      expect(await ledger.history("run.runtime-ledger")).toHaveLength(1);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
