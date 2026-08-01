import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  SCHEMA_VERSION,
  canonicalizeJson,
  sha256Json,
  type TaskContract,
} from "@notdone/protocol";
import { afterEach, describe, expect, it } from "vitest";

import { ContractSemanticError } from "./semantic-validation.js";
import {
  WorkspacePreflightError,
  preflightWorkspace,
} from "./workspace-preflight.js";

const execFileAsync = promisify(execFile);
const timestamp = "2026-08-01T12:00:00.000Z";
const fixtureRoots: string[] = [];

async function createRepository(): Promise<{ root: string; head: string }> {
  const root = await mkdtemp(join(tmpdir(), "notdone-workspace-preflight-"));
  fixtureRoots.push(root);
  await execFileAsync("git", ["init", "--quiet"], { cwd: root });
  await writeFile(join(root, "tracked.txt"), "initial\n");
  await execFileAsync("git", ["add", "tracked.txt"], { cwd: root });
  await execFileAsync(
    "git",
    [
      "-c",
      "user.name=NotDone test",
      "-c",
      "user.email=notdone-test@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "Initial test commit",
    ],
    { cwd: root },
  );
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  });
  return { root, head: stdout.trim() };
}

function contract(baseRevision: string): TaskContract {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: "task.workspace-preflight",
    title: "Preflight a workspace",
    createdAt: timestamp,
    frozenAt: timestamp,
    mode: "explicit",
    baseRevision,
    claims: [
      {
        id: "claim.workspace-preflight",
        statement: "The workspace can be preflighted.",
        required: true,
        checks: [
          {
            id: "check.workspace-preflight",
            type: "manual",
            prompt: "Confirm the workspace preflight.",
          },
        ],
      },
    ],
  };
}

