#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  collectEvidence,
  verifyProofPacketIntegrity,
  verifyWorkspace,
  assertValidContract,
} from "@notdone/core";
import {
  assertProofPacket,
  type ProofPacket,
  type TaskContract,
  type VerificationStatus,
} from "@notdone/protocol";

import {
  errorMessage,
  readJsonFile,
  writeJsonFile,
} from "./files.js";
import { createContractTemplate } from "./template.js";

export const CLI_VERSION = "0.0.0";
export const DEFAULT_CONTRACT_PATH = ".notdone/contracts/notdone.json";

export const exitCodes = {
  success: 0,
  error: 1,
  unverified: 2,
  blocked: 3,
  failed: 4,
} as const;

export interface CliContext {
  cwd: string;
  now: () => Date;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

interface ParsedArguments {
  positional: string[];
  json: boolean;
  output?: string;
  runId?: string;
}

class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

const help = `NotDone — proof-of-completion for AI agents

Usage:
  notdone init [contract-path]
  notdone contract validate [contract-path] [--json]
  notdone evidence collect [contract-path] [--run-id ID] [--output PATH] [--json]
  notdone verify [contract-path] [--run-id ID] [--output PATH] [--json]
  notdone proof inspect <proof-path> [--json]
  notdone --version

Exit codes:
  0  verified or command succeeded
  1  invalid input or runtime error
  2  proof is unverified
  3  verification is blocked
  4  a required check failed`;

function defaultContext(): CliContext {
  return {
    cwd: process.cwd(),
    now: () => new Date(),
    stdout: (line) => {
      process.stdout.write(`${line}\n`);
    },
    stderr: (line) => {
      process.stderr.write(`${line}\n`);
    },
  };
}

function parseArguments(args: string[]): ParsedArguments {
  const positional: string[] = [];
  let json = false;
  let output: string | undefined;
  let runId: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--output" || argument === "--run-id") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new CliUsageError(`${argument} requires a value.`);
      }
      if (argument === "--output") {
        output = value;
      } else {
        runId = value;
      }
      index += 1;
      continue;
    }
    if (argument?.startsWith("--")) {
      throw new CliUsageError(`Unknown option: ${argument}`);
    }
    if (argument !== undefined) {
      positional.push(argument);
    }
  }

  return {
    positional,
    json,
    ...(output === undefined ? {} : { output }),
    ...(runId === undefined ? {} : { runId }),
  };
}

function absolutePath(cwd: string, path: string): string {
  return resolve(cwd, path);
}

function generatedRunId(now: Date): string {
  const timestamp = now.toISOString().replaceAll(/[^0-9]/g, "").slice(0, 17);
  return `run.${timestamp}.${randomUUID().slice(0, 8)}`;
}

function resultExitCode(status: VerificationStatus): number {
  switch (status) {
    case "verified":
      return exitCodes.success;
    case "unverified":
      return exitCodes.unverified;
    case "blocked":
      return exitCodes.blocked;
    case "failed":
      return exitCodes.failed;
  }
}

async function loadContract(
  cwd: string,
  path = DEFAULT_CONTRACT_PATH,
): Promise<{ contract: TaskContract; path: string }> {
  const resolvedPath = absolutePath(cwd, path);
  const value = await readJsonFile(resolvedPath);
  assertValidContract(value);
  return {
    contract: value,
    path: resolvedPath,
  };
}

function printJson(context: CliContext, value: unknown): void {
  context.stdout(JSON.stringify(value, null, 2));
}

async function initContract(
  args: string[],
  context: CliContext,
): Promise<number> {
  const parsed = parseArguments(args);
  if (parsed.positional.length > 1) {
    throw new CliUsageError("init accepts at most one contract path.");
  }
  const requestedPath = parsed.positional[0] ?? DEFAULT_CONTRACT_PATH;
  const path = absolutePath(context.cwd, requestedPath);

  try {
    await access(path);
    throw new Error(`Refusing to overwrite existing contract: ${path}`);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      await writeJsonFile(path, createContractTemplate(context.now()));
      context.stdout(`Created task contract: ${path}`);
      return exitCodes.success;
    }
    throw error;
  }
}

async function validateContractCommand(
  args: string[],
  context: CliContext,
): Promise<number> {
  const parsed = parseArguments(args);
  if (parsed.positional.length > 1) {
    throw new CliUsageError(
      "contract validate accepts at most one contract path.",
    );
  }
  const loaded = await loadContract(
    context.cwd,
    parsed.positional[0] ?? DEFAULT_CONTRACT_PATH,
  );
  const output = {
    valid: true,
    contractId: loaded.contract.id,
    path: loaded.path,
    claims: loaded.contract.claims.length,
    checks: loaded.contract.claims.reduce(
      (count, claim) => count + claim.checks.length,
      0,
    ),
  };

  if (parsed.json) {
    printJson(context, output);
  } else {
    context.stdout(
      `Valid contract ${output.contractId}: ${output.claims} claim(s), ${output.checks} check(s).`,
    );
  }
  return exitCodes.success;
}

