import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import {
  SCHEMA_VERSION,
  canonicalizeJson,
  sha256Json,
  type Artifact,
  type ArtifactReference,
  type Evidence,
  type EvidenceBundle,
  type VerifiedWorkspaceBaseline,
} from "@notdone/protocol";

import type { StoreArtifactOptions } from "./artifact-store.js";
import type { WorkspacePreflightResult } from "./workspace-preflight.js";
import { captureWorkspaceBaseline, changedWorkspacePaths } from "./workspace-baseline.js";

const execFileAsync = promisify(execFile);
const BASELINE_SHA_PATTERN = /^[a-f0-9]{40,64}$/u;
const BASELINE_DIFF_MEDIA_TYPE = "application/vnd.notdone.baseline-diff+json";
const BASELINE_DIFF_BUNDLE_MEDIA_TYPE =
  "application/vnd.notdone.baseline-diff-evidence-bundle+json";

export type BaselineDiffEvidenceErrorCode =
  | "invalid-preflight"
  | "invalid-baseline"
  | "workspace-mismatch"
  | "git-error"
  | "unsafe-untracked-path"
  | "artifact-store-failed";

/** A sanitized failure: workspace contents and Git output are never exposed. */
export class BaselineDiffEvidenceError extends Error {
  readonly code: BaselineDiffEvidenceErrorCode;

  constructor(code: BaselineDiffEvidenceErrorCode, message: string) {
    super(message);
    this.name = "BaselineDiffEvidenceError";
    this.code = code;
  }
}

/** The narrow append-only persistence surface needed by baseline evidence. */
export interface BaselineDiffArtifactStore {
  store(options: StoreArtifactOptions): Promise<Artifact>;
}

export interface CollectBaselineDiffEvidenceOptions {
  preflight: WorkspacePreflightResult;
  artifactStore: BaselineDiffArtifactStore;
  now?: () => Date;
  workspaceBaseline?: VerifiedWorkspaceBaseline;
}

export interface BaselineDiffEvidence {
  readonly artifact: Artifact;
  readonly bundleArtifact: Artifact;
  readonly evidenceBundle: EvidenceBundle;
  readonly evidenceBundleReference: ArtifactReference;
}

interface BaselineDiffPayload {
  baselineSha: string;
  trackedDiff?: string;
  untrackedFiles?: Array<{ path: string; contentBase64: string }>;
  predecessorWorkspaceDigest?: string;
  currentWorkspaceDigest?: string;
  changedPaths?: string[];
  outputFiles?: Array<{ path: string; kind: "file" | "symlink"; digest: string; size: number }>;
}

function artifactReference(artifact: Artifact): ArtifactReference {
  return {
    schemaVersion: SCHEMA_VERSION,
    artifactId: artifact.id,
    digest: artifact.digest,
  };
}

function artifactId(prefix: string, runId: string, baselineIdentity: string): string {
  return `${prefix}.${sha256Json({ runId, baselineIdentity }).slice(0, 32)}`;
}

function fail(
  code: BaselineDiffEvidenceErrorCode,
  message: string,
): BaselineDiffEvidenceError {
  return new BaselineDiffEvidenceError(code, message);
}

async function git(
  cwd: string,
  args: string[],
  action: string,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout;
  } catch {
    throw fail("git-error", `Git failed while ${action}.`);
  }
}

function insideWorkspace(root: string, path: string): string {
  const candidate = isAbsolute(path) ? resolve(path) : resolve(root, path);
  const fromRoot = relative(root, candidate);
  if (
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot)
  ) {
    throw fail("unsafe-untracked-path", "Git returned an unsafe untracked path.");
  }
  return candidate;
}

async function untrackedFiles(root: string): Promise<NonNullable<BaselineDiffPayload["untrackedFiles"]>> {
  const output = await git(
    root,
    ["ls-files", "--others", "--exclude-standard", "-z", "--"],
    "listing untracked files",
  );
  const paths = output.split("\0").filter((path) => path.length > 0).sort();
  const files: NonNullable<BaselineDiffPayload["untrackedFiles"]> = [];

  for (const path of paths) {
    const candidate = insideWorkspace(root, path);
    let resolved: string;
    try {
      resolved = await realpath(candidate);
    } catch {
      throw fail("unsafe-untracked-path", "An untracked path could not be resolved safely.");
    }
    insideWorkspace(root, resolved);
    let status;
    try {
      status = await lstat(resolved);
    } catch {
      throw fail("unsafe-untracked-path", "An untracked path could not be inspected safely.");
    }
    if (!status.isFile()) {
      throw fail("unsafe-untracked-path", "Untracked evidence must be a regular file.");
    }
    let content: Buffer;
    try {
      content = await readFile(resolved);
    } catch {
      throw fail("unsafe-untracked-path", "An untracked file could not be read safely.");
    }
    files.push({ path, contentBase64: content.toString("base64") });
  }
  return files;
}

function preflightMetadata(preflight: WorkspacePreflightResult): {
  root: string;
  baselineSha: string;
  runId: string;
} {
  const metadata = preflight.taskSnapshot.metadata;
  const { repositoryRoot, repositoryHead, runId } = metadata;
  if (
    repositoryRoot !== preflight.repository.root ||
    repositoryHead !== preflight.repository.head ||
    runId.length === 0
  ) {
    throw fail("invalid-preflight", "The frozen workspace preflight is inconsistent.");
  }
  if (!BASELINE_SHA_PATTERN.test(repositoryHead)) {
    throw fail("invalid-baseline", "The frozen baseline is not a full Git object identifier.");
  }
  return { root: repositoryRoot, baselineSha: repositoryHead, runId };
}

