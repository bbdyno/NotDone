import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { ExecutionBackend } from "@notdone/core";
import { SCHEMA_VERSION, type GoalPlan } from "@notdone/protocol";
import { afterEach, describe, expect, it } from "vitest";

import { pendingGoalEvidence, runGoal, submitGoalEvidence } from "./goal.js";

const execute = promisify(execFile);
const timestamp = "2026-08-02T01:00:00.000Z";
const now = () => new Date(timestamp);
const roots: string[] = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "notdone-goal-"));
  roots.push(root);
  const workspace = join(root, "target");
  const artifacts = join(root, "artifacts");
  await execute("git", ["init", "-q", workspace]);
  await execute("git", ["config", "user.email", "test@example.invalid"], { cwd: workspace });
  await execute("git", ["config", "user.name", "NotDone test"], { cwd: workspace });
  await writeFile(join(workspace, "seed.txt"), "seed\n");
  await execute("git", ["add", "seed.txt"], { cwd: workspace });
  await execute("git", ["commit", "-qm", "baseline"], { cwd: workspace });
  return { root, workspace, artifacts };
}

function task(taskId: string, file: string, dependsOn: string[] = [], human = false) {
  return {
    taskId,
    title: taskId,
    ...(dependsOn.length === 0 ? {} : { dependsOn }),
    acceptanceCriteria: [{ id: `criterion.${taskId}`, statement: `${file} is complete.`, checks: [{ id: `check.${taskId}`, type: "file" as const, path: file, expect: { exists: true, contains: "done" } }] }],
    allowedPaths: [file],
    requiredPaths: [file],
    forbiddenPaths: ["seed.txt"],
    requiredVerifiers: [{ id: `gate.${taskId}.automatic`, kind: "automatic" as const }],
    humanEvidenceRequirements: human ? [{ id: `gate.${taskId}.human`, description: "Inspect the output.", instructions: "Confirm the output is correct." }] : [],
    retryPolicy: { maxAttempts: 2, retryOn: ["verification-failed" as const] },
    completionPolicy: { requiredCriteria: "all" as const, humanEvidence: "required" as const },
  };
}

function plan(tasks: ReturnType<typeof task>[]): GoalPlan {
  return { schemaVersion: SCHEMA_VERSION, id: "goal.test", title: "Goal test", createdAt: timestamp, tasks };
}

function backend(write: () => Promise<void>): ExecutionBackend {
  return { manifest: { backendId: "fake-codex", capabilities: ["run"] }, execute: async () => { await write(); return {}; } };
}

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("goal orchestrator", () => {
  it("runs dependent tasks across uncommitted verified successor baselines", async () => {
    const { workspace, artifacts } = await fixture();
    const goal = plan([task("one", "one.txt"), task("two", "two.txt", ["one"])]);
    const result = await runGoal({
      plan: goal, targetWorkspace: workspace, artifactRoot: artifacts, until: "complete", now,
      harnessContext: { now, createBackend: (request) => backend(() => writeFile(join(workspace, request.contract.metadata?.taskId === "one" ? "one.txt" : "two.txt"), "done\n")) },
    });
    expect(result.status).toBe("COMPLETE");
    expect(result.tasks).toEqual([{ taskId: "one", status: "VERIFIED", attempts: 1 }, { taskId: "two", status: "VERIFIED", attempts: 1 }]);
  });

  it("retries a fixable verification failure without relaxing the original baseline", async () => {
    const { workspace, artifacts } = await fixture();
    const goal = plan([task("retry", "retry.txt")]);
    let attempts = 0;
    const result = await runGoal({
      plan: goal, targetWorkspace: workspace, artifactRoot: artifacts, until: "complete", maxRetries: 1, now,
      harnessContext: { now, createBackend: () => backend(async () => { attempts += 1; await writeFile(join(workspace, "retry.txt"), attempts === 1 ? "bad\n" : "done\n"); }) },
    });
    expect(result).toMatchObject({ status: "COMPLETE", tasks: [{ taskId: "retry", status: "VERIFIED", attempts: 2 }] });
  });

  it("queues, attests, and resumes human evidence", async () => {
    const { root, workspace, artifacts } = await fixture();
    const goal = plan([task("device", "device.txt", [], true)]);
    const context = { now, createBackend: () => backend(() => writeFile(join(workspace, "device.txt"), "done\n")) };
    const first = await runGoal({ plan: goal, targetWorkspace: workspace, artifactRoot: artifacts, until: "human-evidence", now, harnessContext: context });
    expect(first.status).toBe("HUMAN_EVIDENCE_REQUIRED");
    expect(await pendingGoalEvidence(goal, artifacts)).toHaveLength(1);

    const evidence = join(root, "capture.bin");
    await writeFile(evidence, "human-observed output");
    await expect(submitGoalEvidence({ plan: goal, artifactRoot: artifacts, taskId: "device", requirementId: "gate.device.human", file: evidence, capturedAt: timestamp, attestedAt: timestamp })).resolves.toMatchObject({ reportId: expect.stringMatching(/^report\.human-attestation\./u) });

    const resumed = await runGoal({ plan: goal, targetWorkspace: workspace, artifactRoot: artifacts, until: "complete", now, harnessContext: context });
    expect(resumed.status).toBe("COMPLETE");
    expect(await pendingGoalEvidence(goal, artifacts)).toEqual([]);
  });
});
