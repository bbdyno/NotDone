import { describe, expect, it } from "vitest";

import { proofPacketDigest, sha256Json } from "./canonical-json.js";
import {
  SchemaValidationError,
  assertTaskContract,
  validateEvidence,
  validateProofPacket,
  validateRuntimeEvent,
  validateTaskContract,
} from "./schema-registry.js";
import type {
  EvidenceRecord,
  ProofPacket,
  TaskContract,
  VerificationResult,
} from "./types.js";

const timestamp = "2026-07-20T05:00:00.000Z";
const digest = "a".repeat(64);

const contract: TaskContract = {
  schemaVersion: "1.0",
  id: "task.release-ready",
  title: "Prove the release is ready",
  createdAt: timestamp,
  mode: "explicit",
  claims: [
    {
      id: "claim.tests",
      statement: "The test suite passes.",
      required: true,
      minimumTrust: "executed",
      checks: [
        {
          id: "check.tests",
          type: "command",
          command: "pnpm test",
          expect: {
            exitCode: 0,
          },
        },
      ],
    },
  ],
};

const evidence: EvidenceRecord = {
  schemaVersion: "1.0",
  id: "evidence.tests",
  runId: "run.example",
  claimIds: ["claim.tests"],
  checkId: "check.tests",
  type: "command",
  trust: "executed",
  capturedAt: timestamp,
  digest,
  producer: {
    runtime: "notdone",
  },
  command: {
    command: "pnpm test",
    cwd: "/workspace",
    exitCode: 0,
    durationMs: 1200,
  },
};

const result: VerificationResult = {
  schemaVersion: "1.0",
  runId: "run.example",
  contractDigest: sha256Json(contract),
  status: "verified",
  evaluatedAt: timestamp,
  claims: [
    {
      claimId: "claim.tests",
      status: "verified",
      evidenceIds: ["evidence.tests"],
      checkResults: [
        {
          checkId: "check.tests",
          status: "verified",
          evidenceId: "evidence.tests",
        },
      ],
    },
  ],
};

const packet: ProofPacket = {
  schemaVersion: "1.0",
  runId: "run.example",
  createdAt: timestamp,
  contract,
  contractDigest: sha256Json(contract),
  evidence: [evidence],
  result,
  runtimeCapabilities: [
    {
      runtime: "codex",
      capabilities: {
        "completion-hook": true,
        "tool-observation": true,
      },
    },
  ],
  integrity: {
    algorithm: "sha256",
    digest,
  },
};

describe("schema registry", () => {
  it("accepts valid protocol documents", () => {
    expect(validateTaskContract(contract)).toMatchObject({ valid: true });
    expect(validateEvidence(evidence)).toMatchObject({ valid: true });
    expect(validateProofPacket(packet)).toMatchObject({ valid: true });
  });

  it("does not include the packet digest in its own integrity hash", () => {
    expect(
      proofPacketDigest({
        ...packet,
        integrity: {
          algorithm: "sha256",
          digest: "b".repeat(64),
        },
      }),
    ).toBe(proofPacketDigest(packet));
  });

  it("requires command details for command evidence", () => {
    const invalid = {
      ...evidence,
      command: undefined,
    };

    expect(validateEvidence(invalid)).toMatchObject({ valid: false });
  });

  it("requires tool details for tool events", () => {
    expect(
      validateRuntimeEvent({
        schemaVersion: "1.0",
        id: "event.tool",
        runtime: "claude-code",
        sessionId: "session.example",
        eventType: "tool.after",
        occurredAt: timestamp,
        cwd: "/workspace",
      }),
    ).toMatchObject({ valid: false });
  });

  it("rejects unknown fields and exposes assertion errors", () => {
    const invalid = {
      ...contract,
      claimedByAgent: true,
    };

    expect(validateTaskContract(invalid)).toMatchObject({ valid: false });
    expect(() => assertTaskContract(invalid)).toThrow(SchemaValidationError);
  });
});
