<!-- docs-revision: 2 -->

<p align="center">
  <strong>NotDone</strong><br>
  AI 에이전트를 위한 완료 증명
</p>

<p align="center">
  <img src="https://img.shields.io/badge/status-v0.1.0--rc-orange" alt="상태: v0.1.0 릴리스 후보">
  <a href="https://github.com/bbdyno/NotDone/actions/workflows/ci.yml"><img src="https://github.com/bbdyno/NotDone/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="라이선스: Apache-2.0"></a>
  <img src="https://img.shields.io/badge/Node.js-%3E%3D22-339933" alt="Node.js 22 이상">
  <img src="https://img.shields.io/badge/Claude_Code-ready-8A2BE2" alt="Claude Code 연동 준비 완료">
  <img src="https://img.shields.io/badge/Codex-ready-111111" alt="Codex 연동 준비 완료">
  <img src="https://img.shields.io/badge/Gemini_CLI-ready-4285F4" alt="Gemini CLI 연동 준비 완료">
  <a href="https://github.com/bbdyno/NotDone/stargazers"><img src="https://img.shields.io/github/stars/bbdyno/NotDone?style=social" alt="GitHub stars"></a>
</p>

<p align="center">
  <a href="README.md">English</a> |
  <strong>한국어</strong> |
  <a href="README_JA.md">日本語</a> |
  <a href="README_ZH-CN.md">简体中文</a> |
  <a href="README_ZH-TW.md">繁體中文</a>
</p>

# NotDone

> 에이전트는 “완료”라고 말합니다. NotDone은 증거를 요구합니다.

NotDone은 AI 코딩 에이전트를 위한 런타임 중립 완료 증명 계층입니다. 완료 조건을 기계가 읽을 수 있는 계약으로 고정하고, 실제 도구에서 증거를 수집한 뒤 에이전트가 작업을 완료했다고 말할 자격이 있는지 독립적으로 검증합니다.

> [!WARNING]
> v0.1.0 구현은 릴리스 후보 상태입니다. 소스 빌드, 독립 패키지 아티팩트, 세 런타임 연동 검증은 완료했지만 이 작업 사본에서는 아직 npm 패키지와 GitHub 릴리스를 공개하지 않았습니다.

## 왜 필요한가요?

AI 에이전트는 관련 테스트를 실행하지 않고 성공을 보고하거나, 일부 변경을 전체 완료로 오해하거나, 검증하지 않은 가정을 확신에 찬 요약으로 감출 수 있습니다. NotDone은 에이전트의 주장과 그 주장을 뒷받침하는 증거를 분리합니다.

- 검증 전에 완료 조건을 고정합니다.
- 모델이 작성한 완료 문장은 증거로 인정하지 않습니다.
- 명령, 종료 코드, Git 상태, 파일, 로그, 스크린샷, 외부 상태를 기록합니다.
- 필수 주장을 `verified`, `unverified`, `blocked`, `failed`로 판정합니다.
- 원래 에이전트를 신뢰하지 않고도 proof packet을 다시 검증할 수 있습니다.

## 지원 런타임

| 런타임 | 배포 방식 | 명시적 호출 |
| --- | --- | --- |
| Claude Code | Marketplace plugin | `/notdone:verify` |
| Codex | Marketplace plugin과 skill | `$notdone:verify` |
| Gemini CLI | Extension과 custom command | `/notdone` 또는 `/notdone:verify` |
| 일반 shell/CI | CLI | `notdone verify` |

런타임별 hook은 이벤트 정규화와 완료 게이트만 담당합니다. 계약 판정, 증거 저장, 해시, 검증은 공통 코어가 수행합니다.

## 빠른 시작

### 현재 소스 체크아웃에서 설치

Node.js 22 이상과 pnpm 11.9.0이 필요합니다.

```shell
git clone https://github.com/bbdyno/NotDone.git
cd NotDone
pnpm install --frozen-lockfile
pnpm build
npm install --global ./packages/cli ./packages/mcp-server
```

### CLI

v0.1.0 npm 릴리스 후에는 두 독립 패키지를 다음과 같이 설치합니다.

```shell
npm install --global notdone notdone-mcp
notdone init
notdone contract validate
notdone verify
notdone proof inspect .notdone/proofs/<run-id>.proof.json
```

### Claude Code

로컬 소스 체크아웃에서는 다음 명령을 사용합니다.

```text
/plugin marketplace add .
/plugin install notdone@notdone-marketplace
/notdone:verify
```

