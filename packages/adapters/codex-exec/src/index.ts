import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";

import type {
  CancellationHandle,
  ExecutionBackend,
  ExecutionContext,
} from "@notdone/core";
import { SCHEMA_VERSION, type Artifact, type JsonValue } from "@notdone/protocol";

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
  artifactStore?: CodexTerminalArtifactStore;
}

/** The narrow persistence surface required for durable Codex terminal evidence. */
export interface CodexTerminalArtifactStore {
  store(options: {
    id: string;
    mediaType: string;
    content: string | Uint8Array;
    metadata?: Record<string, JsonValue>;
    createdAt?: string;
  }): Promise<Artifact>;
}

export type CodexTerminalReason =
  | "completed"
  | "process-failed"
  | "malformed-output"
  | "timeout"
  | "cancelled"
  | "process-error";

class TerminalPersistenceError extends Error {
  constructor(readonly artifacts: Artifact[]) {
    super("Codex terminal artifact persistence failed.");
  }
}

export class CodexExecError extends Error {
  constructor(
    readonly code: "missing-executable" | "policy-denied" | "timeout" | "cancelled" | "failed" | "malformed-output" | "artifact-persistence-failed",
    message: string,
    readonly artifacts: Artifact[] = [],
  ) {
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

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
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
      const redact = this.options.redact ?? redaction;
      const settle = (
        terminalReason: CodexTerminalReason,
        exitCode: number | null,
        processError?: Error,
      ): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        clearInterval(cancellationPoll);
        if (terminalReason === "timeout" || terminalReason === "cancelled") {
          process.terminate();
        }
        const capturedStdout = stdout;
        const capturedStderr = stderr;

        void (async () => {
          const durationMs = Date.now() - startedAt;
          let transcript: { finalMessage?: string; changedFiles: string[] } | undefined;
          let parseError: CodexExecError | undefined;
          try {
            transcript = parseTranscript(capturedStdout);
          } catch (error) {
            if (error instanceof CodexExecError && terminalReason === "completed") {
              parseError = error;
            } else if (!(error instanceof CodexExecError)) {
              throw error;
            }
          }

          const actualReason = parseError === undefined ? terminalReason : "malformed-output";
          let terminalArtifacts: Artifact[] = [];
          try {
            terminalArtifacts = await this.persistTerminalArtifacts({
              context,
              stdout: capturedStdout,
              stderr: capturedStderr,
              finalMessage: transcript?.finalMessage,
              terminalReason: actualReason,
              exitCode,
              durationMs,
              redact,
            });
          } catch (error) {
            rejectResult(new CodexExecError(
              "artifact-persistence-failed",
              "Failed to persist Codex terminal artifacts.",
              error instanceof TerminalPersistenceError ? error.artifacts : terminalArtifacts,
            ));
            return;
          }

          if (parseError !== undefined) {
            rejectResult(new CodexExecError(parseError.code, parseError.message, terminalArtifacts));
            return;
          }
          if (actualReason === "process-failed") {
            rejectResult(new CodexExecError(
              "failed",
              `Codex exec exited with code ${exitCode ?? -1}: ${redact(capturedStderr)}`,
              terminalArtifacts,
            ));
            return;
          }
          if (actualReason === "timeout") {
            rejectResult(new CodexExecError("timeout", "Codex exec timed out.", terminalArtifacts));
            return;
          }
          if (actualReason === "cancelled") {
            rejectResult(new CodexExecError("cancelled", "Codex exec was cancelled.", terminalArtifacts));
            return;
          }
          if (actualReason === "process-error") {
            rejectResult(new CodexExecError(
              "missing-executable",
              redact(processError?.message ?? "Codex exec executable failed."),
              terminalArtifacts,
            ));
            return;
          }

          const successfulTranscript = transcript ?? { changedFiles: [] };
          const metadata = {
            exitStatus: exitCode,
            durationMs,
            changedFiles: successfulTranscript.changedFiles,
            ...(successfulTranscript.finalMessage === undefined
              ? {}
              : { finalMessage: redact(successfulTranscript.finalMessage) }),
            stderr: redact(capturedStderr),
          };
          const serializedMetadata = JSON.stringify(metadata);
          resolveResult({
            artifacts: [
              {
                schemaVersion: SCHEMA_VERSION,
                id: `artifact.codex.${context.run.id}.${context.step.id}`,
                createdAt: new Date().toISOString(),
                mediaType: "application/vnd.notdone.codex-exec+json",
                size: Buffer.byteLength(serializedMetadata),
                digest: createHash("sha256").update(serializedMetadata).digest("hex"),
                metadata,
              },
              ...terminalArtifacts,
            ],
          });
        })().catch(() => {
          rejectResult(new CodexExecError("failed", "Codex exec terminal handling failed."));
        });
      };
      const timeout = setTimeout(() => settle("timeout", null), this.options.timeoutMs);
      const cancellationPoll = setInterval(() => {
        if (context.cancellation.cancelled) settle("cancelled", null);
      }, 5);
      process.onStdout((chunk) => { stdout += chunk; });
      process.onStderr((chunk) => { stderr += chunk; });
      process.onError((error) => settle("process-error", null, error));
      process.onClose((exitCode) => settle(exitCode === 0 ? "completed" : "process-failed", exitCode));
      process.writeStdin(prompt);
      process.closeStdin();
    });
  }

  private async persistTerminalArtifacts({
    context,
    stdout,
    stderr,
    finalMessage,
    terminalReason,
    exitCode,
    durationMs,
    redact,
  }: {
    context: ExecutionContext;
    stdout: string;
    stderr: string;
    finalMessage: string | undefined;
    terminalReason: CodexTerminalReason;
    exitCode: number | null;
    durationMs: number;
    redact: (value: string) => string;
  }): Promise<Artifact[]> {
    if (this.options.artifactStore === undefined) return [];

    const capturedAt = new Date().toISOString();
    const idPrefix = `artifact.codex.${context.run.id}.${context.step.id}.terminal`;
    const metadata = (stream: string, raw: string): Record<string, JsonValue> => ({
      runId: context.run.id,
      stepId: context.step.id,
      stream,
      rawDigest: digest(raw),
      redacted: true,
      terminalReason,
    });
    const finalEnvelope = this.finalEnvelope(finalMessage, redact);
    const exitRecord = {
      runId: context.run.id,
      stepId: context.step.id,
      exitCode,
      terminalReason,
      durationMs,
      capturedAt,
    };
    const serializedExitRecord = JSON.stringify(exitRecord);
    const serializedFinalEnvelope = JSON.stringify(finalEnvelope);

    const artifacts: Artifact[] = [];
    const store = async (options: Parameters<CodexTerminalArtifactStore["store"]>[0]): Promise<void> => {
      artifacts.push(await this.options.artifactStore!.store(options));
    };
    try {
      await store({
        id: `${idPrefix}.events`,
        mediaType: "application/x-ndjson",
        content: redact(stdout),
        metadata: metadata("events", stdout),
        createdAt: capturedAt,
      });
      await store({
        id: `${idPrefix}.stderr`,
        mediaType: "text/plain; charset=utf-8",
        content: redact(stderr),
        metadata: metadata("stderr", stderr),
        createdAt: capturedAt,
      });
      await store({
        id: `${idPrefix}.exit`,
        mediaType: "application/json",
        content: serializedExitRecord,
        metadata: metadata("exit", serializedExitRecord),
        createdAt: capturedAt,
      });
      await store({
        id: `${idPrefix}.final`,
        mediaType: "application/json",
        content: serializedFinalEnvelope,
        metadata: metadata("final", finalMessage ?? ""),
        createdAt: capturedAt,
      });
    } catch {
      throw new TerminalPersistenceError(artifacts);
    }
    return artifacts;
  }

  private finalEnvelope(
    finalMessage: string | undefined,
    redact: (value: string) => string,
  ): { present: boolean; format: "text" | "json"; value: JsonValue } {
    if (finalMessage === undefined) {
      return { present: false, format: "text", value: null };
    }
    const value = redact(finalMessage);
    try {
      return { present: true, format: "json", value: JSON.parse(value) as JsonValue };
    } catch {
      return { present: true, format: "text", value };
    }
  }

  private start(context: ExecutionContext): CodexProcess {
    try {
      return this.spawner.spawn({ executable: this.options.executable, args: ["--ask-for-approval", "never", "exec", "--ephemeral", "--json", "--sandbox", "workspace-write", "--cd", this.options.workspaceRoot, "-"], cwd: this.options.workspaceRoot, env: allowedEnvironment(this.options.environment) });
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
