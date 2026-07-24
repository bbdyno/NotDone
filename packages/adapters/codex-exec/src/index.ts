import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import type {
  CancellationHandle,
  ExecutionBackend,
  ExecutionContext,
} from "@notdone/core";
import { SCHEMA_VERSION, type Artifact } from "@notdone/protocol";

export interface CodexProcess {
  writeStdin(value: string): void;
  closeStdin(): void;
  terminate(): void;
  onStdout(listener: (chunk: string) => void): void;
  onStderr(listener: (chunk: string) => void): void;
  onClose(listener: (exitCode: number | null) => void): void;
  onError(listener: (error: Error) => void): void;
}

export interface CodexProcessSpec {
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

export interface CodexProcessSpawner {
  spawn(spec: CodexProcessSpec): CodexProcess;
}

class NodeCodexProcess implements CodexProcess {
  constructor(private readonly child: ChildProcessWithoutNullStreams) {}
  writeStdin(value: string): void { this.child.stdin.write(value); }
  closeStdin(): void { this.child.stdin.end(); }
  terminate(): void {
    if (this.child.pid !== undefined && process.platform !== "win32") {
      try { process.kill(-this.child.pid, "SIGTERM"); return; } catch { /* fall through */ }
    }
    this.child.kill("SIGTERM");
  }
  onStdout(listener: (chunk: string) => void): void { this.child.stdout.on("data", (chunk: Buffer) => listener(chunk.toString("utf8"))); }
  onStderr(listener: (chunk: string) => void): void { this.child.stderr.on("data", (chunk: Buffer) => listener(chunk.toString("utf8"))); }
  onClose(listener: (exitCode: number | null) => void): void { this.child.on("close", listener); }
  onError(listener: (error: Error) => void): void { this.child.on("error", listener); }
}

export class NodeCodexProcessSpawner implements CodexProcessSpawner {
  spawn(spec: CodexProcessSpec): CodexProcess {
    return new NodeCodexProcess(spawn(spec.executable, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      detached: process.platform !== "win32",
      stdio: "pipe",
    }));
  }
}

export interface CodexExecCapability {
  id: "codex-exec";
  health: "available" | "unavailable";
  executable: string;
  version?: string;
  reason?: string;
}

export interface CodexExecOptions {
  workspaceRoot: string;
  executable: string;
  timeoutMs: number;
  approved: boolean;
  promptFor: (context: ExecutionContext) => string;
  redact?: (value: string) => string;
  environment?: Record<string, string | undefined>;
}

export class CodexExecError extends Error {
  constructor(readonly code: "missing-executable" | "policy-denied" | "timeout" | "cancelled" | "failed" | "malformed-output", message: string) {
    super(message);
    this.name = "CodexExecError";
  }
}

function allowedEnvironment(source: Record<string, string | undefined> | undefined): Record<string, string> {
  const values: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "CODEX_HOME", "TMPDIR"] as const) {
    const value = source?.[key] ?? process.env[key];
    if (value !== undefined) values[key] = value;
  }
  values.GIT_ASKPASS = "/bin/false";
  values.GIT_TERMINAL_PROMPT = "0";
  return values;
}

function redaction(value: string): string {
  return value.replace(/(?:sk|api)[_-][A-Za-z0-9_-]{8,}/gu, "[redacted]");
}

function parseTranscript(stdout: string): { finalMessage?: string; changedFiles: string[] } {
  const events = stdout.trim().split(/\r?\n/u).filter(Boolean);
  if (events.length === 0) return { changedFiles: [] };
  let finalMessage: string | undefined;
  const changedFiles = new Set<string>();
  for (const line of events) {
    let event: unknown;
    try { event = JSON.parse(line); } catch { throw new CodexExecError("malformed-output", "Codex JSON event stream is malformed."); }
    if (typeof event !== "object" || event === null) throw new CodexExecError("malformed-output", "Codex JSON event is malformed.");
    const record = event as Record<string, unknown>;
    const item = record.item as Record<string, unknown> | undefined;
    if (item?.type === "agent_message" && typeof item.text === "string") finalMessage = item.text;
    const files = record.changed_files ?? record.changedFiles;
    if (Array.isArray(files)) for (const file of files) if (typeof file === "string") changedFiles.add(file);
  }
  return { ...(finalMessage === undefined ? {} : { finalMessage }), changedFiles: [...changedFiles].sort() };
}

