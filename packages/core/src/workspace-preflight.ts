import { execFile } from "node:child_process";
import { Buffer } from "node:buffer";
import { promisify } from "node:util";

import {
  SCHEMA_VERSION,
  canonicalizeJson,
  sha256Json,
  type Artifact,
  type JsonValue,
  type TaskContract,
  type VerifiedWorkspaceBaseline,
} from "@notdone/protocol";

import { assertValidContract } from "./semantic-validation.js";
import { inspectWorkspaceAgainstBaseline } from "./workspace-baseline.js";

const execFileAsync = promisify(execFile);
const TASK_SNAPSHOT_MEDIA_TYPE = "application/vnd.notdone.task-snapshot+json";

export type WorkspacePreflightErrorCode =
  | "missing-baseline"
  | "unfrozen-contract"
  | "not-a-repository"
  | "baseline-mismatch"
  | "dirty-worktree"
  | "git-error";

export class WorkspacePreflightError extends Error {
  readonly code: WorkspacePreflightErrorCode;

  constructor(code: WorkspacePreflightErrorCode, message: string) {
    super(message);
    this.name = "WorkspacePreflightError";
    this.code = code;
  }
}

export interface WorkspacePreflightOptions {
  workspaceRoot: string;
  contract: TaskContract;
  runId: string;
  now?: () => Date;
  workspaceBaseline?: VerifiedWorkspaceBaseline;
}

export interface TaskSnapshotMetadata extends Record<string, JsonValue> {
  readonly runId: string;
  readonly contractId: string;
  readonly contractJson: string;
  readonly contractDigest: string;
  readonly frozenAt: string;
  readonly requestedBaseRevision: string;
  readonly repositoryRoot: string;
  readonly repositoryHead: string;
  readonly snapshotJson: string;
  readonly snapshotDigest: string;
  readonly workspaceBaselineDigest?: string;
}

export type ImmutableTaskSnapshotArtifact = Readonly<
  Omit<Artifact, "metadata">
> & {
  readonly metadata: Readonly<TaskSnapshotMetadata>;
};

export interface WorkspacePreflightResult {
  readonly repository: Readonly<{
    root: string;
    head: string;
    dirty: boolean;
  }>;
  readonly taskSnapshot: ImmutableTaskSnapshotArtifact;
}

interface TaskSnapshotPayload {
  runId: string;
  contractId: string;
  contractJson: string;
  contractDigest: string;
  frozenAt: string;
  requestedBaseRevision: string;
  repositoryRoot: string;
  repositoryHead: string;
  createdAt: string;
  workspaceBaselineDigest?: string;
}

function gitError(action: string): WorkspacePreflightError {
  return new WorkspacePreflightError("git-error", `Git failed while ${action}.`);
}

async function assertGitExecutable(): Promise<void> {
  try {
    await execFileAsync("git", ["--version"], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    throw new WorkspacePreflightError(
      "git-error",
      "The Git executable could not be run.",
    );
  }
}

async function git(
  workspaceRoot: string,
  arguments_: string[],
  action: string,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", arguments_, {
      cwd: workspaceRoot,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (error) {
    throw gitError(action);
  }
}

async function resolveRepositoryRoot(workspaceRoot: string): Promise<string> {
  await assertGitExecutable();

  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
      cwd: workspaceRoot,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    const repositoryRoot = stdout.trim();
    if (repositoryRoot.length === 0) {
      throw new WorkspacePreflightError(
        "git-error",
        "Git returned an empty repository root.",
      );
    }
    return repositoryRoot;
  } catch (error) {
    if (error instanceof WorkspacePreflightError) {
      throw error;
    }
    throw new WorkspacePreflightError(
      "not-a-repository",
      "The workspace is not a Git repository.",
    );
  }
}

