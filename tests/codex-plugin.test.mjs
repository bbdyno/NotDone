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
} from "../plugins/notdone/hooks/notdone-hook.mjs";

const hookPath = join(
  import.meta.dirname,
  "..",
  "plugins",
  "notdone",
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
    id: "task.codex-hook",
    title: "Verify the Codex hook",
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
    runId: "run.codex-hook",
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

test("Codex hook records normalized events without storing raw tool data", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "notdone-codex-hook-"));
  const result = await runHook(cwd, {
    hook_event_name: "PostToolUse",
    session_id: "session.test",
    turn_id: "turn.test",
    cwd,
    tool_name: "Bash",
    tool_use_id: "call.test",
    tool_input: {
      command: "secret command",
    },
    tool_response: {
      output: "secret output",
      is_error: false,
    },
  });

  assert.equal(result.code, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  const event = JSON.parse(
    await readFile(
      join(cwd, ".notdone/runs/session.test.runtime-events.jsonl"),
      "utf8",
    ),
  );
  assert.equal(event.eventType, "tool.after");
  assert.equal(event.tool.name, "Bash");
  assert.match(event.payload.inputDigest, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(event), /secret command|secret output/);
});

test("Codex Stop hook blocks completion without a matching proof", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "notdone-codex-hook-"));
  await writeJson(
    join(cwd, ".notdone/contracts/notdone.json"),
    taskContract(),
  );

  const result = await runHook(cwd, {
    hook_event_name: "Stop",
    session_id: "session.blocked",
    cwd,
  });
  const response = JSON.parse(result.stdout);

  assert.equal(result.code, 0);
  assert.equal(response.continue, false);
  assert.equal(response.stopReason, "NotDone verification is required.");
});

test("Codex Stop hook accepts only an integrity-valid proof for the active contract", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "notdone-codex-hook-"));
  const contract = taskContract();
  const packet = verifiedPacket(contract);
  await writeJson(
    join(cwd, ".notdone/contracts/notdone.json"),
    contract,
  );
  await writeJson(
    join(cwd, ".notdone/proofs/run.codex-hook.proof.json"),
    packet,
  );

  const result = await runHook(cwd, {
    hook_event_name: "Stop",
    session_id: "session.verified",
    cwd,
  });
  const response = JSON.parse(result.stdout);

  assert.equal(validProof(packet, sha256Json(contract)), true);
  assert.equal(response.continue, true);
  assert.match(response.systemMessage, /run\.codex-hook/);

  packet.result.status = "failed";
  assert.equal(validProof(packet, sha256Json(contract)), false);
});
