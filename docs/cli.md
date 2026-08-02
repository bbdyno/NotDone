# CLI

The `notdone` command is the runtime-independent entry point. Agent-specific
commands and MCP tools delegate to the same operations.

## Install

To build and install from a source checkout:

```shell
pnpm install --frozen-lockfile
pnpm build
npm install --global ./packages/cli ./packages/mcp-server
notdone --version
```

After publication, use `npm install --global notdone notdone-mcp`.

## Commands

```text
notdone init [contract-path]
notdone contract validate [contract-path] [--json]
notdone evidence collect [contract-path] [--run-id ID] [--output PATH] [--json]
notdone verify [contract-path] [--run-id ID] [--output PATH] [--json]
notdone proof inspect <proof-path> [--json]
notdone goal validate [--plan PATH] [--json]
notdone goal run [--plan PATH] [--target-workspace PATH] [--artifact-root PATH] [--until human-evidence|complete] [--max-retries N] [--json]
notdone goal resume [--plan PATH] [--target-workspace PATH] [--artifact-root PATH] [--until human-evidence|complete] [--max-retries N] [--json]
notdone evidence pending [--plan PATH] [--target-workspace PATH] [--artifact-root PATH] [--json]
notdone evidence submit --task-id ID --requirement-id ID --file PATH --captured-at ISO-8601 --attest [--plan PATH] [--target-workspace PATH] [--artifact-root PATH] [--media-type TYPE] [--sha256 DIGEST] [--json]
notdone --version
```

The default contract is `.notdone/contracts/notdone.json`. Verification writes
proofs under `.notdone/proofs/` unless `--output` is supplied. Evidence-only
collection writes under `.notdone/runs/`.

`--json` keeps stdout machine-readable. Diagnostics go to stderr.

## Goal orchestration

The default Goal Plan is `.notdone/goal.json`. It is validated against
[`goal-plan.schema.json`](../schemas/goal-plan.schema.json); Markdown task lists
are documentation, not executable state. `goal run` and `goal resume` share the
same restart-safe loop:

```text
reconcile reports → select ready Task → compile and freeze request → run-next
→ verify → retry, queue human evidence, or save successor baseline → continue
```

Every retry gets a new run ID while preserving the original acceptance
criteria, verifier gates, allowed paths, and verification baseline. Repeated
failures, forbidden-path changes, ambiguous preflight state, and exhausted
limits return control to a person.

Successor baselines conform to
[`workspace-baseline.schema.json`](../schemas/workspace-baseline.schema.json).
They bind the Git revision, predecessor PASS report IDs, immutable task
snapshot digest, workspace digest, and output file inventory. This permits
verified, uncommitted output to flow into a dependent Task.

`evidence pending` lists only gates requiring a person. `evidence submit`
imports an opaque file and, only when `--attest` is present, appends an explicit
human PASS report bound to that exact evidence bundle digest. Run `goal resume`
after all pending items have been attested.

The default artifact root is a hidden sibling named
`.<repository>.notdone-artifacts`; it never lives inside the target worktree.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Verification succeeded, or a non-verification command succeeded. |
| 1 | Input, usage, schema, integrity, or runtime error. |
| 2 | Required proof is missing. |
| 3 | Verification is blocked on a manual or external condition. |
| 4 | Collected evidence shows that a required check failed. |

Contracts execute commands declared by the repository. Review untrusted
contracts before running `notdone verify`.
