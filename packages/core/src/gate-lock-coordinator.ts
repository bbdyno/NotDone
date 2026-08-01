import {
  SCHEMA_VERSION,
  assertExecutionPlan,
  canonicalizeJson,
  hasDigest,
  requiresExternalEvidence,
  sha256Json,
  verificationGateSatisfied,
  type DigestArtifactReference,
  type Evidence,
  type EvidenceBundle,
  type ExecutionPlan,
} from "@notdone/protocol";

import {
  ArtifactStoreError,
  type FilesystemArtifactStore,
} from "./artifact-store.js";
import {
  VerificationReportLedger,
  VerificationReportLedgerError,
  type PersistedVerificationReport,
} from "./verification-report-ledger.js";

const COLLECTION = "notdone.gate-unlock-ledger.v1";
const LOGICAL_GATE_ID = "gate.required-verification";
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;

export type GateLockState = "LOCKED" | "AWAITING_EVIDENCE" | "UNLOCKED";
export type GateLockErrorCode = "invalid-input" | "integrity-failed" | "persistence-failed" | "sealed-decision-conflict";

export class GateLockError extends Error {
  readonly code: GateLockErrorCode;
  constructor(code: GateLockErrorCode, message: string) {
    super(message);
    this.name = "GateLockError";
    this.code = code;
  }
}

export interface GateUnlockTransition {
  schemaVersion: typeof SCHEMA_VERSION;
  runId: string;
  planId: string;
  planDigest: string;
  gateId: typeof LOGICAL_GATE_ID;
  unlockedAt: string;
  effectiveReports: Array<{ gateId: string; artifactId: string; digest: string }>;
  requiredEvidenceBindings: Array<{ gateId: string; artifactId: string; digest: string }>;
  digest: string;
}

export interface GateLockResult {
  state: GateLockState;
  reason?: "missing-report" | "report-not-pass" | "missing-evidence-binding" | "evidence-integrity-failed" | "awaiting-external-evidence";
  transition?: GateUnlockTransition;
}

export interface UnlockGatesInput {
  runId: string;
  plan: ExecutionPlan;
  /** Every required gate must have an admitted, digest-bound expected bundle. */
  requiredEvidenceBundles: Readonly<Record<string, DigestArtifactReference>>;
  now?: () => Date;
}

function fail(code: GateLockErrorCode, message: string): never {
  throw new GateLockError(code, message);
}

function validTimestamp(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.exec(value);
  if (match === null || Number.isNaN(Date.parse(value))) return false;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day!, hour!, minute!, second!));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month! - 1 && date.getUTCDate() === day && date.getUTCHours() === hour && date.getUTCMinutes() === minute && date.getUTCSeconds() === second;
}

function transitionBase(transition: Omit<GateUnlockTransition, "digest">): Omit<GateUnlockTransition, "digest"> {
  return transition;
}

function isTransition(value: unknown): value is GateUnlockTransition {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Partial<GateUnlockTransition>;
  if (item.schemaVersion !== SCHEMA_VERSION || item.gateId !== LOGICAL_GATE_ID || typeof item.runId !== "string" || typeof item.planId !== "string" || !DIGEST_PATTERN.test(item.planDigest ?? "") || !validTimestamp(item.unlockedAt ?? "") || !Array.isArray(item.effectiveReports) || !Array.isArray(item.requiredEvidenceBindings) || !DIGEST_PATTERN.test(item.digest ?? "")) return false;
  const { digest, ...base } = item as GateUnlockTransition;
  return sha256Json(transitionBase(base)) === digest;
}

/** Seals a run's required verification decision; it has no boolean setter. */
export class GateLockCoordinator {
  readonly #artifactStore: FilesystemArtifactStore;
  readonly #reportLedger: VerificationReportLedger;

  constructor({ artifactStore, reportLedger }: { artifactStore: FilesystemArtifactStore; reportLedger: VerificationReportLedger }) {
    this.#artifactStore = artifactStore;
    this.#reportLedger = reportLedger;
  }