async function collectEvidenceCommand(
  args: string[],
  context: CliContext,
): Promise<number> {
  const parsed = parseArguments(args);
  if (parsed.positional.length > 1) {
    throw new CliUsageError(
      "evidence collect accepts at most one contract path.",
    );
  }
  const { contract } = await loadContract(
    context.cwd,
    parsed.positional[0] ?? DEFAULT_CONTRACT_PATH,
  );
  const runId = parsed.runId ?? generatedRunId(context.now());
  const evidence = await collectEvidence({
    contract,
    runId,
    workspaceRoot: context.cwd,
    now: context.now,
  });
  const outputPath = absolutePath(
    context.cwd,
    parsed.output ?? `.notdone/runs/${runId}/evidence.json`,
  );
  await writeJsonFile(outputPath, evidence);

  if (parsed.json) {
    printJson(context, {
      runId,
      outputPath,
      evidence,
    });
  } else {
    context.stdout(
      `Collected ${evidence.length} evidence record(s): ${outputPath}`,
    );
  }
  return exitCodes.success;
}

async function verifyCommand(
  args: string[],
  context: CliContext,
): Promise<number> {
  const parsed = parseArguments(args);
  if (parsed.positional.length > 1) {
    throw new CliUsageError("verify accepts at most one contract path.");
  }
  const { contract } = await loadContract(
    context.cwd,
    parsed.positional[0] ?? DEFAULT_CONTRACT_PATH,
  );
  const runId = parsed.runId ?? generatedRunId(context.now());
  const evaluatedAt = context.now().toISOString();
  const packet = await verifyWorkspace({
    contract,
    runId,
    workspaceRoot: context.cwd,
    now: context.now,
    evaluatedAt,
  });
  const outputPath = absolutePath(
    context.cwd,
    parsed.output ?? `.notdone/proofs/${runId}.proof.json`,
  );
  await writeJsonFile(outputPath, packet);

  if (parsed.json) {
    printJson(context, {
      status: packet.result.status,
      runId,
      outputPath,
      proofGaps: packet.result.proofGaps ?? [],
    });
  } else {
    context.stdout(`Verification ${packet.result.status}: ${outputPath}`);
    for (const gap of packet.result.proofGaps ?? []) {
      context.stdout(`- ${gap}`);
    }
  }
  return resultExitCode(packet.result.status);
}

function proofSummary(packet: ProofPacket, path: string) {
  return {
    valid: true,
    integrity: verifyProofPacketIntegrity(packet),
    path,
    runId: packet.runId,
    contractId: packet.contract.id,
    status: packet.result.status,
    evidence: packet.evidence.length,
    createdAt: packet.createdAt,
    proofGaps: packet.result.proofGaps ?? [],
  };
}

async function inspectProofCommand(
  args: string[],
  context: CliContext,
): Promise<number> {
  const parsed = parseArguments(args);
  if (parsed.positional.length !== 1) {
    throw new CliUsageError("proof inspect requires one proof path.");
  }
  const path = absolutePath(context.cwd, parsed.positional[0]!);
  const value = await readJsonFile(path);
  assertProofPacket(value);
  const summary = proofSummary(value, path);

  if (!summary.integrity) {
    throw new Error(`Proof packet integrity check failed: ${path}`);
  }
  if (parsed.json) {
    printJson(context, summary);
  } else {
    context.stdout(
      `Proof ${summary.runId}: ${summary.status}, ${summary.evidence} evidence record(s), integrity verified.`,
    );
  }
  return exitCodes.success;
}

async function dispatch(
  argv: string[],
  context: CliContext,
): Promise<number> {
  const [command, subcommand, ...rest] = argv;

  if (
    command === undefined ||
    command === "--help" ||
    command === "-h" ||
    command === "help"
  ) {
    context.stdout(help);
    return exitCodes.success;
  }
  if (command === "--version" || command === "-v") {
    context.stdout(CLI_VERSION);
    return exitCodes.success;
  }
  if (command === "init") {
    return initContract(
      subcommand === undefined ? rest : [subcommand, ...rest],
      context,
    );
  }
  if (command === "verify") {
    return verifyCommand(
      subcommand === undefined ? rest : [subcommand, ...rest],
      context,
    );
  }
  if (command === "contract" && subcommand === "validate") {
    return validateContractCommand(rest, context);
  }
  if (command === "evidence" && subcommand === "collect") {
    return collectEvidenceCommand(rest, context);
  }
  if (command === "proof" && subcommand === "inspect") {
    return inspectProofCommand(rest, context);
  }

  throw new CliUsageError(
    `Unknown command: ${[command, subcommand].filter(Boolean).join(" ")}`,
  );
}

export async function runCli(
  argv: string[] = process.argv.slice(2),
  context: CliContext = defaultContext(),
): Promise<number> {
  try {
    return await dispatch(argv, context);
  } catch (error) {
    context.stderr(`notdone: ${errorMessage(error)}`);
    if (error instanceof CliUsageError) {
      context.stderr("Run 'notdone --help' for usage.");
    }
    return exitCodes.error;
  }
}

const entrypoint = process.argv[1];
if (
  entrypoint !== undefined &&
  import.meta.url === pathToFileURL(entrypoint).href
) {
  process.exitCode = await runCli();
}
