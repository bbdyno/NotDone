import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  SCHEMA_VERSION,
  sha256Json,
  type EvidenceRecord,
  type TaskContract,
} from "@notdone/protocol";
import { describe, expect, it } from "vitest";

import { collectEvidence } from "./collector.js";
import { evaluateContract } from "./evaluator.js";
import { verifyProofPacketIntegrity } from "./proof-packet.js";
import {
  ContractSemanticError,
  assertValidContract,
} from "./semantic-validation.js";
import { meetsTrustRequirement } from "./trust.js";
import { verifyWorkspace } from "./verify.js";

const timestamp = "2026-07-20T05:00:00.000Z";

function contractWithChecks(
  checks: TaskContract["claims"][number]["checks"],
): TaskContract {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: "task.example",
    title: "Verify an example",
    createdAt: timestamp,
    mode: "explicit",
    claims: [
      {
        id: "claim.example",
        statement: "The declared checks pass.",
        required: true,
        checks,
      },
    ],
  };
}

function commandEvidence(
  overrides: Partial<EvidenceRecord> = {},
): EvidenceRecord {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: "evidence.command",
    runId: "run.example",
    claimIds: ["claim.example"],
    checkId: "check.command",
    type: "command",
    trust: "executed",
    capturedAt: timestamp,
    digest: "a".repeat(64),
    producer: {
      runtime: "notdone",
    },
    command: {
      command: "node --version",
      cwd: "/workspace",
      exitCode: 0,
      durationMs: 10,
    },
    metadata: {
      passed: true,
    },
    ...overrides,
  };
}

describe("trust", () => {
  it("orders trust levels and rejects self-reported completion", () => {
    expect(meetsTrustRequirement("executed", "observed")).toBe(true);
    expect(meetsTrustRequirement("self-reported", "observed")).toBe(false);
    expect(meetsTrustRequirement("observed", "executed")).toBe(false);
  });
});

describe("contract semantics", () => {
  it("rejects duplicate check ids", () => {
    const contract = contractWithChecks([
      {
        id: "check.duplicate",
        type: "manual",
        prompt: "Review once.",
      },
      {
        id: "check.duplicate",
        type: "manual",
        prompt: "Review twice.",
      },
    ]);

    expect(() => assertValidContract(contract)).toThrow(ContractSemanticError);
  });
});

describe("evaluateContract", () => {
  const contract = contractWithChecks([
    {
      id: "check.command",
      type: "command",
      command: "node --version",
      expect: {
        exitCode: 0,
      },
    },
  ]);

  it("verifies a claim only with qualifying evidence", () => {
    expect(
      evaluateContract({
        contract,
        evidence: [commandEvidence()],
        runId: "run.example",
        evaluatedAt: timestamp,
      }).status,
    ).toBe("verified");
  });

  it("does not accept agent self-report as executed proof", () => {
    const result = evaluateContract({
      contract,
      evidence: [
        commandEvidence({
          trust: "self-reported",
          producer: {
            runtime: "codex",
          },
        }),
      ],
      runId: "run.example",
      evaluatedAt: timestamp,
    });

    expect(result.status).toBe("unverified");
    expect(result.proofGaps).toHaveLength(1);
  });

  it("records observed failures as failures", () => {
    const result = evaluateContract({
      contract,
      evidence: [
        commandEvidence({
          metadata: {
            passed: false,
            reason: "Unexpected exit code: 1.",
          },
        }),
      ],
      runId: "run.example",
      evaluatedAt: timestamp,
    });

    expect(result.status).toBe("failed");
    expect(result.claims[0]?.checkResults[0]?.reason).toContain("exit code");
  });
});

describe("collection and proof packets", () => {
  it("executes command and file checks and produces an intact packet", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "notdone-core-"));
    await writeFile(join(workspaceRoot, "result.txt"), "proof complete\n");
    const contract = contractWithChecks([
      {
        id: "check.command",
        type: "command",
        command: 'node -e "process.stdout.write(\'verified\')"',
        expect: {
          exitCode: 0,
          stdoutIncludes: "verified",
        },
      },
      {
        id: "check.file",
        type: "file",
        path: "result.txt",
        expect: {
          exists: true,
          contains: "proof complete",
        },
      },
    ]);

    const packet = await verifyWorkspace({
      contract,
      runId: "run.integration",
      workspaceRoot,
      now: () => new Date(timestamp),
      evaluatedAt: timestamp,
      runtimeCapabilities: [
        {
          runtime: "codex",
          capabilities: {
            "tool-observation": true,
          },
        },
      ],
    });

    expect(packet.result.status).toBe("verified");
    expect(packet.evidence).toHaveLength(2);
    expect(packet.contractDigest).toBe(sha256Json(contract));
    expect(packet.integrity.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(verifyProofPacketIntegrity(packet)).toBe(true);
    expect(
      verifyProofPacketIntegrity({
        ...packet,
        createdAt: "2026-07-20T06:00:00.000Z",
      }),
    ).toBe(false);
  });

  it("leaves manual checks blocked when no attestation exists", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "notdone-core-"));
    const contract = contractWithChecks([
      {
        id: "check.manual",
        type: "manual",
        prompt: "Confirm the visual result.",
      },
    ]);
    const evidence = await collectEvidence({
      contract,
      runId: "run.manual",
      workspaceRoot,
    });
    const result = evaluateContract({
      contract,
      evidence,
      runId: "run.manual",
      evaluatedAt: timestamp,
    });

    expect(evidence).toEqual([]);
    expect(result.status).toBe("blocked");
  });
});