저장소가 공개된 뒤 원격 marketplace를 사용하는 흐름은 다음과 같습니다.

```text
/plugin marketplace add bbdyno/NotDone
/plugin install notdone@notdone-marketplace
/notdone:verify
```

### Codex

로컬 소스 체크아웃에서는 다음 명령을 사용합니다.

```shell
codex plugin marketplace add .
codex plugin add notdone@notdone-marketplace
```

저장소가 공개된 뒤에는 `.`을 `bbdyno/NotDone`으로 바꿉니다. 설치 후
namespaced skill을 명시적으로 호출합니다.

```text
$notdone:verify
```

### Gemini CLI

로컬 소스 체크아웃에서는 다음 명령을 사용합니다.

```shell
gemini extensions link .
gemini extensions validate .
```

저장소가 공개된 뒤에는
`gemini extensions install https://github.com/bbdyno/NotDone`을 사용합니다.
두 네이티브 명령은 같은 검증 흐름을 실행합니다.

```text
/notdone
/notdone:verify
```

## 동작 방식

```text
사용자 요청
    ↓
고정된 작업 계약
    ↓
에이전트 작업 + 정규화된 런타임 이벤트
    ↓
NotDone 증거 수집
    ↓
결정적 검증
    ↓
Proof packet + 보고서 + 완료 게이트
```

계약은 각 필수 주장과 검증 방법을 연결합니다.

```yaml
id: task-123
title: 로그인 크래시 수정
claims:
  - id: regression-test
    statement: 로그인 회귀 테스트가 통과한다
    required: true
    checks:
      - type: command
        command: npm test -- login-crash
        expect:
          exitCode: 0
```

## 신뢰 모델

| 등급 | 의미 |
| --- | --- |
| `self-reported` | 에이전트가 텍스트로만 주장함. 완료 증거로 사용하지 않음 |
| `observed` | 런타임 hook이 도구 이벤트를 관찰함 |
| `executed` | NotDone이 계약에 정의된 검증을 실행함 |
| `reproduced` | 독립 검증에서 같은 검증을 다시 수행함 |
| `attested` | CI 또는 원격 검증자가 결과에 서명함. 프로토콜에는 정의되어 있지만 로컬 수집기는 아직 생성하지 않음 |

로컬 v0.1 구현은 정직하지만 실수할 수 있는 에이전트를 대상으로 합니다. 근거 없는 완료 주장과 proof packet 변조는 탐지하지만, 같은 운영체제 권한을 가진 악성 프로세스를 완전히 방어한다고 주장하지 않습니다. 자세한 내용은 [위협 모델](docs/threat-model.md)을 참고하세요.

## 프로젝트 상태

v0.1.0 릴리스 후보에는 다음 기능이 포함되어 있습니다.

- 버전이 부여된 protocol schema, canonical JSON, SHA-256 packet integrity
- 결정적인 command, file, Git diff 검증
- 독립 실행 가능한 `notdone` CLI와 `notdone-mcp` 패키지
- Claude Code, Codex, Gemini CLI 네이티브 배포와 완료 게이트
- schema 기반 cross-runtime conformance 테스트
- Node.js 22/24 CI, 패키지 설치 테스트, 의존성 검토, 릴리스 checksum,
  npm provenance, GitHub build attestation

남은 릴리스 작업은 npm 패키지와 `v0.1.0` GitHub 릴리스 공개입니다. 자세한
내용은 [ROADMAP.md](ROADMAP.md), [프로토콜](docs/protocol.md),
[CLI 레퍼런스](docs/cli.md), [MCP 레퍼런스](docs/mcp.md),
[릴리스 절차](RELEASING.md)를 참고하세요.

## 현재 체크아웃 검증

```shell
pnpm check
pnpm pack:release
pnpm pack:verify
```

첫 번째 명령은 type check, unit test, 런타임 hook test, conformance,
문서·연동 검사를 실행합니다. 패키지 명령은 두 npm tarball을 빌드하고 격리된
환경에 설치한 뒤 CLI와 MCP server 응답 및 라이선스 포함 여부를 확인합니다.

## 기여 및 라이선스

기여 전에 [CONTRIBUTING.md](CONTRIBUTING.md)를 읽어주세요. 보안 문제는 공개 이슈 대신 [SECURITY.md](SECURITY.md)의 절차를 따라주세요.

NotDone은 [Apache License 2.0](LICENSE)으로 배포됩니다.
