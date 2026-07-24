# Codex integration

The Codex plugin combines an explicit skill, a local MCP server, and lifecycle
hooks. All three delegate verification semantics to the runtime-neutral
NotDone protocol.

## Install

Install the CLI and MCP executable, then add this repository as a marketplace:

```shell
pnpm install --frozen-lockfile
pnpm build
npm install --global ./packages/cli ./packages/mcp-server
codex plugin marketplace add .
codex plugin add notdone@notdone-marketplace
```

Install `notdone` and `notdone-mcp` from npm and
replace `.` with `bbdyno/NotDone`.

Open `/hooks` in Codex and review the plugin hook definition. Codex does not run
new or changed non-managed hooks until the user trusts their current hash.

## Invoke

Explicitly invoke the namespaced skill:

```text
$notdone:verify
```

The skill validates the active contract, calls the bundled `notdone` MCP
server, writes a proof packet, checks packet integrity, and reports the exact
verification status.

## Completion gate

When `.notdone/contracts/notdone.json` exists, the Stop hook requires a proof
that is:

- `verified`;
- bound to the current contract digest; and
- protected by a valid packet integrity digest.

Session, local tool, subagent, and completion-attempt events are appended under
`.notdone/runs/`. Raw tool input and output are not stored by the hook; only
their SHA-256 digests are recorded.

## Coverage limits

Codex local tool hooks cover shell, patch, MCP, and most local function calls.
Hosted tools and specialized tool paths may not use the same hook path. Hook
trust can also be disabled by policy. The plugin therefore describes hooks as
a guardrail and treats the verifier's proof packet as the authoritative result.

See the bundled `$notdone:verify` capability reference for the maintained
coverage matrix.
