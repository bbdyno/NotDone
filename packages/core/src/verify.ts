import type {
  EvidenceRecord,
  RuntimeCapabilities,
  TaskContract,
} from "@notdone/protocol";

import {
  collectEvidence,
  type CollectEvidenceOptions,
} from "./collector.js";
import { evaluateContract } from "./evaluator.js";
import { createProofPacket } from "./proof-packet.js";

export interface VerifyWorkspaceOptions
  extends Omit<CollectEvidenceOptions, "contract"> {
  contract: TaskContract;
  existingEvidence?: EvidenceRecord[];
  runtimeCapabilities?: RuntimeCapabilities[];
  evaluatedAt?: string;
}

export async function verifyWorkspace({
  contract,
  existingEvidence = [],
  runtimeCapabilities = [],
  evaluatedAt,
  ...collectionOptions
}: VerifyWorkspaceOptions) {
  const collected = await collectEvidence({
    contract,
    ...collectionOptions,
  });
  const evidence = [...existingEvidence, ...collected];
  const result = evaluateContract({
    contract,
    evidence,
    runId: collectionOptions.runId,
    ...(evaluatedAt === undefined ? {} : { evaluatedAt }),
  });

  return createProofPacket({
    contract,
    evidence,
    result,
    runtimeCapabilities,
    ...(evaluatedAt === undefined ? {} : { createdAt: evaluatedAt }),
  });
}
