import type {
  ExecutionPlan,
  ArtifactReference,
  DigestArtifactReference,
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

/** True only for the portable discriminator, never inferred from identifiers or text. */
export function requiresExternalEvidence(gate: VerificationGate): boolean {
  return gate.evidenceRequirement === "external";
}

export function verificationGateSatisfied(
  gate: VerificationGate,
  report: VerificationReport | undefined,
  requiredEvidenceBundle?: ArtifactReference,
): boolean {
  if (!gate.required) {
    return true;
  }
  if (report?.verdict !== "PASS") {
    return false;
  }
  if (requiredEvidenceBundle === undefined) {
    return true;
  }
  const actual = report.evidenceBundle;
  return (
    hasDigest(requiredEvidenceBundle) &&
    hasDigest(actual) &&
    actual?.artifactId === requiredEvidenceBundle.artifactId &&
    actual.digest === requiredEvidenceBundle.digest
  );
}

/** Runtime guard for external input, even where a narrow type is available. */
export function hasDigest(
  reference: ArtifactReference | undefined,
): reference is DigestArtifactReference {
  return typeof reference?.digest === "string" && reference.digest.length > 0;
}
