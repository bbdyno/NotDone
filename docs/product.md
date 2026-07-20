# Product definition

NotDone is a runtime-neutral proof-of-completion layer for AI coding agents.

## Product promise

An agent cannot earn a `verified` result from its own completion text. A verified result must be derived from a frozen task contract and admitted evidence with sufficient provenance.

## First-class runtimes

- Claude Code
- Codex
- Gemini CLI

All runtimes use the same protocol and verifier. Native plugins, extensions, skills, commands, hooks, and MCP configuration are adapters around that core.

## Result states

- `verified`: every required claim has sufficient passing evidence;
- `unverified`: at least one required claim lacks sufficient evidence;
- `blocked`: verification could not be completed because of an external condition;
- `failed`: admitted evidence contradicts a required claim or a required check failed.
