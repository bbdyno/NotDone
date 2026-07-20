# CLI

The `notdone` command is the runtime-independent entry point. Agent-specific
commands and MCP tools delegate to the same operations.

## Commands

```text
notdone init [contract-path]
notdone contract validate [contract-path] [--json]
notdone evidence collect [contract-path] [--run-id ID] [--output PATH] [--json]
notdone verify [contract-path] [--run-id ID] [--output PATH] [--json]
notdone proof inspect <proof-path> [--json]
```

The default contract is `.notdone/contracts/notdone.json`. Verification writes
proofs under `.notdone/proofs/` unless `--output` is supplied. Evidence-only
collection writes under `.notdone/runs/`.

`--json` keeps stdout machine-readable. Diagnostics go to stderr.

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