/**
 * Captures all worktree changes against the immutable preflight baseline.
 * The content digest deliberately excludes run-specific timestamps; run and
 * baseline identity are preserved in append-only artifact metadata instead.
 */
export async function collectBaselineDiffEvidence({
  preflight,
  artifactStore,
  now = () => new Date(),
  workspaceBaseline,
}: CollectBaselineDiffEvidenceOptions): Promise<BaselineDiffEvidence> {
  const { root: preflightRoot, baselineSha, runId } = preflightMetadata(preflight);
  let root: string;
  try {
    root = await realpath(preflightRoot);
  } catch {
    throw fail("workspace-mismatch", "The preflight workspace is no longer available.");
  }
  if (root !== preflightRoot) {
    throw fail("workspace-mismatch", "The preflight workspace root has changed.");
  }

  const gitRoot = (await git(root, ["rev-parse", "--show-toplevel"], "resolving the repository root")).trim();
  if (gitRoot !== root) {
    throw fail("workspace-mismatch", "The preflight workspace is not the repository root.");
  }
  const resolvedBaseline = (await git(
    root,
    ["rev-parse", "--verify", "--end-of-options", `${baselineSha}^{commit}`],
    "resolving the frozen baseline",
  )).trim();
  if (resolvedBaseline !== baselineSha) {
    throw fail("invalid-baseline", "The frozen baseline no longer resolves to the expected commit.");
  }

  let payload: BaselineDiffPayload;
  let trackedDiffDigest: string;
  let untrackedFileCount: number;
  let baselineIdentity = baselineSha;
  if (workspaceBaseline === undefined) {
    const [trackedDiff, untracked] = await Promise.all([
      git(root, ["diff", "--binary", "--full-index", "--no-ext-diff", "--no-renames", baselineSha, "--"], "collecting tracked workspace changes"),
      untrackedFiles(root),
    ]);
    payload = { baselineSha, trackedDiff, untrackedFiles: untracked };
    trackedDiffDigest = createHash("sha256").update(trackedDiff, "utf8").digest("hex");
    untrackedFileCount = untracked.length;
  } else {
    if (workspaceBaseline.baseRevision !== baselineSha) throw fail("invalid-baseline", "The verified workspace baseline does not match the frozen Git revision.");
    const current = await captureWorkspaceBaseline({ workspaceRoot: root, now });
    const changedPaths = changedWorkspacePaths(workspaceBaseline, current);
    const changed = new Set(changedPaths);
    payload = {
      baselineSha,
      predecessorWorkspaceDigest: workspaceBaseline.workspaceDigest,
      currentWorkspaceDigest: current.workspaceDigest,
      changedPaths,
      outputFiles: current.files.filter((file) => changed.has(file.path)),
    };
    trackedDiffDigest = sha256Json(changedPaths);
    untrackedFileCount = 0;
    baselineIdentity = workspaceBaseline.workspaceDigest;
  }
  const serializedPayload = canonicalizeJson(payload);
  const capturedAt = now().toISOString();
  let artifact: Artifact;
  try {
    artifact = await artifactStore.store({
      id: artifactId("artifact.baseline-diff", runId, baselineIdentity),
      mediaType: BASELINE_DIFF_MEDIA_TYPE,
      content: serializedPayload,
      createdAt: capturedAt,
      metadata: {
        runId,
        baselineSha,
        repositoryRoot: root,
        trackedDiffDigest,
        untrackedFileCount,
        ...(workspaceBaseline === undefined ? {} : { predecessorWorkspaceDigest: workspaceBaseline.workspaceDigest }),
      },
    });
  } catch {
    throw fail("artifact-store-failed", "Baseline diff evidence could not be stored.");
  }

  const evidence: Evidence = {
    schemaVersion: SCHEMA_VERSION,
    id: artifactId("evidence.baseline-diff", runId, baselineIdentity),
    observedAt: capturedAt,
    artifact: artifactReference(artifact),
    metadata: { runId, baselineSha },
  };
  const evidenceBundle: EvidenceBundle = {
    schemaVersion: SCHEMA_VERSION,
    id: artifactId("evidence-bundle.baseline-diff", runId, baselineIdentity),
    createdAt: capturedAt,
    evidence: [evidence],
  };
  let bundleArtifact: Artifact;
  try {
    bundleArtifact = await artifactStore.store({
      id: evidenceBundle.id,
      mediaType: BASELINE_DIFF_BUNDLE_MEDIA_TYPE,
      content: canonicalizeJson(evidenceBundle),
      createdAt: capturedAt,
      metadata: {
        runId,
        baselineSha,
        evidenceArtifactId: artifact.id,
        evidenceDigest: artifact.digest,
      },
    });
  } catch {
    throw fail("artifact-store-failed", "Baseline diff evidence bundle could not be stored.");
  }

  return {
    artifact,
    bundleArtifact,
    evidenceBundle,
    evidenceBundleReference: artifactReference(bundleArtifact),
  };
}

export const baselineDiffMediaTypes = Object.freeze({
  evidence: BASELINE_DIFF_MEDIA_TYPE,
  evidenceBundle: BASELINE_DIFF_BUNDLE_MEDIA_TYPE,
});
