import {
  mkdtemp,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  SCHEMA_VERSION,
  type TaskContract,
} from "@notdone/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createNotDoneMcpServer } from "./mcp-server.js";
import { writeJson } from "./storage.js";

const timestamp = "2026-07-20T05:00:00.000Z";
let workspaceRoot: string;
let client: Client;
let closeServer: (() => Promise<void>) | undefined;

beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), "notdone-mcp-"));
  const initialized = await createNotDoneMcpServer({
    workspaceRoot,
    now: () => new Date(timestamp),
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  client = new Client({
    name: "notdone-test",
    version: "0.0.0",
  });
  await Promise.all([
    initialized.server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  closeServer = async () => {
    await client.close();
    await initialized.server.close();
  };
});

afterEach(async () => {
  await closeServer?.();
});

function contract(): TaskContract {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: "task.mcp",
    title: "Verify through MCP",
    createdAt: timestamp,
    mode: "explicit",
    claims: [
      {
        id: "claim.file",
        statement: "The output exists.",
        required: true,
        checks: [
          {
            id: "check.file",
            type: "file",
            path: "output.txt",
            expect: {
              exists: true,
              contains: "verified",
            },
          },
        ],
      },
    ],
  };
}

function structuredContent(result: Awaited<ReturnType<Client["callTool"]>>) {
  return result.structuredContent as Record<string, unknown>;
}

describe("NotDone MCP server", () => {
  it("publishes the stable NotDone tool surface", async () => {
    const result = await client.listTools();
    expect(result.tools.map((tool) => tool.name).sort()).toEqual([
      "notdone_capabilities",
      "notdone_inspect_proof",
      "notdone_validate_contract",
      "notdone_verify",
    ]);
  });

  it("validates, verifies, and inspects a proof packet", async () => {
    await writeJson(
      join(workspaceRoot, ".notdone/contracts/notdone.json"),
      contract(),
    );
    await writeFile(join(workspaceRoot, "output.txt"), "verified\n");

    const validation = await client.callTool({
      name: "notdone_validate_contract",
      arguments: {},
    });
    expect(validation.isError).not.toBe(true);
    expect(structuredContent(validation)).toMatchObject({
      valid: true,
      contractId: "task.mcp",
    });

    const verification = await client.callTool({
      name: "notdone_verify",
      arguments: {
        runId: "run.mcp",
      },
    });
    expect(verification.isError).not.toBe(true);
    expect(structuredContent(verification)).toMatchObject({
      status: "verified",
      integrity: true,
    });

    const inspection = await client.callTool({
      name: "notdone_inspect_proof",
      arguments: {
        proofPath: ".notdone/proofs/run.mcp.proof.json",
      },
    });
    expect(inspection.isError).not.toBe(true);
    expect(structuredContent(inspection)).toMatchObject({
      status: "verified",
      integrity: true,
      evidenceCount: 1,
    });
  });

  it("rejects paths outside the configured workspace", async () => {
    const result = await client.callTool({
      name: "notdone_validate_contract",
      arguments: {
        contractPath: "../contract.json",
      },
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: expect.stringContaining("escapes the configured workspace"),
        }),
      ]),
    );
  });

  it("rejects symlinks that resolve outside the workspace", async () => {
    const outsideRoot = await mkdtemp(join(tmpdir(), "notdone-outside-"));
    await writeJson(join(outsideRoot, "contract.json"), contract());
    await symlink(
      join(outsideRoot, "contract.json"),
      join(workspaceRoot, "linked-contract.json"),
    );

    const result = await client.callTool({
      name: "notdone_validate_contract",
      arguments: {
        contractPath: "linked-contract.json",
      },
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: expect.stringContaining("escapes the configured workspace"),
        }),
      ]),
    );
  });
});
