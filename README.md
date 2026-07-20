<!-- docs-revision: 1 -->

<p align="center">
  <strong>NotDone</strong><br>
  Proof-of-completion for AI agents
</p>

<p align="center">
  <img src="https://img.shields.io/badge/status-pre--alpha-orange" alt="Status: pre-alpha">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="License: Apache-2.0"></a>
  <img src="https://img.shields.io/badge/Claude_Code-planned-8A2BE2" alt="Claude Code integration planned">
  <img src="https://img.shields.io/badge/Codex-planned-111111" alt="Codex integration planned">
  <img src="https://img.shields.io/badge/Gemini_CLI-planned-4285F4" alt="Gemini CLI integration planned">
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
> NotDone is currently pre-alpha. The commands and integrations below describe the target v0.1 experience and are not yet published for installation.

## Why NotDone?

AI agents can report success without running the relevant test, confuse a partial change with a complete result, or hide an unverified assumption behind a confident summary. NotDone separates the agent's claim from the evidence that supports it.

- Completion criteria are frozen before verification.
- Model-written completion text is never treated as evidence.
- Commands, exit codes, Git state, files, logs, screenshots, and external state can be recorded.
- Required claims finish as `verified`, `unverified`, `blocked`, or `failed`.
- Proof packets can be checked again without trusting the original agent.

## Supported runtimes

NotDone targets three first-class integrations backed by one common core:

| Runtime | Distribution | Explicit workflow |
| --- | --- | --- |
| Claude Code | Marketplace plugin | `/notdone:verify` |
| Codex | Marketplace plugin and skill | `$notdone:verify` |
| Gemini CLI | Extension and custom commands | `/notdone` or `/notdone:verify` |
| Any shell or CI | CLI | `notdone verify` |

Runtime-specific hooks only normalize events and enforce completion gates. Contract evaluation, evidence storage, hashing, and verification remain in the runtime-neutral core.

## Target quick start

### CLI

```shell
npm install --global notdone
notdone init
notdone verify
notdone report
```

### Claude Code

```text
/plugin marketplace add bbdyno/NotDone
/plugin install notdone@notdone-marketplace
/notdone:verify
```

### Codex

```shell
codex plugin marketplace add bbdyno/NotDone
codex plugin add notdone@notdone-marketplace
```

Then explicitly mention the workflow:

```text
$notdone:verify
```

### Gemini CLI

```shell
gemini extensions install https://github.com/bbdyno/NotDone
```

Then run:

```text
/notdone
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
| `attested` | A CI or remote verifier signed the result; planned after v0.1 |

The local v0.1 target is an honest-but-fallible agent. It detects unsupported completion claims and tampered packets, but does not claim to defeat a malicious process with the same operating-system permissions. See [the threat model](docs/threat-model.md).

## Project status

The implementation is proceeding in independently verifiable stages:

1. Protocol schemas and canonical digests
2. Core evidence and verification engine
3. CLI and MCP server
4. Codex, Claude Code, and Gemini CLI adapters
5. Cross-runtime conformance tests
6. Reproducible v0.1 release artifacts

See [ROADMAP.md](ROADMAP.md) for the current scope.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) before proposing a change. Security issues should follow [SECURITY.md](SECURITY.md), not a public issue.

## License

NotDone is licensed under the [Apache License 2.0](LICENSE).
