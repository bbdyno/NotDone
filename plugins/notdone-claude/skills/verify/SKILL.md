---
name: verify
description: Verify an AI coding task with NotDone when the user asks to prove, validate, certify, or gate completion; when a .notdone task contract exists; or immediately before claiming that implementation work is complete.
argument-hint: "[contract-path]"
---

# Verify completion with NotDone

Treat NotDone as an independent completion gate. Your narration, summary, or
claim that work is done is not evidence.

## Workflow

1. Use `$ARGUMENTS` as the contract path when supplied. Otherwise use
   `.notdone/contracts/notdone.json`.
2. If the contract does not exist, run `notdone init` only when the user asked
   to create one. Replace the template with claims and checks matching the
   user's acceptance criteria. Ask before freezing criteria that require a
   material product decision.
3. Call the plugin MCP tool `notdone_validate_contract`. Fall back to
   `notdone contract validate --json` only if the MCP server is unavailable.
4. Review every command declared by the contract. Ask before executing an
   untrusted contract.
5. Call `notdone_verify`. Fall back to `notdone verify --json` only if needed.
6. Call `notdone_inspect_proof` for the emitted proof packet.
7. Report the exact status and every proof gap:
   - `verified` means the frozen contract has sufficient passing evidence.
   - `unverified` means qualifying evidence is missing.
   - `blocked` means manual or external evidence is required.
   - `failed` means admitted evidence contradicts a required claim.

Never translate `unverified`, `blocked`, or `failed` into a completion claim.
Do not edit a proof packet or weaken a contract to force a pass.

## Completion gate

The bundled Stop hook checks that a proof is `verified`, matches the current
contract digest, and has a valid packet integrity digest. If it blocks the
turn, resolve the reported proof gaps and invoke `/notdone:verify` again.

Read [references/capabilities.md](references/capabilities.md) when explaining
coverage or diagnosing missing lifecycle events.
