import { describe, expect, it } from "vitest";

import {
  SCHEMA_VERSION,
  type ExecutionPlan,
  type VerificationGate,
} from "@notdone/protocol";

import {
  ExecutionRuntime,
  type CancellationHandle,
  type ExecutionBackend,
} from "./runtime.js";

const timestamp = "2026-07-24T10:00:00.000Z";

function plan(
  steps: ExecutionPlan["steps"],
  verificationGates?: VerificationGate[],
): ExecutionPlan {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: "plan.runtime",
    createdAt: timestamp,
    steps,
    policy: {
      schemaVersion: SCHEMA_VERSION,
      externalNetwork: "deny",
      loopback: "deny",
      allowedTools: [],
      approvalRequirement: "required",
    },
    ...(verificationGates === undefined ? {} : { verificationGates }),
  };
}

function backend(
  capabilities: ExecutionBackend["manifest"]["capabilities"],
  execute: ExecutionBackend["execute"],
): ExecutionBackend {
  return {
    manifest: {
      backendId: "backend.test",
      capabilities,
    },
    execute,
  };
}

function cancellationHandle(): CancellationHandle {
  let cancelled = false;
  return {
    get cancelled() {
      return cancelled;
    },
    cancel() {
      cancelled = true;
    },
  };
}

describe("ExecutionRuntime", () => {
  it("runs steps sequentially, emits events, and registers artifacts", async () => {
    const calls: string[] = [];
    const runtime = new ExecutionRuntime([
      backend(["retrieve", "run"], async ({ step }) => {
        calls.push(step.id);
        return step.capability === "retrieve"
          ? {
              artifacts: [
                {
                  schemaVersion: SCHEMA_VERSION,
                  id: "artifact.results",
                  createdAt: timestamp,
                  mediaType: "application/json",
                  size: 2,
                  digest: "a".repeat(64),
                },
              ],
            }
          : {};
      }),
    ]);

    const result = await runtime.execute(
      plan([
        {
          schemaVersion: SCHEMA_VERSION,
          id: "step.retrieve",
          capability: "retrieve",
        },
        {
          schemaVersion: SCHEMA_VERSION,
          id: "step.run",
          capability: "run",
          dependsOn: ["step.retrieve"],
        },
      ]),
      { runId: "run.runtime", now: () => new Date(timestamp) },
    );

    expect(calls).toEqual(["step.retrieve", "step.run"]);
    expect(result.run.status).toBe("succeeded");
    expect(result.run.events.map((event) => event.type)).toEqual([
      "step.started",
      "step.completed",
      "step.started",
      "step.completed",
    ]);
    expect(result.artifacts.map((artifact) => artifact.id)).toEqual([
      "artifact.results",
    ]);
  });

  it("converts backend errors and unavailable capabilities into typed failures", async () => {
    const failed = await new ExecutionRuntime([
      backend(["run"], async () => {
        throw new Error("backend failure");
      }),
    ]).execute(
      plan([
        {
          schemaVersion: SCHEMA_VERSION,
          id: "step.run",
          capability: "run",
        },
      ]),
      { runId: "run.failure" },
    );
    const unavailable = await new ExecutionRuntime([]).execute(
      plan([
        {
          schemaVersion: SCHEMA_VERSION,
          id: "step.retrieve",
          capability: "retrieve",
        },
      ]),
      { runId: "run.unavailable" },
    );

    expect(failed.failure?.code).toBe("backend-error");
    expect(failed.run.status).toBe("failed");
    expect(unavailable.failure?.code).toBe("backend-unavailable");
  });

  it("honors cancellation and step timeouts", async () => {
    const cancellation = cancellationHandle();
    cancellation.cancel();
    const cancelled = await new ExecutionRuntime([]).execute(
      plan([
        {
          schemaVersion: SCHEMA_VERSION,
          id: "step.run",
          capability: "run",
        },
      ]),
      { runId: "run.cancelled", cancellation },
    );
    const timedOut = await new ExecutionRuntime([
      backend(["run"], async () => new Promise(() => undefined)),
    ]).execute(
      plan([
        {
          schemaVersion: SCHEMA_VERSION,
          id: "step.run",
          capability: "run",
        },
      ]),
      { runId: "run.timeout", stepTimeoutMs: 5 },
    );

    expect(cancelled.run.status).toBe("cancelled");
    expect(cancelled.failure?.code).toBe("cancelled");
    expect(timedOut.run.status).toBe("failed");
    expect(timedOut.failure?.code).toBe("timeout");
  });

  it("does not complete successfully when a required gate lacks PASS evidence", async () => {
    const requiredGate: VerificationGate = {
      schemaVersion: SCHEMA_VERSION,
      id: "gate.required",
      required: true,
    };
    const optionalGate: VerificationGate = {
      schemaVersion: SCHEMA_VERSION,
      id: "gate.optional",
      required: false,
    };
    const runtime = new ExecutionRuntime([
      backend(["verify"], async () => ({
        verificationReports: [
          {
            schemaVersion: SCHEMA_VERSION,
            id: "report.optional",
            createdAt: timestamp,
            gateId: optionalGate.id,
            verdict: "FAIL",
          },
        ],
      })),
    ]);

    const result = await runtime.execute(
      plan(
        [
          {
            schemaVersion: SCHEMA_VERSION,
            id: "step.verify",
            capability: "verify",
            verificationGateIds: [requiredGate.id, optionalGate.id],
          },
        ],
        [requiredGate, optionalGate],
      ),
      { runId: "run.gate" },
    );

    expect(result.run.status).toBe("failed");
    expect(result.failure?.code).toBe("required-gate-failed");
  });

  it("binds each required gate to its own evidence bundle", async () => {
    const first: VerificationGate = { schemaVersion: SCHEMA_VERSION, id: "gate.first", required: true };
    const second: VerificationGate = { schemaVersion: SCHEMA_VERSION, id: "gate.second", required: true };
    const firstBundle = { schemaVersion: SCHEMA_VERSION, artifactId: "artifact.first", digest: "a".repeat(64) } as const;
    const secondBundle = { schemaVersion: SCHEMA_VERSION, artifactId: "artifact.second", digest: "b".repeat(64) } as const;
    const reports = (firstEvidence = firstBundle, secondEvidence = secondBundle) => backend(["verify"], async () => ({
      verificationReports: [
        { schemaVersion: SCHEMA_VERSION, id: "report.first", createdAt: timestamp, gateId: first.id, verdict: "PASS", evidenceBundle: firstEvidence },
        { schemaVersion: SCHEMA_VERSION, id: "report.second", createdAt: timestamp, gateId: second.id, verdict: "PASS", evidenceBundle: secondEvidence },
      ],
    }));
    const bindings = { [first.id]: firstBundle, [second.id]: secondBundle };
    const executionPlan = plan([{ schemaVersion: SCHEMA_VERSION, id: "step.verify", capability: "verify", verificationGateIds: [first.id, second.id] }], [first, second]);

    const passed = await new ExecutionRuntime([reports()]).execute(executionPlan, { runId: "run.bound", requiredEvidenceBundles: bindings });
    const missing = await new ExecutionRuntime([reports()]).execute(executionPlan, { runId: "run.missing", requiredEvidenceBundles: { [first.id]: firstBundle } });
    const swapped = await new ExecutionRuntime([reports(secondBundle, firstBundle)]).execute(executionPlan, { runId: "run.swapped", requiredEvidenceBundles: bindings });

    expect(passed.run.status).toBe("succeeded");
    expect(missing.failure?.code).toBe("required-gate-failed");
    expect(swapped.failure?.code).toBe("required-gate-failed");
  });

  it("reports AWAITING_EVIDENCE only for missing or ABSTAIN required external gates", async () => {
    const automatic: VerificationGate = { schemaVersion: SCHEMA_VERSION, id: "gate.automatic", required: true };
    const external: VerificationGate = { schemaVersion: SCHEMA_VERSION, id: "gate.device", required: true, evidenceRequirement: "external" };
    const executionPlan = plan([{ schemaVersion: SCHEMA_VERSION, id: "step.verify", capability: "verify", verificationGateIds: [automatic.id, external.id] }], [automatic, external]);
    const reports = (verdict: "ABSTAIN" | undefined) => backend(["verify"], async () => ({
      verificationReports: [
        { schemaVersion: SCHEMA_VERSION, id: "report.automatic", createdAt: timestamp, gateId: automatic.id, verdict: "PASS" },
        ...(verdict === undefined ? [] : [{ schemaVersion: SCHEMA_VERSION, id: "report.external", createdAt: timestamp, gateId: external.id, verdict }]),
      ],
    }));

    const missing = await new ExecutionRuntime([reports(undefined)]).execute(executionPlan, { runId: "run.external.missing" });
    const abstained = await new ExecutionRuntime([reports("ABSTAIN")]).execute(executionPlan, { runId: "run.external.abstain" });

    expect(missing.run.status).toBe("AWAITING_EVIDENCE");
    expect(missing.awaitingEvidenceGateIds).toEqual([external.id]);
    expect(missing.failure).toBeUndefined();
    expect(abstained.run.status).toBe("AWAITING_EVIDENCE");
  });

  it("prioritizes required FAIL or ERROR over external evidence waiting", async () => {
    const automatic: VerificationGate = { schemaVersion: SCHEMA_VERSION, id: "gate.automatic", required: true };
    const external: VerificationGate = { schemaVersion: SCHEMA_VERSION, id: "gate.device", required: true, evidenceRequirement: "external" };
    const executionPlan = plan([{ schemaVersion: SCHEMA_VERSION, id: "step.verify", capability: "verify", verificationGateIds: [automatic.id, external.id] }], [automatic, external]);
    for (const verdict of ["FAIL", "ERROR"] as const) {
      const result = await new ExecutionRuntime([backend(["verify"], async () => ({
        verificationReports: [{ schemaVersion: SCHEMA_VERSION, id: `report.${verdict}`, createdAt: timestamp, gateId: external.id, verdict }],
      }))]).execute(executionPlan, { runId: `run.external.${verdict}` });
      expect(result.run.status).toBe("failed");
      expect(result.failure?.code).toBe("required-gate-failed");
    }
    const regularFailure = await new ExecutionRuntime([backend(["verify"], async () => ({
      verificationReports: [{ schemaVersion: SCHEMA_VERSION, id: "report.automatic", createdAt: timestamp, gateId: automatic.id, verdict: "FAIL" }],
    }))]).execute(executionPlan, { runId: "run.external.with-failure" });
    expect(regularFailure.run.status).toBe("failed");
  });

  it("keeps optional external gates and non-external ABSTAIN gates compatible", async () => {
    const optionalExternal: VerificationGate = { schemaVersion: SCHEMA_VERSION, id: "gate.optional-device", required: false, evidenceRequirement: "external" };
    const optional = await new ExecutionRuntime([backend(["verify"], async () => ({ verificationReports: [] }))]).execute(
      plan([{ schemaVersion: SCHEMA_VERSION, id: "step.verify", capability: "verify", verificationGateIds: [optionalExternal.id] }], [optionalExternal]),
      { runId: "run.optional-external" },
    );
    const human: VerificationGate = { schemaVersion: SCHEMA_VERSION, id: "gate.human", required: true };
    const humanResult = await new ExecutionRuntime([backend(["verify"], async () => ({
      verificationReports: [{ schemaVersion: SCHEMA_VERSION, id: "report.human", createdAt: timestamp, gateId: human.id, verdict: "ABSTAIN" }],
    }))]).execute(
      plan([{ schemaVersion: SCHEMA_VERSION, id: "step.verify", capability: "verify", verificationGateIds: [human.id] }], [human]),
      { runId: "run.human-abstain" },
    );

    expect(optional.run.status).toBe("succeeded");
    expect(humanResult.run.status).toBe("failed");
    expect(humanResult.run.status).not.toBe("AWAITING_EVIDENCE");
  });

  it("requires an admitted digest-bound bundle for external PASS reports", async () => {
    const gate: VerificationGate = { schemaVersion: SCHEMA_VERSION, id: "gate.external-pass", required: true, evidenceRequirement: "external" };
    const executionPlan = plan([{ schemaVersion: SCHEMA_VERSION, id: "step.verify", capability: "verify", verificationGateIds: [gate.id] }], [gate]);
    const expected = { schemaVersion: SCHEMA_VERSION, artifactId: "bundle.expected", digest: "a".repeat(64) } as const;
    const report = (evidenceBundle?: typeof expected): ExecutionBackend => backend(["verify"], async () => ({
      verificationReports: [{ schemaVersion: SCHEMA_VERSION, id: "report.external-pass", createdAt: timestamp, gateId: gate.id, verdict: "PASS", ...(evidenceBundle === undefined ? {} : { evidenceBundle }) }],
    }));

    const missingBoth = await new ExecutionRuntime([report()]).execute(executionPlan, { runId: "run.external-pass.missing" });
    const arbitraryOnly = await new ExecutionRuntime([report({ ...expected, artifactId: "bundle.arbitrary" })]).execute(executionPlan, { runId: "run.external-pass.arbitrary" });
    const missingReportBundle = await new ExecutionRuntime([report()]).execute(executionPlan, { runId: "run.external-pass.no-report-bundle", requiredEvidenceBundles: { [gate.id]: expected } });
    const matched = await new ExecutionRuntime([report(expected)]).execute(executionPlan, { runId: "run.external-pass.matched", requiredEvidenceBundles: { [gate.id]: expected } });

    expect(missingBoth.run.status).toBe("failed");
    expect(arbitraryOnly.run.status).toBe("failed");
    expect(missingReportBundle.run.status).toBe("failed");
    expect(matched.run.status).toBe("succeeded");
  });
});
