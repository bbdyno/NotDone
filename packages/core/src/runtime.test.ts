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
});
