import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ExecutionRuntime, FilesystemArtifactStore, type CancellationHandle } from "@notdone/core";
import type { Artifact } from "@notdone/protocol";

import { CodexExecBackend, CodexExecError, type CodexProcess, type CodexProcessSpawner, probeCodexExec } from "./index.js";

const workspaceRoot = process.cwd();

class FakeProcess implements CodexProcess {
  stdoutListener: ((value: string) => void) | undefined;
  stderrListener: ((value: string) => void) | undefined;
  closeListener: ((value: number | null) => void) | undefined;
  errorListener: ((error: Error) => void) | undefined;
  terminated = false;
  stdin = "";
  writeStdin(value: string): void { this.stdin += value; }
  closeStdin(): void {}
  terminate(): void { this.terminated = true; }
  onStdout(listener: (chunk: string) => void): void { this.stdoutListener = listener; }
  onStderr(listener: (chunk: string) => void): void { this.stderrListener = listener; }
  onClose(listener: (exitCode: number | null) => void): void { this.closeListener = listener; }
  onError(listener: (error: Error) => void): void { this.errorListener = listener; }
  emitStdout(value: string): void { this.stdoutListener?.(value); }
  emitStderr(value: string): void { this.stderrListener?.(value); }
  close(code: number | null): void { this.closeListener?.(code); }
  fail(error: Error): void { this.errorListener?.(error); }
}
class FakeSpawner implements CodexProcessSpawner {
  readonly calls: Parameters<CodexProcessSpawner["spawn"]>[] = [];
  constructor(readonly process: FakeProcess, readonly throwOnSpawn?: Error) {}
  spawn(...args: Parameters<CodexProcessSpawner["spawn"]>): CodexProcess { this.calls.push(args); if (this.throwOnSpawn !== undefined) throw this.throwOnSpawn; return this.process; }
}
const policy = { schemaVersion: "1.0" as const, externalNetwork: "allow" as const, loopback: "deny" as const, allowedTools: ["codex-exec"], approvalRequirement: "required" as const };
const context = (cancellation: CancellationHandle = { cancelled: false, cancel() {} }) => ({ run: { schemaVersion: "1.0" as const, id: "run-1", planId: "plan", createdAt: new Date().toISOString(), status: "running" as const, events: [] }, step: { schemaVersion: "1.0" as const, id: "run", capability: "run" as const }, policy, cancellation });
const backend = (spawner: FakeSpawner, overrides: Partial<ConstructorParameters<typeof CodexExecBackend>[1]> = {}) => new CodexExecBackend(spawner, { workspaceRoot, executable: "/fake/codex", timeoutMs: 100, approved: true, promptFor: () => "use token sk_secretvalue", environment: { PATH: "/bin", SECRET: "not-forwarded" }, ...overrides });

async function withStore<T>(action: (store: FilesystemArtifactStore) => Promise<T>): Promise<T> {
  const rootDirectory = await mkdtemp(join(tmpdir(), "notdone-codex-exec-"));
  try {
    return await action(new FilesystemArtifactStore({ rootDirectory }));
  } finally {
    await rm(rootDirectory, { recursive: true, force: true });
  }
}

function artifactBySuffix(artifacts: Artifact[], suffix: string): Artifact {
  const artifact = artifacts.find((candidate) => candidate.id.endsWith(suffix));
  expect(artifact).toBeDefined();
  return artifact!;
}

