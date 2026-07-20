import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { validateRuntimeEvent } from "../packages/protocol/dist/index.js";

const fixtures = [
  {
    runtime: "codex",
    hookPath: join(
      import.meta.dirname,
      "..",
      "plugins",
      "notdone",
      "hooks",
      "notdone-hook.mjs",
    ),
    events: [
      ["SessionStart", "session.start", {}],
      [
        "PostToolUse",
        "tool.after",
        {
          tool_name: "Bash",
          tool_use_id: "call.success",
          tool_input: { command: "conformance secret input" },
          tool_response: {
            output: "conformance secret output",
            is_error: false,
          },
        },
      ],
      [
        "PostToolUse",
        "tool.failure",
        {
          tool_name: "Bash",
          tool_use_id: "call.failure",
          tool_input: { command: "conformance secret input" },
          tool_response: {
            output: "conformance secret failure",
            is_error: true,
          },
        },
      ],
      ["SubagentStop", "subagent.stop", {}],
      ["Stop", "completion.attempt", {}],
    ],
  },
  {
    runtime: "claude-code",
    hookPath: join(
      import.meta.dirname,
      "..",
      "plugins",
      "notdone-claude",
      "hooks",
      "notdone-hook.mjs",
    ),
    events: [
      ["SessionStart", "session.start", {}],
      [
        "PostToolUse",
        "tool.after",
        {
          tool_name: "Bash",
          tool_use_id: "call.success",
          tool_input: { command: "conformance secret input" },
          tool_response: { output: "conformance secret output" },
        },
      ],
      [
        "PostToolUseFailure",
        "tool.failure",
        {
          tool_name: "Bash",
          tool_use_id: "call.failure",
          tool_input: { command: "conformance secret input" },
          error: "conformance secret failure",
        },
      ],
      ["SubagentStart", "subagent.start", { agent_id: "agent.one" }],
      ["SubagentStop", "subagent.stop", { agent_id: "agent.one" }],
      ["TaskCompleted", "completion.attempt", { task_id: "task.one" }],
      ["Stop", "completion.attempt", {}],
    ],
  },
  {
    runtime: "gemini-cli",
    hookPath: join(
      import.meta.dirname,
      "..",
      "hooks",
      "notdone-hook.mjs",
    ),
    events: [
      ["SessionStart", "session.start", {}],
      ["BeforeAgent", "turn.start", {}],
      [
        "AfterTool",
        "tool.after",
        {
          tool_name: "run_shell_command",
          tool_input: { command: "conformance secret input" },
          tool_response: { llmContent: "conformance secret output" },
        },
      ],
      [
        "AfterTool",
        "tool.failure",
        {
          tool_name: "run_shell_command",
          tool_input: { command: "conformance secret input" },
          tool_response: { error: "conformance secret failure" },
        },
      ],
      [
        "AfterAgent",
        "completion.attempt",
        {
          prompt: "conformance secret prompt",
          prompt_response: "conformance secret response",
          stop_hook_active: false,
        },
      ],
    ],
  },
];

function runHook(hookPath, cwd, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hookPath], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stderr = [];
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `${hookPath} exited with ${code}: ${Buffer.concat(stderr)}`,
          ),
        );
      }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

for (const fixture of fixtures) {
  test(`${fixture.runtime} emits protocol-conformant runtime events`, async () => {
    const cwd = await mkdtemp(join(tmpdir(), `notdone-${fixture.runtime}-`));
    const sessionId = `session.${fixture.runtime}`;
    const timestamp = "2026-07-20T05:00:00.000Z";

    for (const [nativeEvent, , extra] of fixture.events) {
      await runHook(fixture.hookPath, cwd, {
        hook_event_name: nativeEvent,
        session_id: sessionId,
        timestamp,
        cwd,
        ...extra,
      });
    }

    const serializedEvents = await readFile(
      join(cwd, ".notdone/runs", `${sessionId}.runtime-events.jsonl`),
      "utf8",
    );
    const events = serializedEvents
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    assert.equal(events.length, fixture.events.length);
    assert.deepEqual(
      events.map((event) => event.eventType),
      fixture.events.map(([, eventType]) => eventType),
    );

    for (const event of events) {
      const validation = validateRuntimeEvent(event);
      assert.equal(
        validation.valid,
        true,
        validation.valid ? "" : JSON.stringify(validation.errors),
      );
      assert.equal(event.runtime, fixture.runtime);
    }

    assert.doesNotMatch(
      serializedEvents,
      /conformance secret (input|output|failure|prompt|response)/,
    );
  });
}
