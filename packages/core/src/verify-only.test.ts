import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION, type ExecutionPlan } from "@notdone/protocol";
import { ExecutionRuntime } from "./runtime.js";
import { LocalVerifier, VerifyOnlyBackend } from "./verify-only.js";

describe("verify-only", () => {
  it("distinguishes PASS FAIL ABSTAIN and ERROR without a model", async () => {
    const root = await mkdtemp(join(tmpdir(), "notdone-verify-")); await writeFile(join(root, "result.json"), '{"ok":true}'); const verifier = new LocalVerifier(root);
    expect((await verifier.verify({ type: "json", path: "result.json", requiredKeys: ["ok"] })).verdict).toBe("PASS");
    expect((await verifier.verify({ type: "regex", value: "no", pattern: "yes" })).verdict).toBe("FAIL");
    expect((await verifier.verify({ type: "human" })).verdict).toBe("ABSTAIN");
    expect((await verifier.verify({ type: "file", path: "../nope" })).verdict).toBe("ERROR");
  });
  it("uses safe argv commands and blocks required gates in a verify-only plan", async () => {
    const root = await mkdtemp(join(tmpdir(), "notdone-verify-")); const verifier = new LocalVerifier(root);
    expect((await verifier.verify({ type: "command", argv: ["sh", "-c", "echo bad"], expectExitCode: 0 })).verdict).toBe("ERROR");
    const plan: ExecutionPlan = { schemaVersion: SCHEMA_VERSION, id: "plan.verify", createdAt: "2026-07-24T00:00:00.000Z", steps: [{ schemaVersion: SCHEMA_VERSION, id: "step.verify", capability: "verify", verificationGateIds: ["gate.required"] }], verificationGates: [{ schemaVersion: SCHEMA_VERSION, id: "gate.required", required: true }], policy: { schemaVersion: SCHEMA_VERSION, externalNetwork: "deny", loopback: "deny", allowedTools: [], approvalRequirement: "required" } };
    const result = await new ExecutionRuntime([new VerifyOnlyBackend(verifier, [{ gateId: "gate.required", input: { type: "human" } }])]).execute(plan, { runId: "run.verify" });
    expect(result.failure?.code).toBe("required-gate-failed");
  });
});
