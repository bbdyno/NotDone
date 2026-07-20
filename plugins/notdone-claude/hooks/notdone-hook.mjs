#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  appendFile,
  mkdir,
  readFile,
  readdir,
} from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export function canonicalize(value) {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Non-finite number in proof payload.");
    }
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  if (typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
      .join(",")}}`;
  }
  throw new TypeError(`Unsupported proof value: ${typeof value}`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function sha256Json(value) {
  return sha256(canonicalize(value));
}

async function readStandardInput() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  const input = Buffer.concat(chunks).toString("utf8").trim();
  return input.length === 0 ? {} : JSON.parse(input);
}

function safeIdentifier(value, fallback) {
  const normalized = String(value ?? fallback).replaceAll(
    /[^a-zA-Z0-9._:-]/g,
    "-",
  );
  return normalized.slice(0, 128) || fallback;
}

function normalizedEvent(input) {
  const nativeEvent = String(input.hook_event_name ?? "unknown");
  const eventTypeByHook = {
    SessionStart: "session.start",
    PostToolUse: "tool.after",
    PostToolUseFailure: "tool.failure",
    SubagentStart: "subagent.start",
    SubagentStop: "subagent.stop",
    TaskCompleted: "completion.attempt",
    Stop: "completion.attempt",
  };
  const sessionId = safeIdentifier(input.session_id, "unknown-session");
  const occurredAt = new Date().toISOString();
  const event = {
    schemaVersion: "1.0",
    id: `event.${sha256Json([
      sessionId,
      nativeEvent,
      occurredAt,
      input.tool_use_id ?? input.task_id ?? "",
    ]).slice(0, 32)}`,
    runtime: "claude-code",
    sessionId,
    eventType: eventTypeByHook[nativeEvent] ?? "completion.attempt",
    occurredAt,
    cwd: String(input.cwd ?? process.cwd()),
    nativeEvent,
    payload: {
      permissionMode: String(input.permission_mode ?? "unknown"),
    },
  };

  if (nativeEvent === "PostToolUse" || nativeEvent === "PostToolUseFailure") {
    event.tool = {
      name: String(input.tool_name ?? "unknown"),
      ...(typeof input.tool_use_id === "string"
        ? { callId: input.tool_use_id }
        : {}),
      isError: nativeEvent === "PostToolUseFailure",
    };
    event.payload.inputDigest = sha256Json(input.tool_input ?? null);
    event.payload.outputDigest = sha256Json(
      nativeEvent === "PostToolUse"
        ? input.tool_response ?? null
        : {
            error: input.error ?? null,
            isInterrupt: input.is_interrupt ?? false,
          },
    );
  }
  if (typeof input.agent_id === "string") {
    event.actorId = input.agent_id;
  }
  if (typeof input.task_id === "string") {
    event.payload.taskId = input.task_id;
  }
  return event;
}

async function recordEvent(input) {
  const cwd = String(input.cwd ?? process.cwd());
  const event = normalizedEvent(input);
  const directory = join(cwd, ".notdone", "runs");
  await mkdir(directory, {
    recursive: true,
  });
  const path = join(directory, `${event.sessionId}.runtime-events.jsonl`);
  await appendFile(path, `${JSON.stringify(event)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export function packetDigest(packet) {
  const copy = structuredClone(packet);
  delete copy.integrity.digest;
  return sha256Json(copy);
}

export function validProof(packet, contractDigest) {
  return (
    packet?.schemaVersion === "1.0" &&
    packet?.contractDigest === contractDigest &&
    packet?.result?.contractDigest === contractDigest &&
    packet?.result?.status === "verified" &&
    packet?.integrity?.algorithm === "sha256" &&
    typeof packet?.integrity?.digest === "string" &&
    packetDigest(packet) === packet.integrity.digest
  );
}

async function findVerifiedProof(cwd, contract) {
  const proofDirectory = join(cwd, ".notdone", "proofs");
  const contractDigest = sha256Json(contract);
  let names;
  try {
    names = await readdir(proofDirectory);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }

  for (const name of names.filter((item) => item.endsWith(".proof.json"))) {
    try {
      const packet = await readJson(join(proofDirectory, name));
      if (validProof(packet, contractDigest)) {
        return packet;
      }
    } catch {
      // Ignore malformed candidates. The verifier reports them explicitly.
    }
  }
  return undefined;
}

function noProofDecision(nativeEvent) {
  const reason =
    "No integrity-valid verified NotDone proof matches the active contract. Invoke /notdone:verify and resolve every proof gap.";
  if (nativeEvent === "TaskCompleted") {
    return {
      exitCode: 2,
      stderr: reason,
    };
  }
  return {
    response: {
      decision: "block",
      reason,
    },
  };
}

async function completionDecision(input) {
  const cwd = String(input.cwd ?? process.cwd());
  const nativeEvent = String(input.hook_event_name ?? "unknown");
  const contractPath = join(cwd, ".notdone", "contracts", "notdone.json");
  let contract;
  try {
    contract = await readJson(contractPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {};
    }
    return noProofDecision(nativeEvent);
  }

  if (nativeEvent === "SessionStart") {
    return {
      response: {
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext:
            "A NotDone contract is active. Invoke /notdone:verify before claiming completion.",
        },
      },
    };
  }
  if (nativeEvent !== "Stop" && nativeEvent !== "TaskCompleted") {
    return {};
  }
  if (
    nativeEvent === "Stop" &&
    ((Array.isArray(input.background_tasks) &&
      input.background_tasks.length > 0) ||
      (Array.isArray(input.session_crons) && input.session_crons.length > 0))
  ) {
    return {};
  }

  const proof = await findVerifiedProof(cwd, contract);
  return proof === undefined ? noProofDecision(nativeEvent) : {};
}

export async function main() {
  const input = await readStandardInput();
  await recordEvent(input);
  const decision = await completionDecision(input);
  if (decision.stderr !== undefined) {
    process.stderr.write(`${decision.stderr}\n`);
  }
  if (decision.exitCode !== undefined) {
    process.exitCode = decision.exitCode;
  }
  if (decision.response !== undefined) {
    process.stdout.write(`${JSON.stringify(decision.response)}\n`);
  }
}

const entrypoint = process.argv[1];
if (
  entrypoint !== undefined &&
  import.meta.url === pathToFileURL(entrypoint).href
) {
  main().catch((error) => {
    process.stderr.write(
      `NotDone hook failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  });
}
