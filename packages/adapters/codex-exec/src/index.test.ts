import { describe, expect, it } from "vitest";

import { ExecutionRuntime, type CancellationHandle } from "@notdone/core";

import { CodexExecBackend, CodexExecError, type CodexProcess, type CodexProcessSpawner, probeCodexExec } from "./index.js";

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
const backend = (spawner: FakeSpawner, overrides: Partial<ConstructorParameters<typeof CodexExecBackend>[1]> = {}) => new CodexExecBackend(spawner, { workspaceRoot: process.cwd(), executable: "/fake/codex", timeoutMs: 100, approved: true, promptFor: () => "use token sk_secretvalue", environment: { PATH: "/bin", SECRET: "not-forwarded" }, ...overrides });

describe("Codex exec adapter", () => {
  it("starts with argv/stdin, streams JSON, redacts transcripts, and records changed files", async () => {
    const process = new FakeProcess(); const spawner = new FakeSpawner(process); const result = backend(spawner).execute(context());
    process.emitStdout('{"type":"item.completed","item":{"type":"agent_message","text":"done sk_secretvalue"},"changed_files":["src/a.ts"]}\n'); process.close(0);
    await expect(result).resolves.toMatchObject({ artifacts: [{ metadata: { changedFiles: ["src/a.ts"], finalMessage: "done [redacted]", exitStatus: 0 } }] });
    expect(spawner.calls[0]?.[0]?.args.slice(0, 5)).toEqual(["exec", "--ephemeral", "--json", "--sandbox", "workspace-write"]);
    expect(spawner.calls[0]?.[0]?.env).toMatchObject({ PATH: "/bin", GIT_TERMINAL_PROMPT: "0" });
    expect(process.stdin).toContain("do not run git push"); expect(process.stdin).not.toContain("SECRET");
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
