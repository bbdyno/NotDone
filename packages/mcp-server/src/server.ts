#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createNotDoneMcpServer } from "./mcp-server.js";

export async function main(): Promise<void> {
  const { server } = await createNotDoneMcpServer({
    workspaceRoot: process.env.NOTDONE_WORKSPACE_ROOT ?? process.cwd(),
  });
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  process.stderr.write(
    `notdone-mcp: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
