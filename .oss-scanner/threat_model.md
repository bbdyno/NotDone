# NotDone threat model for automated scanning

This file is for the Anthropic OSS Scanner. The general threat model is in `docs/threat-model.md`; this file adds
where to look, how to run the code, and how we rate severity.

## What NotDone does and where untrusted input enters

NotDone is a proof-of-completion layer for AI coding agents (Claude Code, Codex, Gemini CLI, plain CLI and CI). A
task contract (`.notdone/contracts/notdone.json`) lists acceptance criteria. The verifier runs the contract's
checks, records evidence (command results, files, Git state, logs), and writes a proof packet with SHA-256 digests
over canonical JSON. A completion hook then refuses an agent's "done" unless a proof packet matches the active
contract.

The main promise is that NotDone never reports a required claim as `verified` without evidence that supports it.
A bug that makes the verifier or the hook accept completion that the evidence does not support breaks that promise,
even when no code runs.

Untrusted or partly trusted input:

- **Agent-controlled tool arguments.** Every argument of the MCP tools (`packages/mcp-server`: `notdone_verify`,
  `notdone_validate_contract`, `notdone_inspect_proof`) and of the CLI (`packages/cli`) when an agent runs it:
  contract paths, proof paths, run ids. They are expected to stay inside the workspace.
- **Runtime hook payloads.** JSON on stdin of `hooks/notdone-hook.mjs` (Gemini CLI) and
  `plugins/*/hooks/notdone-hook.mjs` (Claude Code, Codex).
- **Files in the workspace.** Proof packets under `.notdone/proofs/`, evidence files, and symlinks inside the
  workspace. An agent can write these. The verifier and the hook must not accept a packet whose digests do not match
  its contents or the active contract.
- **Command output.** stdout and stderr of contract checks. They may be very large or binary, and must stay within
  the configured output limits.
- **Proof packets from elsewhere.** `notdone proof inspect` and `notdone_inspect_proof` read packets that may come
  from another machine or CI run.

Trusted: the installed NotDone code, the operating system, the frozen contract and the commands it defines, and the
compilers, test runners and dependencies those commands use.

## Components that matter most and least

Most important:

- `packages/core/src/collector.ts`: runs contract commands, enforces timeouts and output limits, resolves evidence
  paths inside the workspace (`resolveWithinWorkspace`, `realpath`), reads Git state.
- `packages/core/src/verify.ts`, `evaluator.ts`, `proof-packet.ts`, `trust.ts`, `semantic-validation.ts`: decide
  `verified`, `unverified`, `blocked` or `failed`, and check proof integrity.
- `packages/protocol/src/canonical-json.ts` and `schemas/`: canonical JSON and schema validation that the digests
  depend on.
- `hooks/notdone-hook.mjs` and `plugins/*/hooks/notdone-hook.mjs`: the completion gate for each runtime.
- `packages/mcp-server/src/storage.ts` and `mcp-server.ts`: path handling for agent-supplied arguments and writes.

Less important but in scope: `packages/cli` (argument parsing, file templates), the skills and manifests under
`plugins/*`.

Out of scope: `scripts/` (release tooling run by the maintainer), `docs/`, `artifacts/`, `.github/`, and third-party
code in `node_modules/`.

## How to exercise it

- The image is built in `/src` with dependencies installed and every package built into `dist/`.
- Run everything: `pnpm typecheck && pnpm test && pnpm test:plugins && pnpm test:conformance`.
- Unit tests per package: `pnpm --filter @notdone/core test`, `pnpm --filter notdone test`,
  `pnpm --filter notdone-mcp test`, `pnpm --filter @notdone/protocol test`.
- CLI: `node packages/cli/dist/bin.js --help`. In a scratch Git repository, `notdone init` writes a sample contract,
  then `notdone verify` and `notdone proof inspect .notdone/proofs/<run-id>.proof.json` run the full flow.
- Hook: `echo '<hook JSON>' | node hooks/notdone-hook.mjs` from inside a workspace that has a contract.
- MCP server: `node packages/mcp-server/dist/index.js` speaks MCP over stdio; the tests in
  `packages/mcp-server/src/mcp-server.test.ts` show how to drive it in process.

## How we rate severity

Critical:

- Code execution that happens without an explicit verify request, for example from loading a contract, from the
  session hook, from `proof inspect`, or from validating a contract.
- Writing a file outside the workspace through an MCP or CLI argument, when the write can lead to code execution
  (for example into shell profiles, Git hooks of another repository, or agent configuration).

High:

- Reading or writing files outside the workspace or the evidence roots through agent-controlled arguments, symlinks
  or `..` segments.
- The verifier or the completion hook reporting a required claim as `verified`, or allowing completion, when a
  required check failed, timed out, was skipped, or when a packet's digests do not match its contents or the active
  contract. This includes canonical JSON ambiguities that let two different packets share a digest.
Medium:

- The completion hook failing open on malformed, oversized or unexpected input.
- Denial of service through command output or files that bypass the configured size limits, or crash the verifier
  instead of producing a `failed` or `blocked` result.
- Shell injection where contract data (not a contract-defined command) reaches a shell.

Low:

- Error messages that reveal paths or environment details beyond what the user already sees.
- Missing validation that has no effect on a verdict, a path or stored data.

## Anything to leave alone

- Running the shell commands a contract defines is intended. `notdone_verify` and `notdone verify` say so. Reporting
  that a malicious contract can run commands is not a finding, unless it happens without an explicit verify request.
- A malicious process with the same user or root permissions that rewrites the verifier, the contract and the
  evidence store, and recomputes every digest, is out of scope for v0.1. Digests prove internal consistency, not who
  wrote the packet; signatures and remote attestation are planned, not shipped.
- Semantic correctness that no deterministic check expresses.
- Secret redaction. The protocol defines a `redactions` field, but the v0.1 collector does not redact output yet.
  Command output stored in a proof packet as is, secrets included, is a known gap, not a finding.
- Vulnerabilities in Node.js, pnpm, npm packages, Git, or the agent runtimes themselves. Report a dependency only
  when NotDone uses it in an unsafe way.
- Release tooling in `scripts/` and the GitHub workflows.
