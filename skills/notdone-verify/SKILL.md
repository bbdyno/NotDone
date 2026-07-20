---
name: notdone-verify
description: Verify task completion with a frozen NotDone contract and executable evidence. Use when a user asks to prove, validate, certify, or gate completion, or when a .notdone contract exists before the agent finishes.
---

# NotDone verification

Use the `notdone` MCP server to validate the active contract, execute its
declared checks, and inspect the emitted proof packet. Agent claims are not
evidence.

Only report completion for an integrity-valid `verified` proof. For
`unverified`, `blocked`, or `failed`, report every proof gap and the next action.
Do not weaken the contract or modify proof data to manufacture success.
