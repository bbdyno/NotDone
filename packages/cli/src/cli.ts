#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { resolve } from "node:path";

import {
  collectEvidence,
  LocalFolderIndex,
  LocalRetriever,
  loadPackManifest,
  verifyProofPacketIntegrity,
  verifyWorkspace,
  assertValidContract,
} from "@notdone/core";
import {
  assertProofPacket,
  type ProofPacket,
  type SearchQuery,
  type TaskContract,
  type VerificationStatus,
} from "@notdone/protocol";

import {
  errorMessage,
  readJsonFile,
  writeJsonFile,
} from "./files.js";
import { createContractTemplate } from "./template.js";

export const CLI_VERSION = "0.1.1";
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
  limit?: number;
  profile?: "Private" | "Saver" | "Quality";
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
  notdone retrieve <query> [source-root] [--limit N] [--json]
  notdone run <retrieve|verify|model|retrieve-model|model-verify|retrieve-model-verify> [query] [--profile Private|Saver|Quality] [--json]
  notdone backends [--json]
  notdone packs [--json]
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
  let limit: number | undefined;
  let profile: ParsedArguments["profile"];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--output" || argument === "--run-id" || argument === "--limit" || argument === "--profile") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new CliUsageError(`${argument} requires a value.`);
      }
      if (argument === "--output") {
        output = value;
      } else if (argument === "--run-id") {
        runId = value;
      } else if (argument === "--limit") {
        const parsedLimit = Number(value);
        if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) throw new CliUsageError("--limit must be an integer from 1 to 100.");
        limit = parsedLimit;
      } else if (value === "Private" || value === "Saver" || value === "Quality") {
        profile = value;
      } else {
        throw new CliUsageError("--profile must be Private, Saver, or Quality.");
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
    ...(limit === undefined ? {} : { limit }),
    ...(profile === undefined ? {} : { profile }),
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

async function retrieveCommand(args: string[], context: CliContext): Promise<number> {
  const parsed = parseArguments(args);
  if (parsed.positional.length < 1 || parsed.positional.length > 2) throw new CliUsageError("retrieve requires a query and accepts an optional source root.");
  const root = absolutePath(context.cwd, parsed.positional[1] ?? ".");
  const index = await LocalFolderIndex.open(root);
  const retriever = new LocalRetriever(index);
  const query: SearchQuery = { schemaVersion: "1.0", id: `query.${generatedRunId(context.now())}`, text: parsed.positional[0]!, limit: parsed.limit ?? 10 };
  const outcome = await retriever.retrieve(query, context.now().toISOString());
  const output = { mode: "retrieve", route: { kind: "local", reason: "Local lexical retrieval does not require a model or network." }, status: outcome.status === "abstain" ? "ABSTAIN" : "RESULTS", source: index.source, results: outcome.results, citations: outcome.evidenceBundle.evidence.flatMap((item) => item.citations ?? []), artifact: outcome.evidenceBundle };
  if (parsed.json) printJson(context, output); else { context.stdout(`Retrieve ${output.status}: ${outcome.results.length} result(s), local-only route.`); for (const result of outcome.results) context.stdout(`- ${result.path}:${result.startLine}-${result.endLine}`); }
  return exitCodes.success;
}

const runModes = new Set(["retrieve", "verify", "model", "retrieve-model", "model-verify", "retrieve-model-verify"]);

async function runCommand(args: string[], context: CliContext): Promise<number> {
  const parsed = parseArguments(args);
  const mode = parsed.positional[0];
  if (mode === undefined || !runModes.has(mode) || parsed.positional.length > 2) throw new CliUsageError("run requires a supported workflow mode and optional retrieval query.");
  const profile = parsed.profile ?? "Private";
  const includesRetrieve = mode.includes("retrieve");
  const includesModel = mode.includes("model");
  const includesVerify = mode.includes("verify");
  const output: Record<string, unknown> = { mode, profile, route: includesModel ? { kind: "unavailable", reason: profile === "Private" ? "External model execution is denied by the Private profile." : "No model backend is configured for this CLI command." } : { kind: includesRetrieve ? "local" : "verify-only", reason: includesRetrieve ? "Local retrieval is model-free." : "Use the existing verify workflow without retrieval." }, egress: { externalNetwork: profile === "Private" ? "denied" : "approval-required", tokenUsage: 0 }, verification: includesVerify ? { status: "PENDING", reason: "Run `notdone verify` with a task contract to produce independent proof." } : { status: "NOT_REQUESTED" }, approval: includesModel && profile !== "Private" ? "required" : "not-required" };
  if (includesRetrieve) {
    const query = parsed.positional[1] ?? "";
    if (query.length === 0) throw new CliUsageError("retrieve workflows require a query.");
    const index = await LocalFolderIndex.open(context.cwd);
    const outcome = await new LocalRetriever(index).retrieve({ schemaVersion: "1.0", id: `query.${generatedRunId(context.now())}`, text: query, limit: parsed.limit ?? 10 }, context.now().toISOString());
    output.retrieval = { status: outcome.status === "abstain" ? "ABSTAIN" : "RESULTS", citations: outcome.evidenceBundle.evidence.flatMap((item) => item.citations ?? []), artifact: outcome.evidenceBundle };
  }
  if (includesModel) output.execution = { status: "BACKEND_UNAVAILABLE", retry: "Configure a permitted local or approved remote model backend before execution." };
  if (parsed.json) printJson(context, output); else context.stdout(`Workflow ${mode}: ${includesModel ? "model backend unavailable" : "ready"}; profile ${profile}.`);
  return includesModel ? exitCodes.blocked : exitCodes.success;
}

async function packsCommand(args: string[], context: CliContext): Promise<number> {
  const parsed = parseArguments(args); if (parsed.positional.length !== 0) throw new CliUsageError("packs does not accept positional arguments.");
  const packs = await Promise.all(["local-documents", "verification"].map(async (id) => loadPackManifest(new URL(`../../../packs/${id}/pack.json`, import.meta.url).pathname)));
  if (parsed.json) printJson(context, { packs }); else for (const pack of packs) context.stdout(`${pack.id} ${pack.version}: ${pack.displayName} (${pack.availablePlans.join(", ")})`);
  return exitCodes.success;
}

async function backendsCommand(args: string[], context: CliContext): Promise<number> {
  const parsed = parseArguments(args); if (parsed.positional.length !== 0) throw new CliUsageError("backends does not accept positional arguments.");
  const backends = [{ id: "local-lexical-retriever", status: "available", locality: "local" }, { id: "verify-only", status: "available", locality: "local" }, { id: "loopback-openai-compatible", status: "not-configured", locality: "local" }, { id: "codex-exec", status: "optional", locality: "external" }];
  if (parsed.json) printJson(context, { backends }); else for (const backend of backends) context.stdout(`${backend.id}: ${backend.status} (${backend.locality})`);
  return exitCodes.success;
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
  if (command === "retrieve") return retrieveCommand(subcommand === undefined ? rest : [subcommand, ...rest], context);
  if (command === "run") return runCommand(subcommand === undefined ? rest : [subcommand, ...rest], context);
  if (command === "packs") return packsCommand(subcommand === undefined ? rest : [subcommand, ...rest], context);
  if (command === "backends") return backendsCommand(subcommand === undefined ? rest : [subcommand, ...rest], context);
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
