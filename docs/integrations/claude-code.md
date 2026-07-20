# Claude Code integration

The Claude Code plugin combines a namespaced skill, a plugin-scoped MCP server,
and lifecycle hooks. Verification semantics remain in the runtime-neutral
NotDone core.

## Install

For a local source checkout:

```shell
pnpm install --frozen-lockfile
pnpm build
npm install --global ./packages/cli ./packages/mcp-server
claude plugin marketplace add .
claude plugin install notdone@notdone-marketplace
```

After the v0.1.0 release, install `notdone` and `notdone-mcp` from npm and use
`claude plugin marketplace add bbdyno/NotDone` for the remote marketplace.

Claude Code asks users to approve local MCP servers. Review the `notdone-mcp`
command before enabling it.

## Invoke

```text
/notdone:verify
```

The plugin name provides the `notdone:` namespace. The skill validates the
contract, executes declared checks through the MCP server, inspects the proof,
and reports the exact result.

## Completion gate

When `.notdone/contracts/notdone.json` exists:

- the Stop hook blocks completion without a matching verified proof;
- the TaskCompleted hook prevents tasks from being marked complete without the
  same proof;
- a proof must match the current contract digest and packet integrity digest.

The Stop gate does not interfere while Claude Code reports background tasks or
session schedules still in flight.

Lifecycle events are appended under `.notdone/runs/`. Tool input and output are
represented by SHA-256 digests rather than stored raw.

## Coverage limits

Managed settings can disable non-managed hooks, local MCP servers require
approval, and Claude Code eventually overrides repeatedly blocking Stop hooks
to avoid an infinite loop. These are disclosed capability gaps; a proof packet,
not hook presence alone, remains the completion authority.
