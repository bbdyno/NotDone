# NotDone CLI

`notdone` is the command-line interface for
[NotDone](https://github.com/bbdyno/NotDone), a runtime-neutral
proof-of-completion layer for AI agents.

```sh
npm install --global notdone notdone-mcp
notdone init
notdone verify
```

See the repository README for task contracts, evidence trust levels, exit
codes, and Claude Code, Codex, and Gemini CLI integrations.

## Durable local harness commands

The harness commands keep all durable artifacts outside the target Git
worktree. They accept an explicit target and request so a local wrapper can
choose either path without NotDone knowing anything about the product.

Create a strict request JSON (replace IDs, the baseline SHA, and the task
contract with your own frozen inputs):

```json
{
  "schemaVersion": "1.0",
  "runId": "run.example.001",
  "prompt": "Implement the frozen task contract and do not commit changes.",
  "contract": {
    "schemaVersion": "1.0",
    "id": "task.example",
    "title": "Example task",
    "createdAt": "2026-08-01T12:00:00.000Z",
    "frozenAt": "2026-08-01T12:00:00.000Z",
    "baseRevision": "0123456789012345678901234567890123456789",
    "mode": "explicit",
    "claims": [{
      "id": "claim.example",
      "statement": "The required result is present.",
      "required": true,
      "checks": [{ "id": "check.example", "type": "file", "path": "result.txt", "expect": { "exists": true } }]
    }]
  },
  "plan": {
    "schemaVersion": "1.0",
    "id": "plan.example",
    "createdAt": "2026-08-01T12:00:00.000Z",
    "steps": [{ "schemaVersion": "1.0", "id": "step.codex", "capability": "run", "verificationGateIds": ["gate.local"] }],
    "policy": { "schemaVersion": "1.0", "externalNetwork": "allow", "loopback": "deny", "allowedTools": ["codex-exec"], "approvalRequirement": "none" },
    "verificationGates": [{ "schemaVersion": "1.0", "id": "gate.local", "required": true }]
  }
}
```

```sh
notdone run-next --request ./request.json \
  --target-workspace ./target-repository \
  --artifact-root ./notdone-artifacts --json

notdone status --artifact-root ./notdone-artifacts --run-id run.example.001 --json
notdone show-report --artifact-root ./notdone-artifacts --run-id run.example.001 --json

notdone import-evidence --file ./capture.bin \
  --artifact-root ./notdone-artifacts --run-id run.example.001 \
  --gate-id gate.device --captured-at 2026-08-01T12:00:00Z --json
```

`status` and `show-report` are read-only. Evidence imports store opaque bytes
and never create a PASS report. `VERIFIED` is emitted only after the required
persisted reports are digest-bound to intact evidence bundles and the durable
gate lock is sealed; a Codex completion message is never proof.

## Harness self-test

Run `pnpm test:harness` from the repository root (or `pnpm --filter notdone
test:self`). This deterministic, network-free self-test creates a temporary
Git repository and executable fake Codex process; it never calls a real Codex
CLI or model. It exercises `run-next`, `status`, `show-report`, and
`import-evidence` through the public CLI, verifying the
`AWAITING_DEVICE_EVIDENCE` to `VERIFIED` transition and restart-safe durable
artifacts before removing the fixture.
