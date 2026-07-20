# Codex capability profile

## Covered

- Explicit invocation through `$notdone:verify`
- Runtime-neutral validation, verification, and proof inspection over MCP
- Session start, local tool completion, subagent completion, and turn stop
  observation through plugin hooks
- Stop-time enforcement when `.notdone/contracts/notdone.json` exists
- Contract-digest and proof-integrity checks before accepting completion

## Gaps

- Codex requires the user to review and trust non-managed plugin hooks.
- Hosted tools such as web search do not use the local tool-hook path.
- Specialized tools may opt out of the default hook path.
- A malicious process running as the same OS user can rewrite local hooks,
  contracts, or proof files.
- MCP startup requires `notdone-mcp` to be installed and available on `PATH`.

Treat tool hooks as observation coverage, not as a complete security boundary.
NotDone records these limitations instead of presenting unsupported coverage as
proof.
