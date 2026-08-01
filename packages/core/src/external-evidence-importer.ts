import { createHash } from "node:crypto";

import {
  SCHEMA_VERSION,
  canonicalizeJson,
  sha256Json,
  type Artifact,
  type ArtifactReference,
  type Evidence,
  type EvidenceBundle,
  type JsonValue,
} from "@notdone/protocol";

import type { StoreArtifactOptions } from "./artifact-store.js";

const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const RAW_MEDIA_TYPE = "application/vnd.notdone.external-evidence+binary";
const BUNDLE_MEDIA_TYPE = "application/vnd.notdone.evidence-bundle+json";

export type ExternalEvidenceImportErrorCode =
  | "invalid-run-id"
  | "invalid-gate-id"
  | "invalid-content"
  | "invalid-expected-digest"
  | "invalid-captured-at"
  | "invalid-max-bytes"
  | "content-too-large"
  | "artifact-store-failed";

/** Sanitized importer failures never contain supplied content or filesystem paths. */
export class ExternalEvidenceImportError extends Error {
  readonly code: ExternalEvidenceImportErrorCode;

  constructor(code: ExternalEvidenceImportErrorCode, message: string) {
    super(message);
    this.name = "ExternalEvidenceImportError";
    this.code = code;
  }
}

/** The narrow append-only persistence surface used by the importer. */
export interface ExternalEvidenceArtifactStore {
  store(options: StoreArtifactOptions): Promise<Artifact>;
}

export interface ExternalEvidenceImporterOptions {
  artifactStore: ExternalEvidenceArtifactStore;
  /** @deprecated Evidence identity uses the required source-captured timestamp. */
  now?: () => Date;
  maxBytes?: number;
}

export interface ImportExternalEvidenceInput {
  runId: string;
  gateId: string;
  content: Uint8Array;
  /** Opaque bytes, including ZIP files, are never unpacked or parsed. */
  mediaType?: string;
  expectedDigest?: string;
  /** Stable timestamp supplied by the external evidence source. */
  capturedAt: string;
}

export interface ImportedExternalEvidence {
  artifact: Artifact;
  evidenceBundle: EvidenceBundle;
  evidenceBundleArtifact: Artifact;
  evidenceBundleReference: ArtifactReference;
}

function fail(code: ExternalEvidenceImportErrorCode, message: string): never {
  throw new ExternalEvidenceImportError(code, message);
}

function digest(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function reference(artifact: Artifact): ArtifactReference {
  return {
    schemaVersion: SCHEMA_VERSION,
    artifactId: artifact.id,
    digest: artifact.digest,
  };
}

function importIdentity(
  runId: string,
  gateId: string,
  contentDigest: string,
  mediaType: string,
  capturedAt: string,
): string {
  return sha256Json({ runId, gateId, contentDigest, mediaType, capturedAt }).slice(0, 32);
}

function isIsoTimestamp(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

/**
 * Imports provider-neutral external evidence as opaque bytes. It persists no
 * verification report; a verifier must later bind the returned bundle to its gate.
 */
export class ExternalEvidenceImporter {
  readonly #artifactStore: ExternalEvidenceArtifactStore;
  readonly #maxBytes: number;
  readonly #imports = new Map<string, ImportedExternalEvidence>();

  constructor({
    artifactStore,
    maxBytes = DEFAULT_MAX_BYTES,
  }: ExternalEvidenceImporterOptions) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
      fail("invalid-max-bytes", "External evidence size limit is invalid.");
    }
    this.#artifactStore = artifactStore;
    this.#maxBytes = maxBytes;
  }

  async import(input: ImportExternalEvidenceInput): Promise<ImportedExternalEvidence> {
    if (input.runId.length === 0) {
      fail("invalid-run-id", "External evidence run id must not be empty.");
    }
    if (input.gateId.length === 0) {
      fail("invalid-gate-id", "External evidence gate id must not be empty.");
    }
    if (!(input.content instanceof Uint8Array)) {
      fail("invalid-content", "External evidence content must be bytes.");
    }
    if (input.content.byteLength > this.#maxBytes) {
      fail("content-too-large", "External evidence exceeds the configured size limit.");
    }
    if (input.expectedDigest !== undefined && !DIGEST_PATTERN.test(input.expectedDigest)) {
      fail("invalid-expected-digest", "External evidence digest is invalid.");
    }
    if (!isIsoTimestamp(input.capturedAt)) {
      fail("invalid-captured-at", "External evidence captured timestamp is invalid.");
    }

    const contentDigest = digest(input.content);
    if (input.expectedDigest !== undefined && input.expectedDigest !== contentDigest) {
      fail("invalid-expected-digest", "External evidence digest does not match the supplied bytes.");
    }
    const mediaType = input.mediaType ?? RAW_MEDIA_TYPE;
    if (mediaType.length === 0) {
      fail("invalid-content", "External evidence media type must not be empty.");
    }
    const key = `${input.runId}\0${input.gateId}\0${contentDigest}\0${mediaType}\0${input.capturedAt}`;
    const existing = this.#imports.get(key);
    if (existing !== undefined) {
      return existing;
    }

    const identity = importIdentity(
      input.runId,
      input.gateId,
      contentDigest,
      mediaType,
      input.capturedAt,
    );
    const { capturedAt } = input;

    let artifact: Artifact;
    try {
      artifact = await this.#artifactStore.store({
        id: `artifact.external-evidence.${identity}`,
        mediaType,
        content: input.content,
        createdAt: capturedAt,
        metadata: {
          runId: input.runId,
          gateId: input.gateId,
          source: { kind: "external" },
          producer: { runtime: "external" },
        },
      });
    } catch {
      fail("artifact-store-failed", "External evidence could not be stored.");
    }

    const evidence: Evidence = {
      schemaVersion: SCHEMA_VERSION,
      id: `evidence.external-evidence.${identity}`,
      observedAt: capturedAt,
      artifact: reference(artifact),
      source: { kind: "external" },
      producer: { runtime: "external" },
      metadata: { runId: input.runId, gateId: input.gateId },
    };
    const evidenceBundle: EvidenceBundle = {
      schemaVersion: SCHEMA_VERSION,
      id: `evidence-bundle.external-evidence.${identity}`,
      createdAt: capturedAt,
      evidence: [evidence],
    };
    let evidenceBundleArtifact: Artifact;
    try {
      evidenceBundleArtifact = await this.#artifactStore.store({
        id: evidenceBundle.id,
        mediaType: BUNDLE_MEDIA_TYPE,
        content: canonicalizeJson(evidenceBundle),
        createdAt: capturedAt,
        metadata: {
          runId: input.runId,
          gateId: input.gateId,
          source: { kind: "external" },
          producer: { runtime: "external" },
          evidenceArtifactId: artifact.id,
          evidenceDigest: artifact.digest,
        } as Record<string, JsonValue>,
      });
    } catch {
      fail("artifact-store-failed", "External evidence bundle could not be stored.");
    }
    const imported = {
      artifact,
      evidenceBundle,
      evidenceBundleArtifact,
      evidenceBundleReference: reference(evidenceBundleArtifact),
    };
    this.#imports.set(key, imported);
    return imported;
  }
}

export const externalEvidenceMediaTypes = Object.freeze({
  raw: RAW_MEDIA_TYPE,
  bundle: BUNDLE_MEDIA_TYPE,
});
