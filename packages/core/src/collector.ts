import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import {
  isAbsolute,
  matchesGlob,
  relative,
  resolve,
  sep,
} from "node:path";
import { promisify } from "node:util";

import {
  SCHEMA_VERSION,
  sha256Json,
  type CommandCheck,
  type ContractClaim,
  type EvidenceRecord,
  type FileCheck,
  type GitDiffCheck,
  type JsonValue,
  type TaskContract,
} from "@notdone/protocol";

import { assertValidContract } from "./semantic-validation.js";

const execFileAsync = promisify(execFile);
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;

export interface CollectEvidenceOptions {
  contract: TaskContract;
  runId: string;
  workspaceRoot: string;
  now?: () => Date;
  maxOutputBytes?: number;
}

interface CommandOutcome {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
}

function digestText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function evidenceId(
  runId: string,
  claimId: string,
  checkId: string,
): string {
  return `evidence.${sha256Json([runId, claimId, checkId]).slice(0, 32)}`;
}

function resultReason(parts: Array<[boolean, string]>): string | undefined {
  const failures = parts
    .filter(([passed]) => !passed)
    .map(([, message]) => message);
  return failures.length === 0 ? undefined : failures.join(" ");
}

async function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  maxOutputBytes: number,
): Promise<CommandOutcome> {
  const startedAt = Date.now();

  return new Promise((resolveOutcome) => {
    const child = spawn(command, {
      cwd,
      env: {
        ...process.env,
        NO_COLOR: "1",
      },
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let truncated = false;
    let spawnError: Error | undefined;

    const capture = (
      chunks: Buffer[],
      currentBytes: number,
      chunk: Buffer,
    ): number => {
      const available = Math.max(0, maxOutputBytes - currentBytes);
      if (chunk.byteLength > available) {
        truncated = true;
      }
      if (available > 0) {
        chunks.push(chunk.subarray(0, available));
      }
      return currentBytes + Math.min(available, chunk.byteLength);
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes = capture(stdout, stdoutBytes, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes = capture(stderr, stderrBytes, chunk);
    });
    child.on("error", (error) => {
      spawnError = error;
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      const stderrText = Buffer.concat(stderr).toString("utf8");
      resolveOutcome({
        exitCode: code ?? -1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr:
          spawnError === undefined
            ? stderrText
            : `${stderrText}\n${spawnError.message}`.trim(),
        durationMs: Date.now() - startedAt,
        timedOut,
        truncated,
      });
    });
  });
}

async function collectCommandEvidence(
  claim: ContractClaim,
  check: CommandCheck,
  options: Required<
    Pick<CollectEvidenceOptions, "maxOutputBytes" | "now">
  > &
    Pick<CollectEvidenceOptions, "runId" | "workspaceRoot">,
): Promise<EvidenceRecord> {
  const cwd =
    check.cwd === undefined
      ? options.workspaceRoot
      : resolveWithinWorkspace(options.workspaceRoot, check.cwd, false);
  const outcome = await runCommand(
    check.command,
    cwd,
    check.timeoutMs ?? 60_000,
    options.maxOutputBytes,
  );
  const exitCodePassed =
    check.expect.exitCode === undefined ||
    outcome.exitCode === check.expect.exitCode;
  const stdoutPassed =
    check.expect.stdoutIncludes === undefined ||
    outcome.stdout.includes(check.expect.stdoutIncludes);
  const stderrPassed =
    check.expect.stderrIncludes === undefined ||
    outcome.stderr.includes(check.expect.stderrIncludes);
  const passed =
    !outcome.timedOut &&
    !outcome.truncated &&
    exitCodePassed &&
    stdoutPassed &&
    stderrPassed;
  const reason = resultReason([
    [!outcome.timedOut, "The command timed out."],
    [!outcome.truncated, "Command output exceeded the capture limit."],
    [exitCodePassed, `Unexpected exit code: ${outcome.exitCode}.`],
    [stdoutPassed, "Expected stdout text was not observed."],
    [stderrPassed, "Expected stderr text was not observed."],
  ]);
  const metadata: Record<string, JsonValue> = {
    passed,
    timedOut: outcome.timedOut,
    truncated: outcome.truncated,
  };
  if (reason !== undefined) {
    metadata.reason = reason;
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    id: evidenceId(options.runId, claim.id, check.id),
    runId: options.runId,
    claimIds: [claim.id],
    checkId: check.id,
    type: "command",
    trust: "executed",
    capturedAt: options.now().toISOString(),
    digest: sha256Json({
      command: check.command,
      cwd,
      exitCode: outcome.exitCode,
      stdoutDigest: digestText(outcome.stdout),
      stderrDigest: digestText(outcome.stderr),
    }),
    producer: {
      runtime: "notdone",
    },
    content: {
      mediaType: "application/vnd.notdone.command-result+json",
      size:
        Buffer.byteLength(outcome.stdout) + Buffer.byteLength(outcome.stderr),
    },
    command: {
      command: check.command,
      cwd,
      exitCode: outcome.exitCode,
      durationMs: outcome.durationMs,
      stdoutDigest: digestText(outcome.stdout),
      stderrDigest: digestText(outcome.stderr),
    },
    metadata,
  };
}

function resolveWithinWorkspace(
  workspaceRoot: string,
  requestedPath: string,
  allowMissing: boolean,
): string {
  const root = resolve(workspaceRoot);
  const candidate = isAbsolute(requestedPath)
    ? resolve(requestedPath)
    : resolve(root, requestedPath);
  const pathFromRoot = relative(root, candidate);

  if (
    pathFromRoot === ".." ||
    pathFromRoot.startsWith(`..${sep}`) ||
    isAbsolute(pathFromRoot)
  ) {
    throw new Error(`Path escapes the workspace: ${requestedPath}`);
  }

  if (!allowMissing && pathFromRoot.length === 0) {
    return root;
  }
  return candidate;
}

async function collectFileEvidence(
  claim: ContractClaim,
  check: FileCheck,
  options: Required<Pick<CollectEvidenceOptions, "now">> &
    Pick<CollectEvidenceOptions, "runId" | "workspaceRoot">,
): Promise<EvidenceRecord> {
  const absolutePath = resolveWithinWorkspace(
    options.workspaceRoot,
    check.path,
    true,
  );
  let exists = true;
  let contents: Buffer | undefined;
  let fileDigest: string | undefined;
  let size = 0;

  try {
    const resolvedRealPath = await realpath(absolutePath);
    resolveWithinWorkspace(options.workspaceRoot, resolvedRealPath, false);
    const fileStat = await stat(resolvedRealPath);
    if (!fileStat.isFile()) {
      throw new Error(`Path is not a regular file: ${check.path}`);
    }
    contents = await readFile(resolvedRealPath);
    size = contents.byteLength;
    fileDigest = createHash("sha256").update(contents).digest("hex");
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      exists = false;
    } else {
      throw error;
    }
  }

  const existsPassed =
    check.expect.exists === undefined || exists === check.expect.exists;
  const digestPassed =
    check.expect.sha256 === undefined || fileDigest === check.expect.sha256;
  const containsPassed =
    check.expect.contains === undefined ||
    contents?.toString("utf8").includes(check.expect.contains) === true;
  const passed = existsPassed && digestPassed && containsPassed;
  const reason = resultReason([
    [existsPassed, `File existence did not match: ${check.path}.`],
    [digestPassed, `File digest did not match: ${check.path}.`],
    [containsPassed, `Expected file content was not found: ${check.path}.`],
  ]);
  const metadata: Record<string, JsonValue> = {
    passed,
    checkPath: check.path,
    exists,
  };
  if (fileDigest !== undefined) {
    metadata.sha256 = fileDigest;
  }
  if (reason !== undefined) {
    metadata.reason = reason;
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    id: evidenceId(options.runId, claim.id, check.id),
    runId: options.runId,
    claimIds: [claim.id],
    checkId: check.id,
    type: "file",
    trust: "executed",
    capturedAt: options.now().toISOString(),
    digest:
      fileDigest ??
      sha256Json({
        path: check.path,
        exists: false,
      }),
    producer: {
      runtime: "notdone",
    },
    content: {
      mediaType: "application/octet-stream",
      size,
      path: check.path,
    },
    metadata,
  };
}

async function changedPaths(
  workspaceRoot: string,
  baseRevision: string | undefined,
): Promise<string[]> {
  const diffArguments = [
    "diff",
    "--name-only",
    "-z",
    ...(baseRevision === undefined ? ["HEAD"] : [baseRevision]),
    "--",
  ];
  const [{ stdout: diffOutput }, { stdout: untrackedOutput }] =
    await Promise.all([
      execFileAsync("git", diffArguments, {
        cwd: workspaceRoot,
        encoding: "utf8",
        maxBuffer: DEFAULT_MAX_OUTPUT_BYTES,
      }),
      execFileAsync(
        "git",
        ["ls-files", "--others", "--exclude-standard", "-z"],
        {
          cwd: workspaceRoot,
          encoding: "utf8",
          maxBuffer: DEFAULT_MAX_OUTPUT_BYTES,
        },
      ),
    ]);

  return [
    ...new Set(
      `${diffOutput}${untrackedOutput}`
        .split("\0")
        .filter((path) => path.length > 0),
    ),
  ].sort();
}

function matchesAny(path: string, patterns: string[] | undefined): boolean {
  return patterns?.some((pattern) => matchesGlob(path, pattern)) ?? false;
}

async function collectGitDiffEvidence(
  claim: ContractClaim,
  check: GitDiffCheck,
  contract: TaskContract,
  options: Required<Pick<CollectEvidenceOptions, "now">> &
    Pick<CollectEvidenceOptions, "runId" | "workspaceRoot">,
): Promise<EvidenceRecord> {
  const paths = await changedPaths(options.workspaceRoot, contract.baseRevision);
  const allowedPassed =
    check.allowedPaths === undefined ||
    paths.every((path) => matchesAny(path, check.allowedPaths));
  const requiredPassed =
    check.requiredPaths === undefined ||
    check.requiredPaths.every((pattern) =>
      paths.some((path) => matchesGlob(path, pattern)),
    );
  const forbiddenPassed =
    check.forbiddenPaths === undefined ||
    paths.every((path) => !matchesAny(path, check.forbiddenPaths));
  const passed = allowedPassed && requiredPassed && forbiddenPassed;
  const reason = resultReason([
    [allowedPassed, "Changed paths include files outside the allowed set."],
    [requiredPassed, "One or more required path patterns were not changed."],
    [forbiddenPassed, "A forbidden path was changed."],
  ]);
  const metadata: Record<string, JsonValue> = {
    passed,
    changedPaths: paths,
  };
  if (reason !== undefined) {
    metadata.reason = reason;
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    id: evidenceId(options.runId, claim.id, check.id),
    runId: options.runId,
    claimIds: [claim.id],
    checkId: check.id,
    type: "git-diff",
    trust: "executed",
    capturedAt: options.now().toISOString(),
    digest: sha256Json(paths),
    producer: {
      runtime: "notdone",
    },
    content: {
      mediaType: "application/vnd.notdone.changed-paths+json",
      size: Buffer.byteLength(JSON.stringify(paths)),
    },
    metadata,
  };
}

export async function collectEvidence({
  contract,
  runId,
  workspaceRoot,
  now = () => new Date(),
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
}: CollectEvidenceOptions): Promise<EvidenceRecord[]> {
  assertValidContract(contract);
  const evidence: EvidenceRecord[] = [];
  const sharedOptions = {
    runId,
    workspaceRoot: await realpath(resolve(workspaceRoot)),
    now,
  };

  for (const claim of contract.claims) {
    for (const check of claim.checks) {
      switch (check.type) {
        case "command":
          evidence.push(
            await collectCommandEvidence(claim, check, {
              ...sharedOptions,
              maxOutputBytes,
            }),
          );
          break;
        case "file":
          evidence.push(
            await collectFileEvidence(claim, check, sharedOptions),
          );
          break;
        case "git-diff":
          evidence.push(
            await collectGitDiffEvidence(
              claim,
              check,
              contract,
              sharedOptions,
            ),
          );
          break;
        case "manual":
          break;
      }
    }
  }

  return evidence;
}
