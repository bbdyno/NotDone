import {
  SCHEMA_VERSION,
  assertProofPacket,
  proofPacketDigest,
  sha256Json,
  type EvidenceRecord,
  type ProofPacket,
  type RuntimeCapabilities,
  type TaskContract,
  type VerificationResult,
} from "@notdone/protocol";

export interface CreateProofPacketOptions {
  contract: TaskContract;
  evidence: EvidenceRecord[];
  result: VerificationResult;
  runtimeCapabilities: RuntimeCapabilities[];
  createdAt?: string;
  repository?: ProofPacket["repository"];
}

export function createProofPacket({
  contract,
  evidence,
  result,
  runtimeCapabilities,
  createdAt = new Date().toISOString(),
  repository,
}: CreateProofPacketOptions): ProofPacket {
  const contractDigest = sha256Json(contract);
  if (result.contractDigest !== contractDigest) {
    throw new Error("Verification result does not match the task contract.");
  }
  if (evidence.some((record) => record.runId !== result.runId)) {
    throw new Error("Evidence and verification result use different run ids.");
  }

  const packet: ProofPacket = {
    schemaVersion: SCHEMA_VERSION,
    runId: result.runId,
    createdAt,
    contract,
    contractDigest,
    ...(repository === undefined ? {} : { repository }),
    evidence,
    result,
    runtimeCapabilities,
    integrity: {
      algorithm: "sha256",
      digest: "0".repeat(64),
    },
  };
  packet.integrity.digest = proofPacketDigest(packet);
  assertProofPacket(packet);
  return packet;
}

export function verifyProofPacketIntegrity(packet: ProofPacket): boolean {
  assertProofPacket(packet);
  return proofPacketDigest(packet) === packet.integrity.digest;
}