export class CodexExecBackend implements ExecutionBackend {
  readonly manifest: ExecutionBackend["manifest"] = { backendId: "codex-exec", capabilities: ["run"] };
  constructor(private readonly spawner: CodexProcessSpawner, private readonly options: CodexExecOptions) {}

  async execute(context: ExecutionContext): Promise<{ artifacts: Artifact[] }> {
    if (context.policy.externalNetwork !== "allow" || !this.options.approved || !context.policy.allowedTools.includes("codex-exec")) {
      throw new CodexExecError("policy-denied", "Codex exec is not policy-approved.");
    }
    const startedAt = Date.now();
    const prompt = `${this.options.promptFor(context)}\n\nSafety constraints: do not run git push, create releases, or publish packages. Work only inside the requested workspace.`;
    const process = this.start(context);
    let stdout = "";
    let stderr = "";
    return new Promise((resolveResult, rejectResult) => {
      let settled = false;
      const finish = (callback: () => void) => { if (!settled) { settled = true; clearTimeout(timeout); clearInterval(cancellationPoll); callback(); } };
      const timeout = setTimeout(() => finish(() => { process.terminate(); rejectResult(new CodexExecError("timeout", "Codex exec timed out.")); }), this.options.timeoutMs);
      const cancellationPoll = setInterval(() => {
        if (context.cancellation.cancelled) finish(() => { process.terminate(); rejectResult(new CodexExecError("cancelled", "Codex exec was cancelled.")); });
      }, 5);
      process.onStdout((chunk) => { stdout += chunk; });
      process.onStderr((chunk) => { stderr += chunk; });
      process.onError((error) => finish(() => rejectResult(new CodexExecError("missing-executable", error.message))));
      process.onClose((exitCode) => finish(() => {
        if (exitCode !== 0) { rejectResult(new CodexExecError("failed", `Codex exec exited with code ${exitCode ?? -1}: ${redaction(stderr)}`)); return; }
        try {
          const transcript = parseTranscript(stdout);
          resolveResult({ artifacts: [{ schemaVersion: SCHEMA_VERSION, id: `artifact.codex.${context.run.id}.${context.step.id}`, createdAt: new Date().toISOString(), mediaType: "application/vnd.notdone.codex-exec+json", size: Buffer.byteLength(stdout) + Buffer.byteLength(stderr), digest: "0".repeat(64), metadata: { exitStatus: exitCode, durationMs: Date.now() - startedAt, changedFiles: transcript.changedFiles, ...(transcript.finalMessage === undefined ? {} : { finalMessage: (this.options.redact ?? redaction)(transcript.finalMessage) }), stderr: (this.options.redact ?? redaction)(stderr) } }] });
        } catch (error) { rejectResult(error); }
      }));
      process.writeStdin(prompt);
      process.closeStdin();
    });
  }

  private start(context: ExecutionContext): CodexProcess {
    try {
      return this.spawner.spawn({ executable: this.options.executable, args: ["exec", "--ephemeral", "--json", "--sandbox", "workspace-write", "--ask-for-approval", "never", "--cd", this.options.workspaceRoot, "-"], cwd: this.options.workspaceRoot, env: allowedEnvironment(this.options.environment) });
    } catch (error) {
      throw new CodexExecError("missing-executable", error instanceof Error ? error.message : String(error));
    }
  }
}

export async function probeCodexExec(spawner: CodexProcessSpawner, executable = "codex"): Promise<CodexExecCapability> {
  return new Promise((resolveResult) => {
    let stdout = "";
    try {
      const spawned = spawner.spawn({ executable, args: ["--version"], cwd: process.cwd(), env: allowedEnvironment(undefined) });
      spawned.onStdout((chunk) => { stdout += chunk; });
      spawned.onError((error) => resolveResult({ id: "codex-exec", health: "unavailable", executable, reason: error.message }));
      spawned.onClose((exitCode) => resolveResult(exitCode === 0 ? { id: "codex-exec", health: "available", executable, version: stdout.trim() } : { id: "codex-exec", health: "unavailable", executable, reason: `exit code ${exitCode ?? -1}` }));
    } catch (error) { resolveResult({ id: "codex-exec", health: "unavailable", executable, reason: error instanceof Error ? error.message : String(error) }); }
  });
}
