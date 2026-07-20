# Gemini CLI integration

The repository root is an installable Gemini CLI extension. It bundles two
native slash commands, an agent skill, a local MCP server, context, and
lifecycle hooks.

## Install

```shell
pnpm install --frozen-lockfile
pnpm build
npm install --global ./packages/cli ./packages/mcp-server
gemini extensions link .
gemini extensions validate .
```

After the v0.1.0 release, install `notdone` and `notdone-mcp` from npm and use
`gemini extensions install https://github.com/bbdyno/NotDone` for a remote
installation.

Restart Gemini CLI after installation or updates so it reloads extension
commands and configuration.

## Invoke

Both entry points run the same proof workflow:

```text
/notdone
/notdone:verify
```

The commands validate the active contract, execute checks through the NotDone
MCP server, inspect proof integrity, and report the exact status.

## Completion gate

`AfterAgent` rejects a final response when an active contract lacks an
integrity-valid verified proof. The retry receives an instruction to invoke
`/notdone:verify`. If the retry still has no proof, the hook stops the loop and
explicitly reports that completion was not verified.

`SessionStart` and `BeforeAgent` inject active-contract context. `AfterTool`
records normalized event metadata and SHA-256 input/output digests without
storing raw tool content.

## Coverage limits

Extension commands have lower precedence than workspace and user commands. If a
command name conflicts, Gemini CLI exposes the extension-prefixed fallback.
Users can disable extension hooks, and a malicious same-user process can alter
local files. The proof packet remains authoritative.
