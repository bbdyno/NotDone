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
} from "../plugins/notdone-claude/hooks/notdone-hook.mjs";

const hookPath = join(
  import.meta.dirname,
  "..",
  "plugins",
  "notdone-claude",
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
    id: "task.claude-hook",
    title: "Verify the Claude hook",
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
    runId: "run.claude-hook",
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

test("Claude hook records success and failure events without raw tool data", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "notdone-claude-hook-"));
  for (const hookEventName of ["PostToolUse", "PostToolUseFailure"]) {
    const result = await runHook(cwd, {
      hook_event_name: hookEventName,
      session_id: "session.test",
      cwd,
      tool_name: "Bash",
      tool_use_id: `call.${hookEventName}`,
      tool_input: {
        command: "secret command",
      },
      tool_response: {
        output: "secret output",
      },
      error: "secret error",
    });
    assert.equal(result.code, 0);
  }

  const events = (
    await readFile(
      join(cwd, ".notdone/runs/session.test.runtime-events.jsonl"),
      "utf8",
    )
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    events.map((event) => event.eventType),
    ["tool.after", "tool.failure"],
  );
  assert.doesNotMatch(
    JSON.stringify(events),
    /secret command|secret output|secret error/,
  );
});

test("Claude Stop and TaskCompleted hooks block without proof", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "notdone-claude-hook-"));
  await writeJson(
    join(cwd, ".notdone/contracts/notdone.json"),
    taskContract(),
  );

  const stop = await runHook(cwd, {
    hook_event_name: "Stop",
    session_id: "session.stop",
    cwd,
    background_tasks: [],
    session_crons: [],
  });
  assert.equal(stop.code, 0);
  assert.deepEqual(JSON.parse(stop.stdout), {
    decision: "block",
    reason:
      "No integrity-valid verified NotDone proof matches the active contract. Invoke /notdone:verify and resolve every proof gap.",
  });

  const task = await runHook(cwd, {
    hook_event_name: "TaskCompleted",
    session_id: "session.task",
    task_id: "task.test",
    cwd,
  });
  assert.equal(task.code, 2);
  assert.match(task.stderr, /No integrity-valid verified NotDone proof/);
});

test("Claude Stop hook allows background waits and integrity-valid proof", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "notdone-claude-hook-"));
  const contract = taskContract();
  const packet = verifiedPacket(contract);
  await writeJson(
    join(cwd, ".notdone/contracts/notdone.json"),
    contract,
  );

  const background = await runHook(cwd, {
    hook_event_name: "Stop",
    session_id: "session.background",
    cwd,
    background_tasks: [
      {
        id: "task.background",
      },
    ],
    session_crons: [],
  });
  assert.equal(background.code, 0);
  assert.equal(background.stdout, "");

  await writeJson(
    join(cwd, ".notdone/proofs/run.claude-hook.proof.json"),
    packet,
  );
  const verified = await runHook(cwd, {
    hook_event_name: "Stop",
    session_id: "session.verified",
    cwd,
    background_tasks: [],
    session_crons: [],
  });
  assert.equal(validProof(packet, sha256Json(contract)), true);
  assert.equal(verified.code, 0);
  assert.equal(verified.stdout, "");
});
