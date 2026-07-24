import type {
  ExecutionPlan,
  VerificationGate,
  VerificationReport,
} from "./types.js";

import { assertExecutionPlan } from "./schema-registry.js";

export function requiredVerificationGates(
  plan: ExecutionPlan,
): VerificationGate[] {
  assertExecutionPlan(plan);
  return (plan.verificationGates ?? []).filter((gate) => gate.required);
}

export function verificationGateSatisfied(
  gate: VerificationGate,
  report: VerificationReport | undefined,
): boolean {
  return !gate.required || report?.verdict === "PASS";
}
