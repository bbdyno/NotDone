# Threat model

## v0.1 objective

NotDone v0.1 protects users from unsupported, mistaken, incomplete, or hallucinated completion claims made by an honest-but-fallible local AI agent.

## Trusted components

- The NotDone core and verifier installed by the user
- The task contract after it is frozen
- The operating system and filesystem
- Contract-defined verification commands and their dependencies

## Untrusted inputs

- Agent-authored completion text
- Agent-authored summaries of tool output
- Runtime-specific event payloads until they are normalized and validated
- Evidence files until their path, size, digest, and provenance are checked
- External state that can change after collection

## In-scope protections

- Detect required claims without sufficient evidence
- Detect failed contract-defined checks
- Detect proof packet and evidence digest mismatches
- Record runtime capability and coverage gaps
- Reject paths outside configured evidence roots
- Redact configured secrets from stored output

## Out-of-scope attacks for v0.1

- A malicious process with the same user or root permissions rewriting the verifier and local evidence store
- A compromised compiler, test runner, operating system, or dependency
- Semantic correctness that no deterministic or human-approved check expresses
- Long-term authenticity without a remote signature or attestation service

Future versions may add CI identity, remote append-only storage, and signed attestations. Those features must strengthen the same protocol rather than redefine local evidence as cryptographic identity.