  async unlock(input: UnlockGatesInput): Promise<GateLockResult> {
    if (input.runId.length === 0) {
      fail("invalid-input", "Gate lock run and plan identity are required.");
    }
    try {
      assertExecutionPlan(input.plan);
    } catch {
      fail("invalid-input", "Gate lock execution plan is invalid.");
    }
    const planDigest = sha256Json(input.plan);
    const existing = await this.#existing(input.runId, input.plan.id);
    if (existing !== undefined) {
      if (existing.planDigest !== planDigest) {
        fail("sealed-decision-conflict", "A different plan is already sealed for this run.");
      }
      return { state: "UNLOCKED", transition: existing };
    }

    const required = (input.plan.verificationGates ?? []).filter((gate) => gate.required);
    const effectiveReports: Array<{ gateId: string; artifactId: string; digest: string }> = [];
    const bindings: Array<{ gateId: string; artifactId: string; digest: string }> = [];
    for (const gate of required) {
      let report: PersistedVerificationReport | undefined;
      try {
        report = await this.#reportLedger.effectiveReport(input.runId, gate.id);
      } catch (error) {
        if (error instanceof VerificationReportLedgerError) {
          fail("integrity-failed", "Persisted verification history failed validation.");
        }
        throw error;
      }
      if (report === undefined) {
        return { state: requiresExternalEvidence(gate) ? "AWAITING_EVIDENCE" : "LOCKED", reason: requiresExternalEvidence(gate) ? "awaiting-external-evidence" : "missing-report" };
      }
      if (requiresExternalEvidence(gate) && report.report.verdict === "ABSTAIN") {
        return { state: "AWAITING_EVIDENCE", reason: "awaiting-external-evidence" };
      }
      const expected = input.requiredEvidenceBundles[gate.id];
      if (expected === undefined || !hasDigest(expected) || expected.artifactId.length === 0 || !DIGEST_PATTERN.test(expected.digest)) {
        return { state: "LOCKED", reason: "missing-evidence-binding" };
      }
      if (!(await this.#verifyEvidenceBundle(expected, input.runId, gate.id, requiresExternalEvidence(gate)))) {
        return { state: "LOCKED", reason: "evidence-integrity-failed" };
      }
      if (!verificationGateSatisfied(gate, report.report, expected)) {
        return { state: "LOCKED", reason: "report-not-pass" };
      }
      effectiveReports.push({ gateId: gate.id, artifactId: report.artifact.artifactId, digest: report.artifact.digest });
      bindings.push({ gateId: gate.id, artifactId: expected.artifactId, digest: expected.digest });
    }
    const unlockedAt = (input.now ?? (() => new Date()))().toISOString();
    if (!validTimestamp(unlockedAt)) fail("invalid-input", "Gate unlock timestamp is invalid.");
    const base = {
      schemaVersion: SCHEMA_VERSION,
      runId: input.runId,
      planId: input.plan.id,
      planDigest,
      gateId: LOGICAL_GATE_ID,
      unlockedAt,
      effectiveReports: effectiveReports.sort((a, b) => a.gateId.localeCompare(b.gateId)),
      requiredEvidenceBindings: bindings.sort((a, b) => a.gateId.localeCompare(b.gateId)),
    } as const;
    const transition: GateUnlockTransition = { ...base, digest: sha256Json(transitionBase(base)) };
    try {
      await this.#artifactStore.storeImmutableRecord({
        collection: COLLECTION,
        identity: sha256Json({ runId: input.runId, planId: input.plan.id, gateId: LOGICAL_GATE_ID }),
        content: canonicalizeJson(transition),
      });
    } catch (error) {
      if (error instanceof ArtifactStoreError && error.code === "immutable-record-conflict") {
        const sealed = await this.#existing(input.runId, input.plan.id);
        if (sealed !== undefined) return { state: "UNLOCKED", transition: sealed };
      }
      fail("persistence-failed", "Gate unlock transition could not be persisted.");
    }
    return { state: "UNLOCKED", transition };
  }

  async #existing(runId: string, planId: string): Promise<GateUnlockTransition | undefined> {
    let records: Awaited<ReturnType<FilesystemArtifactStore["readImmutableRecords"]>>;
    try {
      records = await this.#artifactStore.readImmutableRecords(COLLECTION);
    } catch {
      fail("integrity-failed", "Gate unlock history could not be read.");
    }
    for (const entry of records) {
      try {
        const text = entry.content.toString("utf8");
        const transition = JSON.parse(text) as unknown;
        if (text !== canonicalizeJson(transition) || !isTransition(transition) || entry.identity !== sha256Json({ runId: transition.runId, planId: transition.planId, gateId: LOGICAL_GATE_ID })) {
          fail("integrity-failed", "Gate unlock history entry is invalid.");
        }
        if (transition.runId === runId && transition.planId === planId) return transition;
      } catch (error) {
        if (error instanceof GateLockError) throw error;
        fail("integrity-failed", "Gate unlock history entry is invalid.");
      }
    }
    return undefined;
  }

  /** Validates the admitted bundle and every referenced artifact without exposing evidence bytes. */
  async #verifyEvidenceBundle(
    expected: DigestArtifactReference,
    runId: string,
    gateId: string,
    requireExternalProvenance: boolean,
  ): Promise<boolean> {
    try {
      const text = (await this.#artifactStore.read(expected.digest)).toString("utf8");
      const bundle = JSON.parse(text) as EvidenceBundle;
      if (
        text !== canonicalizeJson(bundle) ||
        bundle.schemaVersion !== SCHEMA_VERSION ||
        bundle.id !== expected.artifactId ||
        !validTimestamp(bundle.createdAt) ||
        !Array.isArray(bundle.evidence) || bundle.evidence.length === 0
      ) {
        return false;
      }
      const evidenceIds = new Set<string>();
      for (const evidence of bundle.evidence) {
        if (!this.#validEvidence(evidence)) return false;
        if (evidenceIds.has(evidence.id)) return false;
        evidenceIds.add(evidence.id);
        if (requireExternalProvenance && !this.#validExternalEvidence(evidence, runId, gateId)) return false;
        await this.#artifactStore.read(evidence.artifact.digest!);
      }
      return true;
    } catch {
      return false;
    }
  }

  #validEvidence(evidence: Evidence): boolean {
    return (
      evidence.schemaVersion === SCHEMA_VERSION &&
      typeof evidence.id === "string" && evidence.id.length > 0 &&
      validTimestamp(evidence.observedAt) &&
      evidence.artifact.schemaVersion === SCHEMA_VERSION &&
      typeof evidence.artifact.artifactId === "string" && evidence.artifact.artifactId.length > 0 &&
      hasDigest(evidence.artifact) && DIGEST_PATTERN.test(evidence.artifact.digest)
    );
  }

  #validExternalEvidence(evidence: Evidence, runId: string, gateId: string): boolean {
    return (
      evidence.source?.kind === "external" &&
      evidence.producer?.runtime === "external" &&
      evidence.metadata?.runId === runId &&
      evidence.metadata.gateId === gateId
    );
  }
}
