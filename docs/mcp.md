# MCP server

`notdone-mcp` exposes the runtime-neutral verifier over Model Context Protocol
stdio transport. Claude Code, Codex, Gemini CLI, and other MCP clients can use
the same tool surface.

## Tools

| Tool | Behavior |
| --- | --- |
| `notdone_capabilities` | Reports the protocol version and server guarantees. |
| `notdone_validate_contract` | Validates schema and semantic constraints without running checks. |
| `notdone_verify` | Executes declared checks and writes an integrity-protected proof packet. |
| `notdone_inspect_proof` | Validates a stored proof and recomputes its integrity digest. |

## Configuration

Start the server from the repository root:

```json
{
  "command": "notdone-mcp",
  "env": {
    "NOTDONE_WORKSPACE_ROOT": "/absolute/path/to/repository"
  }
}
```

If `NOTDONE_WORKSPACE_ROOT` is omitted, the server freezes its startup working
directory as the workspace boundary. Contract and proof paths outside that
boundary are rejected.

The server uses stdout exclusively for MCP protocol messages. Startup and fatal
diagnostics go to stderr.
