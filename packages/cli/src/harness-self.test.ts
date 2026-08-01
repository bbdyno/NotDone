import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { FilesystemArtifactStore, VerificationReportLedger } from "@notdone/core";
import { SCHEMA_VERSION, type ExecutionPlan, type TaskContract, type VerificationReport } from "@notdone/protocol";
import { describe, expect, it } from "vitest";

import { exitCodes, runCli, type CliContext } from "./cli.js";
import { harnessArtifactManifest, type HarnessRequest } from "./harness.js";

const execute = promisify(execFile);
const timestamp = "2026-08-01T12:00:00.000Z";
const now = () => new Date(timestamp);
const secret = "sk_selftestsecret1234";

interface Fixture {
  root: string;
  workspace: string;
  artifacts: string;
  requestPath: string;
  evidencePath: string;
  head: string;
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "notdone-harness-self-"));
  const workspace = join(root, "target");
  const artifacts = join(root, "durable-artifacts");
  await execute("git", ["init", "-q", workspace]);
  await execute("git", ["config", "user.email", "self-test@example.invalid"], { cwd: workspace });
  await execute("git", ["config", "user.name", "NotDone harness self-test"], { cwd: workspace });
  await writeFile(join(workspace, "result.txt"), "pending\n");
  await execute("git", ["add", "result.txt"], { cwd: workspace });
  await execute("git", ["commit", "-qm", "baseline"], { cwd: workspace });
  const { stdout } = await execute("git", ["rev-parse", "HEAD"], { cwd: workspace });
  const head = stdout.trim();
  const executable = join(root, "fake-codex.mjs");
  await writeFile(executable, `#!${process.execPath}
import { appendFile, writeFile } from "node:fs/promises";
process.stdin.resume();
process.stdin.on("end", async () => {
  await appendFile(".fake-codex-calls", "1\\n");
  await writeFile("result.txt", "done by fake Codex\\n");
  process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "completed ${secret}" }, changed_files: ["result.txt"] }) + "\\n");
  process.stderr.write("diagnostic ${secret}\\n");
});
`);
  await chmod(executable, 0o700);
  const request = harnessRequest(head, executable);
  const requestPath = join(root, "request.json");
  const evidencePath = join(root, "device-evidence.bin");
  await writeFile(requestPath, JSON.stringify(request));
  await writeFile(evidencePath, "opaque external evidence");
  return { root, workspace, artifacts, requestPath, evidencePath, head };
}

function harnessRequest(head: string, executable: string): HarnessRequest {
  const contract: TaskContract = {
    schemaVersion: SCHEMA_VERSION,
    id: "task.harness-self-test",
    title: "Harness self-test",
    createdAt: timestamp,
    frozenAt: timestamp,
    baseRevision: head,
    mode: "explicit",
    claims: [{
      id: "claim.fake-codex-result",
      statement: "The fake Codex process changed the target result.",
      required: true,
      checks: [{ id: "check.fake-codex-result", type: "file", path: "result.txt", expect: { exists: true, contains: "done by fake Codex" } }],
    }],
  };
  const plan: ExecutionPlan = {
    schemaVersion: SCHEMA_VERSION,
    id: "plan.harness-self-test",
    createdAt: timestamp,
    steps: [{ schemaVersion: SCHEMA_VERSION, id: "step.codex", capability: "run", verificationGateIds: ["local-gate", "external-gate"] }],
    policy: { schemaVersion: SCHEMA_VERSION, externalNetwork: "allow", loopback: "deny", allowedTools: ["codex-exec"], approvalRequirement: "none" },
    verificationGates: [
      { schemaVersion: SCHEMA_VERSION, id: "local-gate", required: true },
      { schemaVersion: SCHEMA_VERSION, id: "external-gate", required: true, evidenceRequirement: "external" },
    ],
  };
  return { schemaVersion: SCHEMA_VERSION, runId: "run.harness-self-test", contract, plan, prompt: "Update result.txt and do not commit.", codex: { executable, timeoutMs: 10_000 } };
}

async function invoke(fixture: Fixture, args: string[]): Promise<{ code: number; stdout: unknown; stderr: string[] }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const context: CliContext = { cwd: fixture.root, now, stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) };
  const code = await runCli(args, context);
  return { code, stdout: JSON.parse(stdout.join("\n")), stderr };
}

async function readHead(workspace: string): Promise<string> {
  return (await execute("git", ["rev-parse", "HEAD"], { cwd: workspace })).stdout.trim();
}

