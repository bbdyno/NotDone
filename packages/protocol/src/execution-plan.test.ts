import { describe, expect, it } from "vitest";

import {
  requiredVerificationGates,
  verificationGateSatisfied,
} from "./execution-plan.js";
import { validateExecutionPlan } from "./schema-registry.js";
import {
  SCHEMA_VERSION,
  type ExecutionPlan,
  type VerificationGate,
  type VerificationReport,
} from "./types.js";

const timestamp = "2026-07-24T06:00:00.000Z";

function policy(): ExecutionPlan["policy"] {
  return {
    schemaVersion: SCHEMA_VERSION,
    externalNetwork: "deny",
    loopback: "deny",
    remoteTokenBudget: 0,
    allowedTools: [],
    approvalRequirement: "required",
  };
}

function plan(steps: ExecutionPlan["steps"]): ExecutionPlan {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: "plan.example",
    createdAt: timestamp,
    steps,
    policy: policy(),
  };
}

describe("provider-neutral execution plans", () => {
  it("round-trips a single retrieve-only plan without a model backend", () => {
    const retrieveOnly = plan([
      {
        schemaVersion: SCHEMA_VERSION,
        id: "step.retrieve",
        capability: "retrieve",
        outputArtifactIds: ["artifact.results"],
      },
    ]);

    const roundTripped = JSON.parse(
      JSON.stringify(retrieveOnly),
    ) as unknown;
    expect(validateExecutionPlan(roundTripped)).toMatchObject({
      valid: true,
      value: retrieveOnly,
    });
  });

  it("represents verify-only and composed plans with required and optional gates", () => {
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
    const verificationReport: VerificationReport = {
      schemaVersion: SCHEMA_VERSION,
      id: "report.required",
      createdAt: timestamp,
      gateId: requiredGate.id,
      verdict: "PASS",
    };
    const verifyOnly = plan([
      {
        schemaVersion: SCHEMA_VERSION,
        id: "step.verify",
        capability: "verify",
        inputArtifacts: [
          {
            schemaVersion: SCHEMA_VERSION,
            artifactId: "artifact.existing",
          },
        ],
      },
    ]);
    const composed = {
      ...plan([
        {
          schemaVersion: SCHEMA_VERSION,
          id: "step.retrieve",
          capability: "retrieve",
          outputArtifactIds: ["artifact.results"],
        },
        {
          schemaVersion: SCHEMA_VERSION,
          id: "step.verify",
          capability: "verify",
          dependsOn: ["step.retrieve"],
          inputArtifacts: [
            {
              schemaVersion: SCHEMA_VERSION,
              artifactId: "artifact.results",
            },
          ],
          verificationGateIds: [requiredGate.id, optionalGate.id],
        },
        {
          schemaVersion: SCHEMA_VERSION,
          id: "step.run",
          capability: "run",
          dependsOn: ["step.verify"],
        },
      ]),
      verificationGates: [requiredGate, optionalGate],
    };

    expect(validateExecutionPlan(verifyOnly)).toMatchObject({ valid: true });
    expect(validateExecutionPlan(composed)).toMatchObject({ valid: true });
    expect(requiredVerificationGates(composed)).toEqual([requiredGate]);
    expect(verificationGateSatisfied(requiredGate, verificationReport)).toBe(true);
    expect(verificationGateSatisfied(requiredGate, undefined)).toBe(false);
    expect(verificationGateSatisfied(optionalGate, undefined)).toBe(true);
  });

  it("rejects empty plans and invalid dependency or gate references", () => {
    expect(validateExecutionPlan({ ...plan([]) })).toMatchObject({
      valid: false,
    });
    expect(
      validateExecutionPlan(
        plan([
          {
            schemaVersion: SCHEMA_VERSION,
            id: "step.verify",
            capability: "verify",
            dependsOn: ["step.missing"],
            verificationGateIds: ["gate.missing"],
          },
        ]),
      ),
    ).toMatchObject({ valid: false });
  });
});
