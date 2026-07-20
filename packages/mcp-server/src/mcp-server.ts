import { randomUUID } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  assertValidContract,
  verifyProofPacketIntegrity,
  verifyWorkspace,
} from "@notdone/core";
import {
  assertProofPacket,
  type ProofPacket,
  type TaskContract,
} from "@notdone/protocol";
import * as z from "zod/v4";

import {
  canonicalWorkspaceRoot,
  readJson,
  resolveExistingWorkspacePath,
  resolveOutputWorkspacePath,
  writeJson,
} from "./storage.js";

const DEFAULT_CONTRACT_PATH = ".notdone/contracts/notdone.json";

export interface NotDoneMcpServerOptions {
  workspaceRoot: string;
  now?: () => Date;
}

interface InitializedServer {
  server: McpServer;
  workspaceRoot: string;
}

function generatedRunId(now: Date): string {
  const timestamp = now.toISOString().replaceAll(/[^0-9]/g, "").slice(0, 17);
  return `run.${timestamp}.${randomUUID().slice(0, 8)}`;
}

function textResult(value: Record<string, unknown>) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
    structuredContent: value,
  };
}

function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: message,
      },
    ],
  };
}

async function loadContract(
  workspaceRoot: string,
  requestedPath: string,
): Promise<{ contract: TaskContract; path: string }> {
  const path = await resolveExistingWorkspacePath(
    workspaceRoot,
    requestedPath,
  );
  const value = await readJson(path);
  assertValidContract(value);
  return {
    contract: value,
    path,
  };
}

function proofSummary(packet: ProofPacket, path: string) {
  return {
    valid: true,
    integrity: verifyProofPacketIntegrity(packet),
    path,
    runId: packet.runId,
    contractId: packet.contract.id,
    status: packet.result.status,
    evidenceCount: packet.evidence.length,
    proofGaps: packet.result.proofGaps ?? [],
  };
}

export async function createNotDoneMcpServer({
  workspaceRoot: requestedWorkspaceRoot,
  now = () => new Date(),
}: NotDoneMcpServerOptions): Promise<InitializedServer> {
  const workspaceRoot = await canonicalWorkspaceRoot(requestedWorkspaceRoot);
  const server = new McpServer(
    {
      name: "notdone",
      version: "0.1.0",
    },
    {
      instructions:
        "Validate a task contract before verification. The verify tool executes repository-defined commands. Treat completion as verified only when the returned status is verified and the proof packet passes integrity inspection.",
    },
  );

  server.registerTool(
    "notdone_capabilities",
    {
      title: "Describe NotDone capabilities",
      description:
        "Return the protocol version, available operations, and configured workspace boundary.",
      inputSchema: {},
    },
    async () =>
      textResult({
        protocolVersion: "1.0",
        workspaceRoot,
        operations: [
          "validate-contract",
          "verify",
          "inspect-proof",
        ],
        guarantees: {
          "self-report-is-proof": false,
          "workspace-path-boundary": true,
          "proof-integrity-check": true,
        },
      }),
  );

  server.registerTool(
    "notdone_validate_contract",
    {
      title: "Validate a NotDone task contract",
      description:
        "Validate the JSON Schema and semantic constraints of a task contract without executing checks.",
      inputSchema: {
        contractPath: z
          .string()
          .default(DEFAULT_CONTRACT_PATH)
          .describe("Workspace-relative path to the task contract."),
      },
    },
    async ({ contractPath }) => {
      try {
        const { contract, path } = await loadContract(
          workspaceRoot,
          contractPath,
        );
        return textResult({
          valid: true,
          path,
          contractId: contract.id,
          claims: contract.claims.length,
          checks: contract.claims.reduce(
            (count, claim) => count + claim.checks.length,
            0,
          ),
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "notdone_verify",
    {
      title: "Verify a NotDone task contract",
      description:
        "Execute automatic checks from a validated contract, evaluate admitted evidence, and write an integrity-protected proof packet. This may run repository-defined shell commands.",
      inputSchema: {
        contractPath: z
          .string()
          .default(DEFAULT_CONTRACT_PATH)
          .describe("Workspace-relative path to the task contract."),
        runId: z
          .string()
          .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/)
          .optional()
          .describe("Stable run identifier. Generated when omitted."),
        proofPath: z
          .string()
          .optional()
          .describe(
            "Workspace-relative proof output path. Defaults under .notdone/proofs.",
          ),
      },
    },
    async ({ contractPath, runId: requestedRunId, proofPath }) => {
      try {
        const { contract } = await loadContract(workspaceRoot, contractPath);
        const runId = requestedRunId ?? generatedRunId(now());
        const evaluatedAt = now().toISOString();
        const packet = await verifyWorkspace({
          contract,
          runId,
          workspaceRoot,
          now,
          evaluatedAt,
        });
        const path = await resolveOutputWorkspacePath(
          workspaceRoot,
          proofPath ?? `.notdone/proofs/${runId}.proof.json`,
        );
        await writeJson(path, packet);
        return textResult({
          runId,
          status: packet.result.status,
          proofPath: path,
          integrity: verifyProofPacketIntegrity(packet),
          proofGaps: packet.result.proofGaps ?? [],
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "notdone_inspect_proof",
    {
      title: "Inspect a NotDone proof packet",
      description:
        "Validate a proof packet, recompute its integrity digest, and return a compact status summary.",
      inputSchema: {
        proofPath: z
          .string()
          .describe("Workspace-relative path to a proof packet."),
      },
    },
    async ({ proofPath }) => {
      try {
        const path = await resolveExistingWorkspacePath(
          workspaceRoot,
          proofPath,
        );
        const value = await readJson(path);
        assertProofPacket(value);
        const summary = proofSummary(value, path);
        if (!summary.integrity) {
          throw new Error(`Proof packet integrity check failed: ${path}`);
        }
        return textResult(summary);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  return {
    server,
    workspaceRoot,
  };
}
