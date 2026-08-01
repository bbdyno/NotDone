import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SCHEMA_VERSION, type ExecutionPlan, type VerificationGate } from "@notdone/protocol";
import { afterEach, describe, expect, it } from "vitest";

import { FilesystemArtifactStore } from "./artifact-store.js";
import {
  ExternalEvidenceImporter,
  ExternalEvidenceImportError,
} from "./external-evidence-importer.js";
import { ExecutionRuntime, type ExecutionBackend } from "./runtime.js";

const roots: string[] = [];
const timestamp = "2026-08-01T12:00:00.000Z";
const laterTimestamp = "2026-08-02T12:00:00.000Z";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "notdone-external-evidence-"));
  roots.push(root);
  const store = new FilesystemArtifactStore({ rootDirectory: root, now: () => new Date(timestamp) });
  return { store, importer: new ExternalEvidenceImporter({ artifactStore: store, now: () => new Date(timestamp) }) };
}

function sha256(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function externalPlan(gate: VerificationGate): ExecutionPlan {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: "plan.external-evidence",
    createdAt: timestamp,
    steps: [{ schemaVersion: SCHEMA_VERSION, id: "step.verify", capability: "verify", verificationGateIds: [gate.id] }],
    verificationGates: [gate],
    policy: { schemaVersion: SCHEMA_VERSION, externalNetwork: "deny", loopback: "deny", allowedTools: [], approvalRequirement: "required" },
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ExternalEvidenceImporter", () => {
  it("stores opaque external bytes and an evidence bundle with the computed digest", async () => {
    const { store, importer } = await fixture();
    const content = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 255]);
    const imported = await importer.import({ runId: "run.device", gateId: "gate.device", content, mediaType: "application/zip", expectedDigest: sha256(content), capturedAt: timestamp });

    expect(imported.artifact.digest).toBe(sha256(content));
    expect(await store.read(imported.artifact.digest)).toEqual(content);
    expect(imported.evidenceBundle.evidence[0]).toMatchObject({ source: { kind: "external" }, producer: { runtime: "external" } });
    expect(imported.evidenceBundleReference).toMatchObject({ artifactId: imported.evidenceBundle.id, digest: imported.evidenceBundleArtifact.digest });
    expect(imported).not.toHaveProperty("verificationReports");
  });

  it("rejects digest mismatches and evidence exceeding its explicit size limit", async () => {
    const { store } = await fixture();
    const importer = new ExternalEvidenceImporter({ artifactStore: store, maxBytes: 3 });
    await expect(importer.import({ runId: "run.digest", gateId: "gate.digest", content: Buffer.from("yes"), expectedDigest: "a".repeat(64), capturedAt: timestamp })).rejects.toMatchObject({ code: "invalid-expected-digest" } satisfies Partial<ExternalEvidenceImportError>);
    await expect(importer.import({ runId: "run.large", gateId: "gate.large", content: Buffer.from("four"), capturedAt: timestamp })).rejects.toMatchObject({ code: "content-too-large" } satisfies Partial<ExternalEvidenceImportError>);
  });

  it("is stable across importer instances, import clocks, and concurrent imports", async () => {
    const { store } = await fixture();
    const input = { runId: "run.same", gateId: "gate.same", content: Buffer.from("first"), mediaType: "application/octet-stream", capturedAt: timestamp };
    const firstImporter = new ExternalEvidenceImporter({ artifactStore: store, now: () => new Date("2000-01-01T00:00:00.000Z") });
    const secondImporter = new ExternalEvidenceImporter({ artifactStore: store, now: () => new Date("2050-01-01T00:00:00.000Z") });
    const [first, concurrent] = await Promise.all([firstImporter.import(input), secondImporter.import(input)]);
    const fresh = await new ExternalEvidenceImporter({ artifactStore: store, now: () => new Date("2100-01-01T00:00:00.000Z") }).import(input);

    for (const result of [concurrent, fresh]) {
      expect(result.artifact.id).toBe(first.artifact.id);
      expect(result.artifact.digest).toBe(first.artifact.digest);
      expect(result.evidenceBundleArtifact.id).toBe(first.evidenceBundleArtifact.id);
      expect(result.evidenceBundleArtifact.digest).toBe(first.evidenceBundleArtifact.digest);
    }
    expect(await store.read(first.artifact.digest)).toEqual(Buffer.from("first"));
  });

  it("gives media type or capture-time conflicts separate append-only identities", async () => {
    const { importer } = await fixture();
    const common = { runId: "run.conflict", gateId: "gate.conflict", content: Buffer.from("same content"), capturedAt: timestamp };
    const first = await importer.import({ ...common, mediaType: "text/plain" });
    const differentMediaType = await importer.import({ ...common, mediaType: "application/octet-stream" });
    const differentCapturedAt = await importer.import({ ...common, capturedAt: laterTimestamp, mediaType: "text/plain" });

    expect(differentMediaType.artifact.id).not.toBe(first.artifact.id);
    expect(differentCapturedAt.artifact.id).not.toBe(first.artifact.id);
    expect(differentMediaType.evidenceBundleArtifact.digest).not.toBe(first.evidenceBundleArtifact.digest);
    expect(differentCapturedAt.evidenceBundleArtifact.digest).not.toBe(first.evidenceBundleArtifact.digest);
    await expect(importer.import({ ...common, capturedAt: "not-a-timestamp" })).rejects.toMatchObject({ code: "invalid-captured-at" } satisfies Partial<ExternalEvidenceImportError>);
  });

  it("returns a typed storage failure and can supply a per-gate evidence binding", async () => {
    const failing = new ExternalEvidenceImporter({ artifactStore: { store: async () => { throw new Error("storage unavailable"); } } });
    await expect(failing.import({ runId: "run.failure", gateId: "gate.failure", content: Buffer.from("evidence"), capturedAt: timestamp })).rejects.toMatchObject({ code: "artifact-store-failed" } satisfies Partial<ExternalEvidenceImportError>);

    const { importer } = await fixture();
    const imported = await importer.import({ runId: "run.binding", gateId: "gate.binding", content: Buffer.from("evidence"), capturedAt: timestamp });
    const gate: VerificationGate = { schemaVersion: SCHEMA_VERSION, id: "gate.binding", required: true, evidenceRequirement: "external" };
    const backend: ExecutionBackend = {
      manifest: { backendId: "binding-test", capabilities: ["verify"] },
      execute: async () => ({ verificationReports: [{ schemaVersion: SCHEMA_VERSION, id: "report.binding", createdAt: timestamp, gateId: gate.id, verdict: "PASS", evidenceBundle: imported.evidenceBundleReference }] }),
    };
    const result = await new ExecutionRuntime([backend]).execute(externalPlan(gate), { runId: "run.binding", requiredEvidenceBundles: { [gate.id]: imported.evidenceBundleReference } });
    expect(result.run.status).toBe("succeeded");
  });
});
