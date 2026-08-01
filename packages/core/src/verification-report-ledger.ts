import {
  SCHEMA_VERSION,
  canonicalizeJson,
  sha256Json,
  type Artifact,
  type ArtifactReference,
  type VerificationReport,
} from "@notdone/protocol";

import {
  ArtifactStoreError,
  type FilesystemArtifactStore,
} from "./artifact-store.js";

const COLLECTION = "notdone.verification-report-ledger.v1";
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;

export type VerificationReportLedgerErrorCode =
  | "invalid-report"
  | "report-id-conflict"
  | "persistence-failed"
  | "integrity-failed";

/** Sanitized ledger failures never include report reasons or evidence content. */
export class VerificationReportLedgerError extends Error {
  readonly code: VerificationReportLedgerErrorCode;

  constructor(code: VerificationReportLedgerErrorCode, message: string) {
    super(message);
    this.name = "VerificationReportLedgerError";
    this.code = code;
  }
}

export interface PersistedVerificationReport {
  runId: string;
  report: VerificationReport;
  artifact: ArtifactReference & { digest: string };
}

interface StoredReport {
  schemaVersion: typeof SCHEMA_VERSION;
  runId: string;
  report: VerificationReport;
}

interface LedgerRecord {
  schemaVersion: typeof SCHEMA_VERSION;
  runId: string;
  reportId: string;
  artifact: ArtifactReference & { digest: string };
}

function fail(code: VerificationReportLedgerErrorCode, message: string): never {
  throw new VerificationReportLedgerError(code, message);
}

function validTimestamp(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.exec(value);
  if (match === null || Number.isNaN(Date.parse(value))) {
    return false;
  }
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day!, hour!, minute!, second!));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month! - 1 && date.getUTCDate() === day && date.getUTCHours() === hour && date.getUTCMinutes() === minute && date.getUTCSeconds() === second;
}

function assertReport(runId: string, report: VerificationReport): void {
  if (runId.length === 0 || report.id.length === 0 || report.gateId.length === 0 || !validTimestamp(report.createdAt)) {
    fail("invalid-report", "Verification report identity or timestamp is invalid.");
  }
  if (!(["PASS", "FAIL", "ABSTAIN", "ERROR"] as const).includes(report.verdict)) {
    fail("invalid-report", "Verification report verdict is invalid.");
  }
  const evidence = report.evidenceBundle;
  if (evidence !== undefined && (evidence.artifactId.length === 0 || (evidence.digest !== undefined && !DIGEST_PATTERN.test(evidence.digest)))) {
    fail("invalid-report", "Verification report evidence binding is invalid.");
  }
  try {
    canonicalizeJson(report);
  } catch {
    fail("invalid-report", "Verification report must be JSON-compatible.");
  }
}

function reference(artifact: Artifact): ArtifactReference & { digest: string } {
  return { schemaVersion: SCHEMA_VERSION, artifactId: artifact.id, digest: artifact.digest };
}

function compareReports(left: PersistedVerificationReport, right: PersistedVerificationReport): number {
  const time = Date.parse(left.report.createdAt) - Date.parse(right.report.createdAt);
  if (time !== 0) return time;
  if (left.report.id !== right.report.id) return left.report.id < right.report.id ? -1 : 1;
  return left.artifact.digest === right.artifact.digest ? 0 : left.artifact.digest < right.artifact.digest ? -1 : 1;
}

/** Durable, append-only report history backed by content-addressed artifacts. */
export class VerificationReportLedger {
  readonly #artifactStore: FilesystemArtifactStore;

  constructor(artifactStore: FilesystemArtifactStore) {
    this.#artifactStore = artifactStore;
  }

  async append(runId: string, report: VerificationReport): Promise<PersistedVerificationReport> {
    assertReport(runId, report);
    const stored: StoredReport = { schemaVersion: SCHEMA_VERSION, runId, report };
    const content = canonicalizeJson(stored);
    const identity = sha256Json({ runId, reportId: report.id });
    let artifact: Artifact;
    try {
      artifact = await this.#artifactStore.store({
        id: `verification-report.${sha256Json(stored).slice(0, 32)}`,
        mediaType: "application/vnd.notdone.verification-report+json",
        content,
        createdAt: report.createdAt,
        metadata: { runId, gateId: report.gateId, reportId: report.id },
      });
      const record: LedgerRecord = {
        schemaVersion: SCHEMA_VERSION,
        runId,
        reportId: report.id,
        artifact: reference(artifact),
      };
      await this.#artifactStore.storeImmutableRecord({
        collection: COLLECTION,
        identity,
        content: canonicalizeJson(record),
      });
    } catch (error) {
      if (error instanceof ArtifactStoreError && error.code === "immutable-record-conflict") {
        fail("report-id-conflict", "Verification report id is already bound to different content.");
      }
      fail("persistence-failed", "Verification report could not be persisted.");
    }
    return { runId, report, artifact: reference(artifact) };
  }

  async history(runId: string, gateId?: string): Promise<PersistedVerificationReport[]> {
    if (runId.length === 0 || (gateId !== undefined && gateId.length === 0)) {
      fail("invalid-report", "Verification report lookup identity is invalid.");
    }
    let records: Awaited<ReturnType<FilesystemArtifactStore["readImmutableRecords"]>>;
    try {
      records = await this.#artifactStore.readImmutableRecords(COLLECTION);
    } catch {
      fail("integrity-failed", "Verification report history could not be read.");
    }
    const reports: PersistedVerificationReport[] = [];
    for (const entry of records) {
      let record: LedgerRecord;
      try {
        const text = entry.content.toString("utf8");
        record = JSON.parse(text) as LedgerRecord;
        if (text !== canonicalizeJson(record) || entry.identity !== sha256Json({ runId: record.runId, reportId: record.reportId }) || record.schemaVersion !== SCHEMA_VERSION || record.runId.length === 0 || record.reportId.length === 0 || !DIGEST_PATTERN.test(record.artifact.digest) || record.artifact.artifactId.length === 0) {
          fail("integrity-failed", "Verification report history entry is invalid.");
        }
      } catch (error) {
        if (error instanceof VerificationReportLedgerError) throw error;
        fail("integrity-failed", "Verification report history entry is invalid.");
      }
      if (record.runId !== runId) continue;
      let content: Buffer;
      try {
        content = await this.#artifactStore.read(record.artifact.digest);
      } catch {
        fail("integrity-failed", "Verification report artifact failed integrity verification.");
      }
      try {
        const text = content.toString("utf8");
        const stored = JSON.parse(text) as StoredReport;
        if (text !== canonicalizeJson(stored) || stored.schemaVersion !== SCHEMA_VERSION || stored.runId !== record.runId || stored.report.id !== record.reportId) {
          fail("integrity-failed", "Verification report artifact does not match its history entry.");
        }
        assertReport(stored.runId, stored.report);
        if (gateId === undefined || stored.report.gateId === gateId) {
          reports.push({ runId: stored.runId, report: stored.report, artifact: record.artifact });
        }
      } catch (error) {
        if (error instanceof VerificationReportLedgerError && error.code !== "invalid-report") throw error;
        fail("integrity-failed", "Verification report artifact is invalid.");
      }
    }
    return reports.sort(compareReports);
  }

  async effectiveReport(runId: string, gateId: string): Promise<PersistedVerificationReport | undefined> {
    const history = await this.history(runId, gateId);
    return history.at(-1);
  }
}
