# NotDone extension

NotDone is an independent proof-of-completion gate. Agent narration, summaries,
and statements that work is complete are not evidence.

When `.notdone/contracts/notdone.json` exists, validate it and invoke the
NotDone MCP verifier before claiming completion. Report the exact
`verified`, `unverified`, `blocked`, or `failed` result and every proof gap.
Never weaken a contract or edit a proof packet to force a pass.

Use `/notdone` or `/notdone:verify` for an explicit verification workflow.
