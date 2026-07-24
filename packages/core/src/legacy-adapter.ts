import {
  SCHEMA_VERSION,
  type Artifact,
  type ExecutionPlan,
  type ProofPacket,
} from "@notdone/protocol";

import { collectEvidence } from "./collector.js";
import { evaluateContract } from "./evaluator.js";
import {
  ExecutionRuntime,
  type ExecutionBackend,
} from "./runtime.js";
import { createProofPacket } from "./proof-packet.js";
import type { VerifyWorkspaceOptions } from "./verify.js";

function legacyPlan(createdAt: string): ExecutionPlan {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: "plan.legacy-verification",
    createdAt,
    steps: [
      {
        schemaVersion: SCHEMA_VERSION,
        id: "step.legacy-verify",
        capability: "verify",
        outputArtifactIds: ["artifact.legacy-proof"],
      },
    ],
    policy: {
      schemaVersion: SCHEMA_VERSION,
      externalNetwork: "deny",
      loopback: "deny",
      allowedTools: ["legacy-contract-checks"],
      approvalRequirement: "none",
    },
  };
}

export class LegacyExecutionAdapter {
  async verifyWorkspace(options: VerifyWorkspaceOptions): Promise<ProofPacket> {
    let packet: ProofPacket | undefined;
    let originalError: unknown;
    const now = options.now ?? (() => new Date());
    const backend: ExecutionBackend = {
      manifest: {
        backendId: "legacy-notdone-verifier",
        capabilities: ["verify"],
      },
      execute: async () => {
        try {
          packet = await this.verifyLegacyWorkspace(options);
          const artifact: Artifact = {
            schemaVersion: SCHEMA_VERSION,
            id: "artifact.legacy-proof",
            createdAt: now().toISOString(),
            mediaType: "application/vnd.notdone.proof-packet+json",
            size: Buffer.byteLength(JSON.stringify(packet)),
            digest: packet.integrity.digest,
          };
          return { artifacts: [artifact] };
        } catch (error) {
          originalError = error;
          throw error;
        }
      },
    };
    const runtime = new ExecutionRuntime([backend]);
    const result = await runtime.execute(legacyPlan(now().toISOString()), {
      runId: options.runId,
      now,
    });
    if (result.failure !== undefined) {
      if (originalError instanceof Error) {
        throw originalError;
      }
      throw new Error(result.failure.message);
    }
    if (packet === undefined) {
      throw new Error("Legacy verification did not produce a proof packet.");
    }
    return packet;
  }

  private async verifyLegacyWorkspace({
    contract,
    existingEvidence = [],
    runtimeCapabilities = [],
    evaluatedAt,
    ...collectionOptions
  }: VerifyWorkspaceOptions): Promise<ProofPacket> {
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
}
