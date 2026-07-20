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
    PostToolUse: input.tool_response?.is_error
      ? "tool.failure"
      : "tool.after",
    SubagentStop: "subagent.stop",
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
      input.tool_use_id ?? "",
    ]).slice(0, 32)}`,
    runtime: "codex",
    sessionId,
    eventType: eventTypeByHook[nativeEvent] ?? "completion.attempt",
    occurredAt,
    cwd: String(input.cwd ?? process.cwd()),
    nativeEvent,
    payload: {
      permissionMode: String(input.permission_mode ?? "unknown"),
    },
  };

  if (typeof input.turn_id === "string") {
    event.turnId = input.turn_id;
  }
  if (nativeEvent === "PostToolUse") {
    event.tool = {
      name: String(input.tool_name ?? "unknown"),
      ...(typeof input.tool_use_id === "string"
        ? { callId: input.tool_use_id }
        : {}),
      ...(typeof input.tool_response?.is_error === "boolean"
        ? { isError: input.tool_response.is_error }
        : {}),
    };
    event.payload.inputDigest = sha256Json(input.tool_input ?? null);
    event.payload.outputDigest = sha256Json(input.tool_response ?? null);
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
      // Ignore malformed candidates. The verifier will report them explicitly.
    }
  }
  return undefined;
}

async function completionResponse(input) {
  const cwd = String(input.cwd ?? process.cwd());
  const contractPath = join(cwd, ".notdone", "contracts", "notdone.json");
  let contract;
  try {
    contract = await readJson(contractPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return undefined;
    }
    return {
      continue: false,
      stopReason: "NotDone could not read the active task contract.",
      systemMessage:
        "The NotDone contract is invalid or unreadable. Repair it before claiming completion.",
    };
  }

  if (input.hook_event_name === "SessionStart") {
    return {
      continue: true,
      systemMessage:
        "A NotDone contract is active. Invoke $notdone:verify before claiming completion.",
    };
  }
  if (input.hook_event_name !== "Stop") {
    return undefined;
  }

  const proof = await findVerifiedProof(cwd, contract);
  if (proof !== undefined) {
    return {
      continue: true,
      systemMessage: `NotDone proof ${proof.runId} verified the active contract.`,
    };
  }
  return {
    continue: false,
    stopReason: "NotDone verification is required.",
    systemMessage:
      "No integrity-valid verified proof matches the active contract. Invoke $notdone:verify and resolve every proof gap.",
  };
}

export async function main() {
  const input = await readStandardInput();
  await recordEvent(input);
  const response = await completionResponse(input);
  if (response !== undefined) {
    process.stdout.write(`${JSON.stringify(response)}\n`);
  }
}

const entrypoint = process.argv[1];
if (
  entrypoint !== undefined &&
  import.meta.url === pathToFileURL(entrypoint).href
) {
  main().catch((error) => {
    process.stdout.write(
      `${JSON.stringify({
        continue: false,
        stopReason: "NotDone hook failure.",
        systemMessage: `NotDone hook failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      })}\n`,
    );
  });
}
