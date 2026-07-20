<!-- docs-revision: 2 -->

<p align="center">
  <strong>NotDone</strong><br>
  Proof-of-completion for AI agents
</p>

<p align="center">
  <img src="https://img.shields.io/badge/status-v0.1.0--rc-orange" alt="Status: v0.1.0 release candidate">
  <a href="https://github.com/bbdyno/NotDone/actions/workflows/ci.yml"><img src="https://github.com/bbdyno/NotDone/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="License: Apache-2.0"></a>
  <img src="https://img.shields.io/badge/Node.js-%3E%3D22-339933" alt="Node.js 22 or later">
  <img src="https://img.shields.io/badge/Claude_Code-ready-8A2BE2" alt="Claude Code integration ready">
  <img src="https://img.shields.io/badge/Codex-ready-111111" alt="Codex integration ready">
  <img src="https://img.shields.io/badge/Gemini_CLI-ready-4285F4" alt="Gemini CLI integration ready">
  <a href="https://github.com/bbdyno/NotDone/stargazers"><img src="https://img.shields.io/github/stars/bbdyno/NotDone?style=social" alt="GitHub stars"></a>
</p>

<p align="center">
  <strong>English</strong> |
  <a href="README_KO.md">한국어</a> |
  <a href="README_JA.md">日本語</a> |
  <a href="README_ZH-CN.md">简体中文</a> |
  <a href="README_ZH-TW.md">繁體中文</a>
</p>

# NotDone

> Agents say “done.” NotDone asks for proof.

NotDone is a runtime-neutral proof-of-completion layer for AI coding agents. It turns acceptance criteria into a machine-readable contract, captures evidence from real tools, and independently verifies whether an agent has earned the right to call a task complete.

> [!WARNING]
> The v0.1.0 implementation is a release candidate. Source builds, standalone package artifacts, and all three runtime integrations are validated, but the npm packages and GitHub release have not been published from this working copy yet.

## Why NotDone?

AI agents can report success without running the relevant test, confuse a partial change with a complete result, or hide an unverified assumption behind a confident summary. NotDone separates the agent's claim from the evidence that supports it.

- Completion criteria are frozen before verification.
- Model-written completion text is never treated as evidence.
- Commands, exit codes, Git state, files, logs, screenshots, and external state can be recorded.
- Required claims finish as `verified`, `unverified`, `blocked`, or `failed`.
- Proof packets can be checked again without trusting the original agent.

## Supported runtimes

NotDone supports three first-class integrations backed by one common core:

| Runtime | Distribution | Explicit workflow |
| --- | --- | --- |
| Claude Code | Marketplace plugin | `/notdone:verify` |
| Codex | Marketplace plugin and skill | `$notdone:verify` |
| Gemini CLI | Extension and custom commands | `/notdone` or `/notdone:verify` |
| Any shell or CI | CLI | `notdone verify` |

Runtime-specific hooks only normalize events and enforce completion gates. Contract evaluation, evidence storage, hashing, and verification remain in the runtime-neutral core.

## Quick start

### Install from this source checkout

Node.js 22 or later and pnpm 11.9.0 are required.

```shell
git clone https://github.com/bbdyno/NotDone.git
cd NotDone
pnpm install --frozen-lockfile
pnpm build
npm install --global ./packages/cli ./packages/mcp-server
```

### CLI

After the v0.1.0 npm release, install the two standalone packages with:

```shell
npm install --global notdone notdone-mcp
notdone init
notdone contract validate
notdone verify
notdone proof inspect .notdone/proofs/<run-id>.proof.json
```

### Claude Code

From a local source checkout:

```text
/plugin marketplace add .
/plugin install notdone@notdone-marketplace
/notdone:verify
```

After the repository is published, the remote marketplace flow is:

```text
/plugin marketplace add bbdyno/NotDone
/plugin install notdone@notdone-marketplace
/notdone:verify
```

### Codex

From a local source checkout:

```shell
codex plugin marketplace add .
codex plugin add notdone@notdone-marketplace
```

After the repository is published, replace `.` with `bbdyno/NotDone`. Then
explicitly invoke the namespaced skill:

```text
$notdone:verify
```

### Gemini CLI

From a local source checkout:

```shell
gemini extensions link .
gemini extensions validate .
```

After the repository is published, use
`gemini extensions install https://github.com/bbdyno/NotDone`. Both native
commands run the same verification workflow:

```text
/notdone
/notdone:verify
```

## How it works

```text
Task request
    ↓
Frozen task contract
    ↓
Agent work + normalized runtime events
    ↓
Evidence captured by NotDone
    ↓
Deterministic verification
    ↓
Proof packet + report + completion gate
```

A contract links each required claim to one or more checks:

```yaml
id: task-123
title: Fix the login crash
claims:
  - id: regression-test
    statement: The login regression test passes
    required: true
    checks:
      - type: command
        command: npm test -- login-crash
        expect:
          exitCode: 0
```

The resulting proof packet records the frozen contract digest, repository state, evidence metadata, verification results, runtime capabilities, and known proof gaps.

## Trust model

NotDone distinguishes evidence by provenance:

| Level | Meaning |
| --- | --- |
| `self-reported` | The agent only said that something happened; never sufficient |
| `observed` | A runtime hook observed a tool event |
| `executed` | NotDone executed a contract-defined check |
| `reproduced` | An independent verification repeated the check |
| `attested` | A CI or remote verifier signed the result; protocol-defined, but not produced by the local collector |

The local v0.1 implementation targets an honest-but-fallible agent. It detects unsupported completion claims and tampered packets, but does not claim to defeat a malicious process with the same operating-system permissions. See [the threat model](docs/threat-model.md).

## Project status

The v0.1.0 release candidate includes:

- versioned protocol schemas, canonical JSON, and SHA-256 packet integrity;
- deterministic command, file, and Git-diff verification;
- standalone `notdone` CLI and `notdone-mcp` packages;
- native Claude Code, Codex, and Gemini CLI distribution and completion gates;
- schema-backed cross-runtime conformance tests;
- Node.js 22/24 CI, package installation tests, dependency review, release
  checksums, npm provenance, and GitHub build attestations.

Publication of the npm packages and the `v0.1.0` GitHub release is the remaining
release operation. See [ROADMAP.md](ROADMAP.md), [the protocol](docs/protocol.md),
[CLI reference](docs/cli.md), [MCP reference](docs/mcp.md), and
[release procedure](RELEASING.md).

## Verify this checkout

```shell
pnpm check
pnpm pack:release
pnpm pack:verify
```

The first command runs type checks, unit tests, runtime hook tests, conformance,
and documentation/integration checks. The package commands build both npm
tarballs, install them in isolation, probe the CLI and MCP server, and verify
their license contents.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) before proposing a change. Security issues should follow [SECURITY.md](SECURITY.md), not a public issue.

## License

NotDone is licensed under the [Apache License 2.0](LICENSE).