function createTaskSnapshot(
  contract: TaskContract,
  runId: string,
  repositoryRoot: string,
  repositoryHead: string,
  createdAt: string,
  workspaceBaseline?: VerifiedWorkspaceBaseline,
): ImmutableTaskSnapshotArtifact {
  const contractJson = canonicalizeJson(contract);
  const contractDigest = sha256Json(contract);
  const payload: TaskSnapshotPayload = {
    runId,
    contractId: contract.id,
    contractJson,
    contractDigest,
    frozenAt: contract.frozenAt as string,
    requestedBaseRevision: contract.baseRevision as string,
    repositoryRoot,
    repositoryHead,
    createdAt,
    ...(workspaceBaseline === undefined ? {} : { workspaceBaselineDigest: workspaceBaseline.workspaceDigest }),
  };
  const snapshotJson = canonicalizeJson(payload);
  const snapshotDigest = sha256Json(payload);
  const metadata = Object.freeze({
    runId,
    contractId: payload.contractId,
    contractJson,
    contractDigest,
    frozenAt: payload.frozenAt,
    requestedBaseRevision: payload.requestedBaseRevision,
    repositoryRoot,
    repositoryHead,
    snapshotJson,
    snapshotDigest,
    ...(workspaceBaseline === undefined ? {} : { workspaceBaselineDigest: workspaceBaseline.workspaceDigest }),
  } satisfies TaskSnapshotMetadata);

  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    id: `artifact.task-snapshot.${sha256Json({ runId, snapshotDigest })}`,
    createdAt,
    mediaType: TASK_SNAPSHOT_MEDIA_TYPE,
    size: Buffer.byteLength(snapshotJson),
    digest: snapshotDigest,
    metadata,
  });
}

export async function preflightWorkspace({
  workspaceRoot,
  contract,
  runId,
  now = () => new Date(),
  workspaceBaseline,
}: WorkspacePreflightOptions): Promise<WorkspacePreflightResult> {
  assertValidContract(contract);

  if (contract.frozenAt === undefined || contract.frozenAt.length === 0) {
    throw new WorkspacePreflightError(
      "unfrozen-contract",
      "The task contract must have a frozenAt timestamp before execution.",
    );
  }
  if (contract.baseRevision === undefined || contract.baseRevision.length === 0) {
    throw new WorkspacePreflightError(
      "missing-baseline",
      "The task contract must declare a baseRevision before execution.",
    );
  }

  const repositoryRoot = await resolveRepositoryRoot(workspaceRoot);
  const repositoryHead = await git(
    repositoryRoot,
    ["rev-parse", "--verify", "HEAD^{commit}"],
    "resolving the current HEAD",
  );
  const resolvedBaseline = await git(
    repositoryRoot,
    [
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${contract.baseRevision}^{commit}`,
    ],
    "resolving the requested baseline",
  );
  if (resolvedBaseline !== repositoryHead) {
    throw new WorkspacePreflightError(
      "baseline-mismatch",
      "The current repository HEAD does not match the task contract baseline.",
    );
  }

  const status = await git(repositoryRoot, ["status", "--porcelain=v1", "--untracked-files=all"], "checking worktree cleanliness");
  if (workspaceBaseline === undefined && status.length > 0) {
    throw new WorkspacePreflightError("dirty-worktree", "The repository has tracked or untracked worktree changes.");
  }
  if (workspaceBaseline !== undefined) {
    let inspection;
    try { inspection = await inspectWorkspaceAgainstBaseline(repositoryRoot, workspaceBaseline, now); }
    catch { throw new WorkspacePreflightError("baseline-mismatch", "The workspace does not match the supplied verified baseline."); }
    if (!inspection.matches || workspaceBaseline.baseRevision !== repositoryHead) {
      throw new WorkspacePreflightError("baseline-mismatch", "The workspace does not match the supplied verified baseline.");
    }
  }

  const createdAt = now().toISOString();
  const repository = Object.freeze({
    root: repositoryRoot,
    head: repositoryHead,
    dirty: status.length > 0,
  });
  const taskSnapshot = createTaskSnapshot(
    contract,
    runId,
    repositoryRoot,
    repositoryHead,
    createdAt,
    workspaceBaseline,
  );

  return Object.freeze({ repository, taskSnapshot });
}
