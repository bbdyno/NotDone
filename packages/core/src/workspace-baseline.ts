import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readlink, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import {
  SCHEMA_VERSION,
  assertWorkspaceBaseline,
  sha256Json,
  type VerifiedWorkspaceBaseline,
  type WorkspaceBaselineFile,
} from "@notdone/protocol";

const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT = 16 * 1024 * 1024;

export class WorkspaceBaselineError extends Error {}

function fail(message: string): never {
  throw new WorkspaceBaselineError(message);
}

async function git(cwd: string, args: string[], action: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8", maxBuffer: MAX_GIT_OUTPUT });
    return stdout;
  } catch {
    fail(`Git failed while ${action}.`);
  }
}

function safePath(root: string, path: string): string {
  const candidate = resolve(root, path);
  const fromRoot = relative(root, candidate);
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    fail("Git returned an unsafe workspace path.");
  }
  return candidate;
}

function digest(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function inventory(root: string): Promise<WorkspaceBaselineFile[]> {
  const output = await git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--"], "listing workspace files");
  const paths = [...new Set(output.split("\0").filter((path) => path.length > 0))].sort();
  const files: WorkspaceBaselineFile[] = [];
  for (const path of paths) {
    const candidate = safePath(root, path);
    let status;
    try {
      status = await lstat(candidate);
    } catch (error) {
      if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
      fail("A workspace path could not be inspected safely.");
    }
    if (status.isSymbolicLink()) {
      const target = await readlink(candidate);
      files.push({ path, kind: "symlink", digest: digest(target), size: Buffer.byteLength(target) });
      continue;
    }
    if (!status.isFile()) fail("Workspace baselines support only regular files and symbolic links.");
    const content = await readFile(candidate);
    files.push({ path, kind: "file", digest: digest(content), size: content.byteLength });
  }
  return files;
}

function expectedDigest(baseline: Pick<VerifiedWorkspaceBaseline, "baseRevision" | "files">): string {
  return sha256Json({ baseRevision: baseline.baseRevision, files: baseline.files });
}

export function assertWorkspaceBaselineIntegrity(baseline: VerifiedWorkspaceBaseline): void {
  assertWorkspaceBaseline(baseline);
  const paths = baseline.files.map((file) => file.path);
  if (new Set(paths).size !== paths.length || paths.some((path, index) => index > 0 && path <= paths[index - 1]!)) {
    fail("Workspace baseline paths must be unique and sorted.");
  }
  if (expectedDigest(baseline) !== baseline.workspaceDigest) fail("Workspace baseline digest is invalid.");
}

export async function captureWorkspaceBaseline({
  workspaceRoot,
  now = () => new Date(),
  predecessor,
}: {
  workspaceRoot: string;
  now?: () => Date;
  predecessor?: VerifiedWorkspaceBaseline["predecessor"];
}): Promise<VerifiedWorkspaceBaseline> {
  let root: string;
  try {
    root = await realpath(resolve(workspaceRoot));
  } catch {
    fail("The workspace is not available.");
  }
  const repositoryRoot = (await git(root, ["rev-parse", "--show-toplevel"], "resolving the repository root")).trim();
  if (repositoryRoot !== root) fail("The workspace must be the Git repository root.");
  const baseRevision = (await git(root, ["rev-parse", "--verify", "HEAD^{commit}"], "resolving HEAD")).trim();
  const files = await inventory(root);
  const workspaceDigest = expectedDigest({ baseRevision, files });
  const baseline: VerifiedWorkspaceBaseline = {
    schemaVersion: SCHEMA_VERSION,
    id: `baseline.workspace.${sha256Json({ workspaceDigest, ...(predecessor === undefined ? {} : { predecessor }) }).slice(0, 32)}`,
    createdAt: now().toISOString(),
    baseRevision,
    workspaceDigest,
    files,
    ...(predecessor === undefined ? {} : { predecessor }),
  };
  assertWorkspaceBaselineIntegrity(baseline);
  return baseline;
}

export function changedWorkspacePaths(left: VerifiedWorkspaceBaseline, right: VerifiedWorkspaceBaseline): string[] {
  assertWorkspaceBaselineIntegrity(left);
  assertWorkspaceBaselineIntegrity(right);
  if (left.baseRevision !== right.baseRevision) fail("Workspace baselines do not share the same Git revision.");
  const leftFiles = new Map(left.files.map((file) => [file.path, `${file.kind}:${file.digest}`]));
  const rightFiles = new Map(right.files.map((file) => [file.path, `${file.kind}:${file.digest}`]));
  return [...new Set([...leftFiles.keys(), ...rightFiles.keys()])]
    .filter((path) => leftFiles.get(path) !== rightFiles.get(path))
    .sort();
}

export async function inspectWorkspaceAgainstBaseline(
  workspaceRoot: string,
  baseline: VerifiedWorkspaceBaseline,
  now = () => new Date(),
): Promise<{ current: VerifiedWorkspaceBaseline; changedPaths: string[]; matches: boolean }> {
  assertWorkspaceBaselineIntegrity(baseline);
  const current = await captureWorkspaceBaseline({ workspaceRoot, now });
  const changedPaths = changedWorkspacePaths(baseline, current);
  return { current, changedPaths, matches: current.workspaceDigest === baseline.workspaceDigest };
}
