import {
  SCHEMA_VERSION,
  assertEvidence,
  sha256Json,
  type ClaimResult,
  type ContractCheck,
  type ContractClaim,
  type EvidenceRecord,
  type JsonValue,
  type RequiredTrustLevel,
  type TaskContract,
  type VerificationResult,
  type VerificationStatus,
} from "@notdone/protocol";

import { assertValidContract } from "./semantic-validation.js";
import { meetsTrustRequirement } from "./trust.js";

export interface EvaluateContractOptions {
  contract: TaskContract;
  evidence: EvidenceRecord[];
  runId: string;
  evaluatedAt?: string;
}

const evidenceTypeByCheck: Record<ContractCheck["type"], EvidenceRecord["type"]> =
  {
    command: "command",
    file: "file",
    "git-diff": "git-diff",
    manual: "manual",
  };

function metadataBoolean(
  metadata: Record<string, JsonValue> | undefined,
  key: string,
): boolean | undefined {
  const value = metadata?.[key];
  return typeof value === "boolean" ? value : undefined;
}

function metadataString(
  metadata: Record<string, JsonValue> | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" ? value : undefined;
}

function evidenceMatchesCheck(
  evidence: EvidenceRecord,
  claim: ContractClaim,
  check: ContractCheck,
  runId: string,
  minimumTrust: RequiredTrustLevel,
): boolean {
  if (
    evidence.runId !== runId ||
    evidence.checkId !== check.id ||
    !evidence.claimIds.includes(claim.id) ||
    evidence.type !== evidenceTypeByCheck[check.type] ||
    !meetsTrustRequirement(evidence.trust, minimumTrust)
  ) {
    return false;
  }

  switch (check.type) {
    case "command":
      return evidence.command?.command === check.command;
    case "file":
      return metadataString(evidence.metadata, "checkPath") === check.path;
    case "git-diff":
      return true;
    case "manual":
      return metadataBoolean(evidence.metadata, "approved") !== undefined;
  }
}

function checkStatusFromEvidence(
  candidates: EvidenceRecord[],
  check: ContractCheck,
): {
  status: VerificationStatus;
  evidenceId?: string;
  reason?: string;
} {
  const sorted = [...candidates].sort(
    (left, right) =>
      left.capturedAt.localeCompare(right.capturedAt) ||
      left.id.localeCompare(right.id),
  );
  const passed = sorted.find(
    (item) => metadataBoolean(item.metadata, "passed") === true,
  );

  if (passed !== undefined) {
    return {
      status: "verified",
      evidenceId: passed.id,
    };
  }

  const failed = sorted.at(-1);
  if (failed !== undefined) {
    return {
      status: "failed",
      evidenceId: failed.id,
      reason:
        metadataString(failed.metadata, "reason") ??
        "The collected evidence did not satisfy this check.",
    };
  }

  if (check.type === "manual") {
    return {
      status: "blocked",
      reason: "Manual attestation is required.",
    };
  }

  return {
    status: "unverified",
    reason: "No qualifying evidence was collected.",
  };
}

function aggregateStatus(
  statuses: VerificationStatus[],
): VerificationStatus {
  if (statuses.includes("failed")) {
    return "failed";
  }
  if (statuses.includes("blocked")) {
    return "blocked";
  }
  if (statuses.includes("unverified")) {
    return "unverified";
  }
  return "verified";
}

function evaluateClaim(
  claim: ContractClaim,
  evidence: EvidenceRecord[],
  runId: string,
): ClaimResult {
  const minimumTrust = claim.minimumTrust ?? "executed";
  const checkResults = claim.checks.map((check) => {
    const candidates = evidence.filter((item) =>
      evidenceMatchesCheck(item, claim, check, runId, minimumTrust),
    );
    return {
      checkId: check.id,
      ...checkStatusFromEvidence(candidates, check),
    };
  });
  const status = aggregateStatus(checkResults.map((result) => result.status));

  return {
    claimId: claim.id,
    status,
    ...(status === "verified"
      ? {}
      : {
          reason: `Claim has ${checkResults.filter((item) => item.status !== "verified").length} unsatisfied check(s).`,
        }),
    evidenceIds: [
      ...new Set(
        checkResults.flatMap((result) =>
          result.evidenceId === undefined ? [] : [result.evidenceId],
        ),
      ),
    ],
    checkResults,
  };
}

export function evaluateContract({
  contract,
  evidence,
  runId,
  evaluatedAt = new Date().toISOString(),
}: EvaluateContractOptions): VerificationResult {
  assertValidContract(contract);
  for (const record of evidence) {
    assertEvidence(record);
  }

  const claims = contract.claims.map((claim) =>
    evaluateClaim(claim, evidence, runId),
  );
  const requiredClaimIds = new Set(
    contract.claims.filter((claim) => claim.required).map((claim) => claim.id),
  );
  const requiredStatuses = claims
    .filter((claim) => requiredClaimIds.has(claim.claimId))
    .map((claim) => claim.status);
  const status = aggregateStatus(requiredStatuses);
  const proofGaps = claims.flatMap((claim) =>
    claim.status === "verified" || !requiredClaimIds.has(claim.claimId)
      ? []
      : [`${claim.claimId}: ${claim.reason ?? claim.status}`],
  );

  return {
    schemaVersion: SCHEMA_VERSION,
    runId,
    contractDigest: sha256Json(contract),
    status,
    evaluatedAt,
    claims,
    ...(proofGaps.length === 0 ? {} : { proofGaps }),
  };
}