describe("harness self-test fixture", () => {
  it("runs the public CLI lifecycle against a real fake-Codex process boundary", async () => {
    const fixture = await createFixture();
    try {
      const first = await invoke(fixture, ["run-next", "--request", "request.json", "--artifact-root", "durable-artifacts", "--target-workspace", "target", "--json"]);
      expect(first.code).toBe(exitCodes.blocked);
      expect(first.stdout).toEqual({ status: "AWAITING_DEVICE_EVIDENCE", reason: "awaiting-external-evidence" });
      expect(await readFile(join(fixture.workspace, ".fake-codex-calls"), "utf8")).toBe("1\n");
      expect(await readFile(join(fixture.workspace, "result.txt"), "utf8")).toContain("done by fake Codex");
      expect(await readHead(fixture.workspace)).toBe(fixture.head);
      expect((await execute("git", ["status", "--porcelain"], { cwd: fixture.workspace })).stdout).toContain("result.txt");

      const store = new FilesystemArtifactStore({ rootDirectory: fixture.artifacts });
      const beforeReadOnly = await store.readImmutableRecords("notdone.gate-unlock-ledger.v1");
      const awaiting = await invoke(fixture, ["status", "--artifact-root", "durable-artifacts", "--run-id", "run.harness-self-test", "--json"]);
      expect(awaiting.code).toBe(exitCodes.blocked);
      expect(awaiting.stdout).toEqual({ status: "AWAITING_DEVICE_EVIDENCE", reason: "awaiting-external-evidence" });
      const local = await invoke(fixture, ["show-report", "--artifact-root", "durable-artifacts", "--run-id", "run.harness-self-test", "--gate-id", "local-gate", "--json"]);
      expect(local.code).toBe(exitCodes.success);
      expect(local.stdout).toMatchObject({ history: [expect.objectContaining({ gateId: "local-gate", verdict: "PASS" })], effective: expect.objectContaining({ gateId: "local-gate", verdict: "PASS" }) });
      expect(await store.readImmutableRecords("notdone.gate-unlock-ledger.v1")).toEqual(beforeReadOnly);

      const imported = await invoke(fixture, ["import-evidence", "--file", "device-evidence.bin", "--artifact-root", "durable-artifacts", "--run-id", "run.harness-self-test", "--gate-id", "external-gate", "--captured-at", timestamp, "--json"]);
      expect(imported.code).toBe(exitCodes.success);
      const importOutput = imported.stdout as { artifactId: string; digest: string; evidenceBundleId: string; evidenceBundleDigest: string };
      expect((await invoke(fixture, ["show-report", "--artifact-root", "durable-artifacts", "--run-id", "run.harness-self-test", "--json"])).stdout).toMatchObject({ history: [expect.objectContaining({ gateId: "local-gate", verdict: "PASS" })] });

      const externalBundle = { schemaVersion: SCHEMA_VERSION, artifactId: importOutput.evidenceBundleId, digest: importOutput.evidenceBundleDigest };
      const externalReport: VerificationReport = { schemaVersion: SCHEMA_VERSION, id: "report.harness-self-test.external", createdAt: timestamp, gateId: "external-gate", verdict: "PASS", evidenceBundle: externalBundle };
      const persistedExternal = await new VerificationReportLedger(store).append("run.harness-self-test", externalReport);
      expect(persistedExternal.report.evidenceBundle).toEqual(externalBundle);

      const second = await invoke(fixture, ["run-next", "--request", "request.json", "--artifact-root", "durable-artifacts", "--target-workspace", "target", "--json"]);
      expect(second.code).toBe(exitCodes.success);
      expect(second.stdout).toEqual({ status: "VERIFIED" });
      expect(await readFile(join(fixture.workspace, ".fake-codex-calls"), "utf8")).toBe("1\n");
      const verified = await invoke(fixture, ["status", "--artifact-root", "durable-artifacts", "--run-id", "run.harness-self-test", "--json"]);
      expect(verified.stdout).toEqual({ status: "VERIFIED" });
      const external = await invoke(fixture, ["show-report", "--artifact-root", "durable-artifacts", "--run-id", "run.harness-self-test", "--gate-id", "external-gate", "--json"]);
      expect(external.stdout).toMatchObject({ effective: expect.objectContaining({ gateId: "external-gate", verdict: "PASS", evidenceBundle: externalBundle }) });
      expect(await store.readImmutableRecords("notdone.gate-unlock-ledger.v1")).toHaveLength(1);

      const manifest = await harnessArtifactManifest(fixture.artifacts, "run.harness-self-test");
      expect(manifest.map((entry) => entry.role)).toEqual(expect.arrayContaining([
        "immutable-task-snapshot", "codex-execution-summary", "redacted-terminal-jsonl", "redacted-stderr", "exit-record", "structured-final-output", "baseline-diff", "verification-proof", "automatic-verifier-evidence-bundle", "verification-report.local-gate",
      ]));
      for (const entry of manifest) await expect(store.read(entry.artifact.digest)).resolves.toBeInstanceOf(Buffer);
      const terminal = await Promise.all(manifest.filter((entry) => entry.role === "redacted-terminal-jsonl" || entry.role === "redacted-stderr").map(async (entry) => (await store.read(entry.artifact.digest)).toString("utf8")));
      expect(terminal.join("\n")).toContain("[redacted]");
      expect(terminal.join("\n")).not.toContain(secret);
      await expect(store.read(importOutput.digest)).resolves.toBeInstanceOf(Buffer);
      await expect(store.read(importOutput.evidenceBundleDigest)).resolves.toBeInstanceOf(Buffer);
      await expect(store.read(persistedExternal.artifact.digest)).resolves.toBeInstanceOf(Buffer);
      const transition = (await store.readImmutableRecords("notdone.gate-unlock-ledger.v1"))[0]!;
      expect(transition.content.toString("utf8")).toContain(importOutput.evidenceBundleDigest);
      expect((await execute("git", ["status", "--porcelain"], { cwd: fixture.workspace })).stdout).not.toContain("durable-artifacts");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});
