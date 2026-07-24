import { createHash } from "node:crypto";
import { access, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";

import { SCHEMA_VERSION, type VerificationReport, type VerificationVerdict } from "@notdone/protocol";

import type { ExecutionBackend } from "./runtime.js";

export type VerificationInput =
  | { type: "file"; path: string; sha256?: string }
  | { type: "json"; path: string; requiredKeys: string[] }
  | { type: "regex"; value: string; pattern: string }
  | { type: "citation"; path: string; startLine: number; endLine: number }
  | { type: "command"; argv: string[]; cwd?: string; timeoutMs?: number; expectExitCode: number }
  | { type: "human" };

export interface Verifier { id: string; verify(input: VerificationInput): Promise<{ verdict: VerificationVerdict; reason: string }>; }

function report(gateId: string, verdict: VerificationVerdict, reason: string): VerificationReport {
  return { schemaVersion: SCHEMA_VERSION, id: `report.${gateId}`, createdAt: new Date().toISOString(), gateId, verdict, reason };
}
function inside(root: string, path: string): string {
  const candidate = isAbsolute(path) ? resolve(path) : resolve(root, path);
  const part = relative(root, candidate);
  if (part === ".." || part.startsWith(`..${sep}`) || isAbsolute(part)) throw new Error("Path escapes verification workspace.");
  return candidate;
}
export class LocalVerifier implements Verifier {
  readonly id = "local-proof-verifier";
  readonly #root: string;
  constructor(root: string) { this.#root = root; }
  async verify(input: VerificationInput): Promise<{ verdict: VerificationVerdict; reason: string }> {
    try {
      if (input.type === "human") return { verdict: "ABSTAIN", reason: "Human approval is pending." };
      if (input.type === "regex") return { verdict: new RegExp(input.pattern, "u").test(input.value) ? "PASS" : "FAIL", reason: "Regex condition evaluated." };
      if (input.type === "command") return this.command(input);
      const path = inside(await realpath(this.#root), input.path);
      if (input.type === "file") { const data = await readFile(path); return { verdict: input.sha256 === undefined || createHash("sha256").update(data).digest("hex") === input.sha256 ? "PASS" : "FAIL", reason: "File evidence evaluated." }; }
      if (input.type === "json") { const value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>; return { verdict: input.requiredKeys.every((key) => key in value) ? "PASS" : "FAIL", reason: "Structured output evaluated." }; }
      const lines = (await readFile(path, "utf8")).split(/\r?\n/u); return { verdict: input.startLine > 0 && input.endLine >= input.startLine && input.endLine <= lines.length ? "PASS" : "FAIL", reason: "Citation range evaluated." };
    } catch (error) { return { verdict: "ERROR", reason: error instanceof Error ? error.message : String(error) }; }
  }
  private command(input: Extract<VerificationInput, { type: "command" }>): Promise<{ verdict: VerificationVerdict; reason: string }> {
    const allowed = new Set(["node", "pnpm", "git"]);
    if (input.argv.length === 0 || !allowed.has(input.argv[0] ?? "") || input.argv.some((arg) => /(^|\s)(rm|sudo|curl|wget)(\s|$)/u.test(arg))) return Promise.resolve({ verdict: "ERROR", reason: "Command specification is not allowed." });
    return new Promise((resolveResult) => { const child = spawn(input.argv[0]!, input.argv.slice(1), { cwd: input.cwd === undefined ? this.#root : inside(this.#root, input.cwd), env: { PATH: process.env.PATH ?? "" }, stdio: "ignore" }); const timer = setTimeout(() => { child.kill(); resolveResult({ verdict: "ERROR", reason: "Command timed out." }); }, input.timeoutMs ?? 60_000); child.on("close", (code) => { clearTimeout(timer); resolveResult({ verdict: code === input.expectExitCode ? "PASS" : "FAIL", reason: `Command exit code: ${code ?? -1}.` }); }); child.on("error", (error) => { clearTimeout(timer); resolveResult({ verdict: "ERROR", reason: error.message }); }); });
  }
}
export class VerifyOnlyBackend implements ExecutionBackend {
  readonly manifest: ExecutionBackend["manifest"] = { backendId: "verify-only", capabilities: ["verify"] };
  constructor(private readonly verifier: Verifier, private readonly inputs: Array<{ gateId: string; input: VerificationInput }>) {}
  async execute() { const verificationReports = await Promise.all(this.inputs.map(async ({ gateId, input }) => { const result = await this.verifier.verify(input); return report(gateId, result.verdict, result.reason); })); return { verificationReports }; }
}