async function expectFailureArtifacts(
  store: FilesystemArtifactStore,
  pending: Promise<unknown>,
  code: string,
  terminalReason: string,
  exitCode: number | null,
): Promise<void> {
  const error = await pending.then(
    () => { throw new Error("Expected Codex execution to fail."); },
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(CodexExecError);
  const codexError = error as CodexExecError;
  expect(codexError.code).toBe(code);
  expect(codexError.artifacts).toHaveLength(4);
  const exit = artifactBySuffix(codexError.artifacts, ".terminal.exit");
  expect(JSON.parse((await store.read(exit.digest)).toString("utf8"))).toMatchObject({
    exitCode,
    terminalReason,
  });
}

describe("Codex exec adapter", () => {
  it("starts with argv/stdin, streams JSON, redacts transcripts, and records changed files", async () => {
    const process = new FakeProcess(); const spawner = new FakeSpawner(process); const result = backend(spawner).execute(context());
    process.emitStdout('{"type":"item.completed","item":{"type":"agent_message","text":"done sk_secretvalue"},"changed_files":["src/a.ts"]}\n'); process.close(0);
    const completed = await result;
    expect(completed).toMatchObject({ artifacts: [{ digest: expect.stringMatching(/^(?!0{64}$)[a-f0-9]{64}$/u), metadata: { changedFiles: ["src/a.ts"], finalMessage: "done [redacted]", exitStatus: 0 } }] });
    expect(completed.artifacts).toHaveLength(1);
    expect(spawner.calls[0]?.[0]?.args).toEqual(["--ask-for-approval", "never", "exec", "--ephemeral", "--json", "--sandbox", "workspace-write", "--cd", workspaceRoot, "-"]);
    expect(spawner.calls[0]?.[0]?.env).toMatchObject({ PATH: "/bin", GIT_TERMINAL_PROMPT: "0" });
    expect(process.stdin).toContain("git commit (including git commit --amend)");
    expect(process.stdin).toContain("git merge, git rebase, git reset, git switch, git checkout, git branch, git tag, or git push");
    expect(process.stdin).not.toContain("SECRET");
  });
  it("allows worktree edits when HEAD remains invariant", async () => {
    const process = new FakeProcess();
    let reads = 0;
    const pending = backend(new FakeSpawner(process), {
      headReader: { read: () => { reads += 1; return "a".repeat(40); } },
    }).execute(context());
    process.emitStdout('{"item":{"type":"agent_message","text":"edited worktree only"},"changed_files":["src/worktree-only.ts"]}\n');
    process.close(0);
    await expect(pending).resolves.toMatchObject({
      artifacts: [{ metadata: { changedFiles: ["src/worktree-only.ts"] } }],
    });
    expect(reads).toBe(2);
  });
  it("fails closed before spawning when the initial HEAD lookup fails", async () => {
    const spawner = new FakeSpawner(new FakeProcess());
    await expect(backend(spawner, {
      headReader: { read: () => { throw new Error("git unavailable"); } },
    }).execute(context())).rejects.toMatchObject({ code: "head-check-failed" });
    expect(spawner.calls).toHaveLength(0);
  });
  it("fails with preserved terminal artifacts when Codex changes HEAD", async () => {
    await withStore(async (store) => {
      const process = new FakeProcess();
      const heads = ["a".repeat(40), "b".repeat(40)];
      const pending = backend(new FakeSpawner(process), {
        artifactStore: store,
        headReader: { read: () => heads.shift() ?? "b".repeat(40) },
      }).execute(context());
      process.emitStdout('{"item":{"type":"agent_message","text":"claimed success"}}\n');
      process.close(0);
      const error = await pending.then(
        () => { throw new Error("Expected Codex execution to fail."); },
        (reason: unknown) => reason,
      ) as CodexExecError;
      expect(error).toMatchObject({
        code: "head-changed",
        message: expect.stringContaining(`${"a".repeat(40)} to ${"b".repeat(40)}`),
      });
      expect(error.artifacts).toHaveLength(4);
      expect((await store.read(artifactBySuffix(error.artifacts, ".terminal.events").digest)).toString("utf8")).toContain("claimed success");
    });
  });
  it("fails closed after completion when the final HEAD lookup fails", async () => {
    const process = new FakeProcess();
    let reads = 0;
    const pending = backend(new FakeSpawner(process), {
      headReader: { read: () => {
        reads += 1;
        if (reads === 1) return "a".repeat(40);
        throw new Error("git unavailable");
      } },
    }).execute(context());
    process.close(0);
    await expect(pending).rejects.toMatchObject({ code: "head-check-failed" });
  });
  it("preserves a redacted, digest-addressed terminal artifact set when a store is supplied", async () => {
    await withStore(async (store) => {
      const process = new FakeProcess();
      const rawFinal = '{"token":"sk_secretvalue"}';
      const rawEvents = `${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: rawFinal } })}\n`;
      const rawStderr = "warning: sk_secretvalue\n";
      const pending = backend(new FakeSpawner(process), { artifactStore: store }).execute(context());
      process.emitStdout(rawEvents);
      process.emitStderr(rawStderr);
      process.close(0);

      const result = await pending;
      expect(result.artifacts).toHaveLength(5);
      const events = artifactBySuffix(result.artifacts, ".terminal.events");
      const stderr = artifactBySuffix(result.artifacts, ".terminal.stderr");
      const exit = artifactBySuffix(result.artifacts, ".terminal.exit");
      const final = artifactBySuffix(result.artifacts, ".terminal.final");
      expect(events.metadata).toMatchObject({ stream: "events", rawDigest: createHash("sha256").update(rawEvents).digest("hex"), redacted: true, terminalReason: "completed" });
      expect(stderr.metadata).toMatchObject({ stream: "stderr", rawDigest: createHash("sha256").update(rawStderr).digest("hex"), redacted: true });
      expect(final.metadata).toMatchObject({ stream: "final", rawDigest: createHash("sha256").update(rawFinal).digest("hex"), redacted: true });
      expect(events.digest).not.toBe(events.metadata?.rawDigest);
      await expect(store.read(events.digest)).resolves.not.toContain("sk_secretvalue");
      await expect(store.read(stderr.digest)).resolves.not.toContain("sk_secretvalue");
      await expect(store.read(final.digest)).resolves.not.toContain("sk_secretvalue");
      expect(JSON.parse((await store.read(exit.digest)).toString("utf8"))).toMatchObject({ runId: "run-1", stepId: "run", exitCode: 0, terminalReason: "completed" });
      expect(JSON.parse((await store.read(final.digest)).toString("utf8"))).toEqual({ present: true, format: "json", value: { token: "[redacted]" } });
    });
  });
  it("retains terminal evidence for every asynchronous failure terminal state", async () => {
    await withStore(async (store) => {
      const nonZero = new FakeProcess();
      const nonZeroPending = backend(new FakeSpawner(nonZero), { artifactStore: store }).execute(context());
      nonZero.emitStderr("failure sk_secretvalue");
      nonZero.close(7);
      await expectFailureArtifacts(store, nonZeroPending, "failed", "process-failed", 7);

      const malformed = new FakeProcess();
      const malformedPending = backend(new FakeSpawner(malformed), { artifactStore: store }).execute(context());
      malformed.emitStdout("not-json\n");
      malformed.close(0);
      await expectFailureArtifacts(store, malformedPending, "malformed-output", "malformed-output", 0);

      const timeout = new FakeProcess();
      await expectFailureArtifacts(store, backend(new FakeSpawner(timeout), { artifactStore: store, timeoutMs: 1 }).execute(context()), "timeout", "timeout", null);
      expect(timeout.terminated).toBe(true);

      let cancelled = false;
      const cancellation: CancellationHandle = { get cancelled() { return cancelled; }, cancel() { cancelled = true; } };
      const cancelledProcess = new FakeProcess();
      const cancelledPending = backend(new FakeSpawner(cancelledProcess), { artifactStore: store }).execute(context(cancellation));
      cancellation.cancel();
      await expectFailureArtifacts(store, cancelledPending, "cancelled", "cancelled", null);
      expect(cancelledProcess.terminated).toBe(true);

      const processError = new FakeProcess();
      const processErrorPending = backend(new FakeSpawner(processError), { artifactStore: store }).execute(context());
      processError.fail(new Error("spawn stream failure"));
      await expectFailureArtifacts(store, processErrorPending, "missing-executable", "process-error", null);
    });
  });
  it("keeps non-zero exit diagnostics redacted with and without terminal artifact storage", async () => {
    const noStoreProcess = new FakeProcess();
    const noStorePending = backend(new FakeSpawner(noStoreProcess)).execute(context());
    noStoreProcess.emitStderr("failure sk_secretvalue");
    noStoreProcess.close(7);
    const noStoreError = await noStorePending.then(
      () => { throw new Error("Expected Codex execution to fail."); },
      (reason: unknown) => reason,
    ) as CodexExecError;
    expect(noStoreError).toMatchObject({
      code: "failed",
      message: expect.stringContaining("code 7: failure [redacted]"),
      artifacts: [],
    });
    expect(noStoreError.message).not.toContain("sk_secretvalue");

    await withStore(async (store) => {
      const process = new FakeProcess();
      const pending = backend(new FakeSpawner(process), { artifactStore: store }).execute(context());
      process.emitStderr("failure sk_secretvalue");
      process.close(7);
      const error = await pending.then(
        () => { throw new Error("Expected Codex execution to fail."); },
        (reason: unknown) => reason,
      ) as CodexExecError;
      expect(error).toMatchObject({ code: "failed", message: expect.stringContaining("code 7: failure [redacted]") });
      expect(error.message).not.toContain("sk_secretvalue");
      expect(error.artifacts).toHaveLength(4);
    });
  });
  it("keeps ChildProcess error events compatible and settles terminal artifacts only once", async () => {
    const noStoreProcess = new FakeProcess();
    const noStorePending = backend(new FakeSpawner(noStoreProcess)).execute(context());
    noStoreProcess.fail(new Error("ENOENT sk_secretvalue"));
    await expect(noStorePending).rejects.toMatchObject({
      code: "missing-executable",
      message: "ENOENT [redacted]",
      artifacts: [],
    });

    await withStore(async (store) => {
      const process = new FakeProcess();
      const pending = backend(new FakeSpawner(process), { artifactStore: store }).execute(context());
      process.fail(new Error("ENOENT sk_secretvalue"));
      process.close(1);
      process.fail(new Error("late callback"));
      const error = await pending.then(
        () => { throw new Error("Expected Codex execution to fail."); },
        (reason: unknown) => reason,
      ) as CodexExecError;
      expect(error).toMatchObject({ code: "missing-executable", message: "ENOENT [redacted]" });
      expect(error.artifacts).toHaveLength(4);
      const exit = artifactBySuffix(error.artifacts, ".terminal.exit");
      expect(JSON.parse((await store.read(exit.digest)).toString("utf8"))).toMatchObject({ terminalReason: "process-error", exitCode: null });
    });
  });
  it("uses custom redaction, persists only one terminal set, and fails closed on store errors", async () => {
    await withStore(async (store) => {
      const process = new FakeProcess();
      const pending = backend(new FakeSpawner(process), {
        artifactStore: store,
        redact: (value) => value.replaceAll("private-value", "[custom]"),
      }).execute(context());
      process.emitStdout('{"item":{"type":"agent_message","text":"private-value"}}\n');
      process.emitStderr("private-value");
      process.close(0);
      process.close(0);
      process.fail(new Error("late error"));
      const result = await pending;
      expect(result.artifacts).toHaveLength(5);
      const contents = await Promise.all(result.artifacts.slice(1).map((artifact) => store.read(artifact.digest)));
      expect(Buffer.concat(contents).toString("utf8")).toContain("[custom]");
      expect(Buffer.concat(contents).toString("utf8")).not.toContain("private-value");
    });

    const process = new FakeProcess();
    const pending = backend(new FakeSpawner(process), {
      artifactStore: { store: async () => { throw new Error("disk unavailable"); } },
    }).execute(context());
    process.close(0);
    await expect(pending).rejects.toMatchObject({ code: "artifact-persistence-failed", artifacts: [] });

    await withStore(async (store) => {
      let calls = 0;
      const partiallyFailingStore = {
        store: async (options: Parameters<typeof store.store>[0]) => {
          calls += 1;
          if (calls === 3) throw new Error("disk unavailable");
          return store.store(options);
        },
      };
      const partialProcess = new FakeProcess();
      const partialPending = backend(new FakeSpawner(partialProcess), { artifactStore: partiallyFailingStore }).execute(context());
      partialProcess.close(0);
      await expect(partialPending).rejects.toMatchObject({ code: "artifact-persistence-failed", artifacts: [{ id: expect.stringMatching(/\.terminal\.events$/u) }, { id: expect.stringMatching(/\.terminal\.stderr$/u) }] });
    });
  });
  it("reports process failure, malformed output, missing executable, timeout, and cancellation", async () => {
    const failed = new FakeProcess(); const failure = backend(new FakeSpawner(failed)).execute(context()); failed.emitStderr("failure"); failed.close(1); await expect(failure).rejects.toMatchObject({ code: "failed" });
    const malformed = new FakeProcess(); const malformedResult = backend(new FakeSpawner(malformed)).execute(context()); malformed.emitStdout("not-json\n"); malformed.close(0); await expect(malformedResult).rejects.toMatchObject({ code: "malformed-output" });
    await expect(backend(new FakeSpawner(new FakeProcess(), new Error("ENOENT"))).execute(context())).rejects.toMatchObject({ code: "missing-executable" });
    const timedOut = new FakeProcess(); await expect(backend(new FakeSpawner(timedOut), { timeoutMs: 1 }).execute(context())).rejects.toMatchObject({ code: "timeout" }); expect(timedOut.terminated).toBe(true);
    let cancelled = false; const cancelling: CancellationHandle = { get cancelled() { return cancelled; }, cancel() { cancelled = true; } }; const cancelledProcess = new FakeProcess(); const cancelledResult = backend(new FakeSpawner(cancelledProcess)).execute(context(cancelling)); cancelling.cancel(); await expect(cancelledResult).rejects.toMatchObject({ code: "cancelled" }); expect(cancelledProcess.terminated).toBe(true);
  });
  it("checks policy before spawning and keeps Codex completion separate from required verification", async () => {
    const deniedSpawner = new FakeSpawner(new FakeProcess()); await expect(backend(deniedSpawner, { approved: false }).execute(context())).rejects.toMatchObject({ code: "policy-denied" }); expect(deniedSpawner.calls).toHaveLength(0);
    const process = new FakeProcess(); const runtime = new ExecutionRuntime([backend(new FakeSpawner(process))]); const run = runtime.execute({ schemaVersion: "1.0", id: "plan", createdAt: new Date().toISOString(), policy, steps: [{ schemaVersion: "1.0", id: "run", capability: "run" }], verificationGates: [{ schemaVersion: "1.0", id: "independent", required: true }] }, { runId: "run-1" }); process.emitStdout('{"type":"item.completed","item":{"type":"agent_message","text":"complete"}}\n'); process.close(0); await expect(run).resolves.toMatchObject({ failure: { code: "required-gate-failed" } });
  });
  it("reports executable capability without invoking Codex", async () => {
    const availableProcess = new FakeProcess(); const availableResult = probeCodexExec(new FakeSpawner(availableProcess)); availableProcess.emitStdout("codex-cli 0.145.0\n"); availableProcess.close(0); await expect(availableResult).resolves.toMatchObject({ health: "available", version: "codex-cli 0.145.0" });
    const unavailable = await probeCodexExec(new FakeSpawner(new FakeProcess(), new Error("ENOENT"))); expect(unavailable).toMatchObject({ health: "unavailable" });
  });
});
