# Changelog

All notable changes to NotDone will be documented in this file.

The project follows [Semantic Versioning](https://semver.org/). The first
public release candidate is versioned `0.1.0`.

## Unreleased

## 0.2.0 - 2026-08-02

### Added

- A strict Goal Plan JSON Schema and JIT Task compiler for dependency-ordered,
  machine-readable autonomous work.
- `notdone goal run`, `notdone goal resume`, and `notdone goal validate` while
  preserving `run-next` as the low-level expert workflow.
- A state reconciler and bounded retry controller that preserve every failed
  request and report without weakening acceptance criteria or path limits.
- Verified Workspace Baselines that bind Git revision, predecessor PASS
  reports, immutable task snapshots, workspace digests, and output inventory.
- A Human Evidence Queue with `evidence pending` and explicit, digest-bound
  `evidence submit --attest` reports.
- Published Goal Plan and Workspace Baseline schemas in both npm packages.

### Changed

- Expanded the product from a single-task proof runner to a goal-level
  orchestration harness while retaining all existing verification commands.

## 0.1.1 - 2026-07-25

### Changed

- Published the composable runtime expansion from the validated `main` branch.
- Fixed npm registry ownership checks to accept npm's flattened
  `repository.url` metadata format during idempotent release publication.

## 0.1.0 - 2026-07-25

### Added

- Apache 2.0 project foundation, governance, security, contribution, and
  support policies.
- Complete English, Korean, Japanese, Simplified Chinese, and Traditional
  Chinese guides.
- Runtime-neutral JSON Schemas for task contracts, evidence, runtime events,
  verification results, and proof packets.
- Canonical JSON and SHA-256 integrity validation.
- Deterministic command, file, Git-diff, and manual evidence evaluation.
- `notdone` CLI and `notdone-mcp` stdio server.
- Codex marketplace plugin with `$notdone:verify`, MCP, and lifecycle hooks.
- Claude Code marketplace plugin with `/notdone:verify`, MCP, Stop, and
  TaskCompleted gates.
- Gemini CLI extension with `/notdone`, `/notdone:verify`, MCP, and lifecycle
  hooks.
- Cross-runtime event conformance and sensitive-payload redaction tests.
- Standalone npm tarball builds with clean-install CLI and MCP probes.
- Node.js 22/24 CI, dependency review, release checksums, npm provenance, and
  GitHub build attestations.
- Provider-neutral execution plans, policy-first routing, local lexical
  retrieval, context compilation, and independent verify-only gates.
- Declarative capability Packs, optional local/remote model boundaries, and
  policy-controlled Codex Exec and App Server adapters with fake transport
  coverage.
- CLI visibility for local retrieval, workflow route/egress/verification state,
  backend and Pack discovery, plus a self-contained runtime overview SVG.
