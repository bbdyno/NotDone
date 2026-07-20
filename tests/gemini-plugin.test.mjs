import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  packetDigest,
  sha256Json,
  validProof,
} from "../hooks/notdone-hook.mjs";

const hookPath = join(
  import.meta.dirname,
  "..",
  "hooks",
  "notdone-hook.mjs",
);

async function writeJson(path, value) {
  await mkdir(dirname(path), {
    recursive: true,
  });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function runHook(cwd, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hookPath], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];

    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString("utf8").trim(),
        stderr: Buffer.concat(stderr).toString("utf8").trim(),
      });
    });
    child.stdin.end(JSON.stringify(input));
  });
}

function taskContract() {
  return {
    schemaVersion: "1.0",
    id: "task.gemini-hook",
    title: "Verify the Gemini hook",
    createdAt: "2026-07-20T05:00:00.000Z",
    mode: "explicit",
    claims: [
      {
        id: "claim.example",
        statement: "The example is complete.",
        required: true,
        checks: [
          {
            id: "check.example",
            type: "manual",
            prompt: "Confirm the example.",
          },
        ],
      },
    ],
  };
}

function verifiedPacket(contract) {
  const contractDigest = sha256Json(contract);
  const packet = {
    schemaVersion: "1.0",
    runId: "run.gemini-hook",
    contractDigest,
    result: {
      contractDigest,
      status: "verified",
    },
    integrity: {
      algorithm: "sha256",
      digest: "0".repeat(64),
    },
  };
  packet.integrity.digest = packetDigest(packet);
  return packet;
}

test("Gemini hook records tool digests without raw content", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "notdone-gemini-hook-"));
  const result = await runHook(cwd, {
    hook_event_name: "AfterTool",
    session_id: "session.test",
    timestamp: "2026-07-20T05:00:00.000Z",
    cwd,
    tool_name: "run_shell_command",
    tool_input: {
      command: "secret command",
    },
    tool_response: {
      llmContent: "secret output",
    },
  });

  assert.equal(result.code, 0);
  assert.equal(result.stdout, "");
  const event = JSON.parse(
    await readFile(
      join(cwd, ".notdone/runs/session.test.runtime-events.jsonl"),
      "utf8",
    ),
  );
  assert.equal(event.eventType, "tool.after");
  assert.match(event.payload.outputDigest, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(event), /secret command|secret output/);
});

test("Gemini AfterAgent hook retries once, then stops unverified", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "notdone-gemini-hook-"));
  await writeJson(
    join(cwd, ".notdone/contracts/notdone.json"),
    taskContract(),
  );

  const retry = await runHook(cwd, {
    hook_event_name: "AfterAgent",
    session_id: "session.retry",
    timestamp: "2026-07-20T05:00:00.000Z",
    cwd,
    prompt: "Complete the task.",
    prompt_response: "Done.",
    stop_hook_active: false,
  });
  assert.deepEqual(JSON.parse(retry.stdout), {
    decision: "deny",
    reason:
      "No integrity-valid verified NotDone proof matches the active contract. Invoke /notdone:verify and resolve every proof gap before responding.",
  });

  const stopped = await runHook(cwd, {
    hook_event_name: "AfterAgent",
    session_id: "session.stopped",
    timestamp: "2026-07-20T05:00:00.000Z",
    cwd,
    prompt: "Complete the task.",
    prompt_response: "Still done.",
    stop_hook_active: true,
  });
  assert.deepEqual(JSON.parse(stopped.stdout), {
    continue: false,
    stopReason:
      "NotDone proof is still missing. The agent stopped without verified completion.",
  });
});

test("Gemini AfterAgent hook allows an integrity-valid proof", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "notdone-gemini-hook-"));
  const contract = taskContract();
  const packet = verifiedPacket(contract);
  await writeJson(
    join(cwd, ".notdone/contracts/notdone.json"),
    contract,
  );
  await writeJson(
    join(cwd, ".notdone/proofs/run.gemini-hook.proof.json"),
    packet,
  );

  const result = await runHook(cwd, {
    hook_event_name: "AfterAgent",
    session_id: "session.verified",
    timestamp: "2026-07-20T05:00:00.000Z",
    cwd,
    prompt: "Complete the task.",
    prompt_response: "Verified.",
    stop_hook_active: false,
  });

  assert.equal(validProof(packet, sha256Json(contract)), true);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "");
});
