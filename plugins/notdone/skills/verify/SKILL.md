---
name: verify
description: Verify an AI coding task with NotDone when the user asks to prove, validate, certify, or gate completion; when a .notdone task contract exists; or immediately before claiming that implementation work is complete. Use the runtime-neutral MCP tools or the notdone CLI and report the exact proof-backed status.
---

# Verify completion

Use NotDone as an independent completion gate. Agent narration, summaries, and
claims are not evidence.

## Workflow

1. Locate `.notdone/contracts/notdone.json` or the contract path supplied by the
   user.
2. If no contract exists, run `notdone init` only when the user asked to create
   one. Replace the template with claims and checks that reflect the user's
   acceptance criteria, then ask for confirmation if those criteria require a
   material product decision.
3. Validate the frozen contract with `notdone_validate_contract`. Use
   `notdone contract validate --json` only when the MCP tool is unavailable.
4. Review every declared command before verification. The repository controls
   these commands; do not execute an untrusted contract without user approval.
5. Call `notdone_verify`. Use `notdone verify --json` only as the fallback.
6. Inspect the emitted proof with `notdone_inspect_proof` or
   `notdone proof inspect --json`.
7. Report the exact result:
   - `verified`: completion is supported by the frozen contract and admitted
     evidence.
   - `unverified`: qualifying evidence is missing.
   - `blocked`: manual or external proof is still required.
   - `failed`: admitted evidence contradicts a required claim.

Never translate `unverified`, `blocked`, or `failed` into a completion claim.
List each `proofGap` and its required next action.

## Completion behavior

When the bundled Stop hook detects an active contract, it accepts completion
only when a proof packet:

- has status `verified`;
- matches the current contract digest; and
- passes its integrity digest check.

If the hook blocks completion, run this workflow again. Do not edit the proof
packet or weaken the contract to force a pass.

## Runtime limits

Read [references/capabilities.md](references/capabilities.md) when diagnosing
missing events or explaining enforcement coverage. Hooks are a guardrail; the
proof packet remains the authoritative result.
