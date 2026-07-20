# Claude Code capability profile

## Covered

- Explicit invocation through `/notdone:verify`
- Runtime-neutral validation, verification, and proof inspection over the
  plugin-scoped MCP server
- Session, successful and failed tool, subagent, task-completion, and turn-stop
  lifecycle observation
- Stop-time and task-completion enforcement when
  `.notdone/contracts/notdone.json` exists
- Contract-digest and proof-integrity checks before accepting completion

## Gaps

- Users approve local MCP servers before Claude Code runs them.
- Managed policy can disable non-managed plugin hooks.
- Claude Code forces a turn to stop after repeated Stop-hook blocks to prevent
  an infinite loop.
- A malicious process running as the same OS user can rewrite local hooks,
  contracts, or proof files.
- MCP startup requires `notdone-mcp` on `PATH`.

Hooks improve observation and completion behavior but are not the proof
authority. The verifier's proof packet is authoritative.
