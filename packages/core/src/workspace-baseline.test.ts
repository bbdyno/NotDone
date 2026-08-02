import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { preflightWorkspace } from "./workspace-preflight.js";
import { captureWorkspaceBaseline, changedWorkspacePaths, inspectWorkspaceAgainstBaseline } from "./workspace-baseline.js";

const execute = promisify(execFile);
const roots: string[] = [];
const timestamp = "2026-08-02T00:00:00.000Z";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "notdone-workspace-baseline-"));
  roots.push(root);
  await execute("git", ["init", "-q"], { cwd: root });
  await execute("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
  await execute("git", ["config", "user.name", "NotDone test"], { cwd: root });
  await writeFile(join(root, "tracked.txt"), "initial\n");
  await execute("git", ["add", "tracked.txt"], { cwd: root });
  await execute("git", ["commit", "-qm", "baseline"], { cwd: root });
  const { stdout } = await execute("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  return { root, head: stdout.trim() };
}

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("verified workspace baseline", () => {
  it("detects exact changes and permits dirty preflight only when the baseline matches", async () => {
    const { root, head } = await fixture();
    await writeFile(join(root, "tracked.txt"), "verified predecessor\n");
    await writeFile(join(root, "output.txt"), "one\n");
    const baseline = await captureWorkspaceBaseline({ workspaceRoot: root, now: () => new Date(timestamp) });
    expect(baseline.baseRevision).toBe(head);

    const contract = {
      schemaVersion: "1.0" as const,
      id: "task.successor",
      title: "Successor",
      createdAt: timestamp,
      frozenAt: timestamp,
      baseRevision: head,
      mode: "explicit" as const,
      claims: [{ id: "claim.result", statement: "Output exists.", required: true, checks: [{ id: "check.result", type: "file" as const, path: "output.txt", expect: { exists: true } }] }],
    };
    await expect(preflightWorkspace({ workspaceRoot: root, contract, runId: "run.successor", workspaceBaseline: baseline, now: () => new Date(timestamp) })).resolves.toMatchObject({ repository: { dirty: true } });

    await writeFile(join(root, "output.txt"), "two\n");
    const current = await captureWorkspaceBaseline({ workspaceRoot: root, now: () => new Date(timestamp) });
    expect(changedWorkspacePaths(baseline, current)).toEqual(["output.txt"]);
    await expect(inspectWorkspaceAgainstBaseline(root, baseline)).resolves.toMatchObject({ matches: false, changedPaths: ["output.txt"] });
    await expect(preflightWorkspace({ workspaceRoot: root, contract, runId: "run.diverged", workspaceBaseline: baseline })).rejects.toMatchObject({ code: "baseline-mismatch" });
  });
});