function preflight(root: string, taskContract: TaskContract, runId = "run.preflight") {
  return preflightWorkspace({
    workspaceRoot: root,
    contract: taskContract,
    runId,
    now: () => new Date(timestamp),
  });
}

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("workspace preflight", () => {
  it("rejects an invalid contract before Git commands or snapshot creation", async () => {
    const root = await mkdtemp(join(tmpdir(), "notdone-workspace-preflight-"));
    fixtureRoots.push(root);
    const invalidContract = contract("unused");
    invalidContract.claims = [
      {
        id: "claim.duplicate",
        statement: "The first duplicate claim.",
        required: true,
        checks: [
          {
            id: "check.duplicate.first",
            type: "manual",
            prompt: "Confirm the first duplicate claim.",
          },
        ],
      },
      {
        id: "claim.duplicate",
        statement: "The second duplicate claim.",
        required: true,
        checks: [
          {
            id: "check.duplicate.second",
            type: "manual",
            prompt: "Confirm the second duplicate claim.",
          },
        ],
      },
    ];
    let nowCalls = 0;

    await expect(
      preflightWorkspace({
        workspaceRoot: root,
        contract: invalidContract,
        runId: "run.invalid-contract",
        now: () => {
          nowCalls += 1;
          return new Date(timestamp);
        },
      }),
    ).rejects.toBeInstanceOf(ContractSemanticError);

    expect(nowCalls).toBe(0);
  });

  it("accepts a clean repository whose HEAD matches its baseline", async () => {
    const { root, head } = await createRepository();
    const result = await preflight(root, contract(head));
    const resolvedRoot = await realpath(root);

    expect(result.repository).toEqual({ root: resolvedRoot, head, dirty: false });
    expect(result.taskSnapshot).toMatchObject({
      schemaVersion: SCHEMA_VERSION,
      createdAt: timestamp,
      mediaType: "application/vnd.notdone.task-snapshot+json",
      digest: result.taskSnapshot.metadata.snapshotDigest,
      metadata: {
        runId: "run.preflight",
        contractId: "task.workspace-preflight",
        contractJson: canonicalizeJson(contract(head)),
        contractDigest: sha256Json(contract(head)),
        frozenAt: timestamp,
        requestedBaseRevision: head,
        repositoryRoot: resolvedRoot,
        repositoryHead: head,
      },
    });
    expect(result.taskSnapshot.id).toMatch(/^artifact\.task-snapshot\.[a-f0-9]{64}$/);
    expect(result.taskSnapshot.size).toBe(
      Buffer.byteLength(result.taskSnapshot.metadata.snapshotJson),
    );
    expect(result.taskSnapshot.digest).toBe(
      sha256Json(JSON.parse(result.taskSnapshot.metadata.snapshotJson)),
    );
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.repository)).toBe(true);
    expect(Object.isFrozen(result.taskSnapshot)).toBe(true);
    expect(Object.isFrozen(result.taskSnapshot.metadata)).toBe(true);
  });

  it("rejects tracked worktree changes", async () => {
    const { root, head } = await createRepository();
    await writeFile(join(root, "tracked.txt"), "changed\n");

    await expect(preflight(root, contract(head))).rejects.toMatchObject({
      code: "dirty-worktree",
    } satisfies Partial<WorkspacePreflightError>);
  });

  it("rejects untracked files", async () => {
    const { root, head } = await createRepository();
    await writeFile(join(root, "untracked.txt"), "new\n");

    await expect(preflight(root, contract(head))).rejects.toMatchObject({
      code: "dirty-worktree",
    } satisfies Partial<WorkspacePreflightError>);
  });

  it("rejects a baseline that resolves to a different commit", async () => {
    const { root, head } = await createRepository();
    await writeFile(join(root, "second.txt"), "second\n");
    await execFileAsync("git", ["add", "second.txt"], { cwd: root });
    await execFileAsync(
      "git",
      [
        "-c",
        "user.name=NotDone test",
        "-c",
        "user.email=notdone-test@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "Second test commit",
      ],
      { cwd: root },
    );

    await expect(preflight(root, contract(head))).rejects.toMatchObject({
      code: "baseline-mismatch",
    } satisfies Partial<WorkspacePreflightError>);
  });

  it("rejects a contract without a baseline", async () => {
    const { root, head } = await createRepository();
    const { baseRevision: _baseRevision, ...withoutBaseline } = contract(head);

    await expect(preflight(root, withoutBaseline)).rejects.toMatchObject({
      code: "missing-baseline",
    } satisfies Partial<WorkspacePreflightError>);
  });

  it("rejects an unfrozen contract", async () => {
    const { root, head } = await createRepository();
    const { frozenAt: _frozenAt, ...unfrozenContract } = contract(head);

    await expect(preflight(root, unfrozenContract)).rejects.toMatchObject({
      code: "unfrozen-contract",
    } satisfies Partial<WorkspacePreflightError>);
  });

  it("rejects a non-repository workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "notdone-workspace-preflight-"));
    fixtureRoots.push(root);

    await expect(preflight(root, contract("unused"))).rejects.toMatchObject({
      code: "not-a-repository",
    } satisfies Partial<WorkspacePreflightError>);
  });

  it("keeps the snapshot and digest immutable after the input contract changes", async () => {
    const { root, head } = await createRepository();
    const taskContract = contract(head);
    const result = await preflight(root, taskContract);
    const snapshotJson = result.taskSnapshot.metadata.snapshotJson;
    const snapshotDigest = result.taskSnapshot.digest;

    taskContract.title = "Mutated after preflight";
    taskContract.claims.push({
      id: "claim.mutated",
      statement: "This must not alter the snapshot.",
      required: true,
      checks: [],
    });

    expect(result.taskSnapshot.metadata.snapshotJson).toBe(snapshotJson);
    expect(result.taskSnapshot.digest).toBe(snapshotDigest);
    expect(result.taskSnapshot.metadata.contractJson).not.toContain("Mutated after preflight");
    expect(result.taskSnapshot.metadata.contractDigest).not.toBe(sha256Json(taskContract));
  });

  it("produces a deterministic snapshot payload and digest for fixed input and time", async () => {
    const { root, head } = await createRepository();
    const taskContract = contract(head);
    const first = await preflight(root, taskContract, "run.deterministic");
    const second = await preflight(root, taskContract, "run.deterministic");

    expect(second.taskSnapshot.metadata.snapshotJson).toBe(
      first.taskSnapshot.metadata.snapshotJson,
    );
    expect(second.taskSnapshot.digest).toBe(first.taskSnapshot.digest);
    expect(second.taskSnapshot).toEqual(first.taskSnapshot);
  });
});
