# ADR 0001: Runtime-neutral verification core

- Status: accepted
- Date: 2026-07-20

## Context

NotDone must support Claude Code, Codex, and Gemini CLI without making any one runtime's hook model the protocol.

## Decision

Keep task contracts, evidence, verification results, proof packets, canonicalization, and policy evaluation in a runtime-neutral core. Adapters normalize native hook events, expose native invocation surfaces, and translate completion-gate responses.

Use command hooks and MCP as the lowest common integration layer. Runtime-specific model or agent hooks may enhance usability but cannot be required for correctness.

## Consequences

- Every adapter must declare its capabilities.
- Missing hook coverage must be recorded instead of silently treated as verified.
- The core can run from a shell or CI without any agent runtime.
