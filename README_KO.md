<!-- docs-revision: 1 -->

<p align="center">
  <strong>NotDone</strong><br>
  AI 에이전트를 위한 완료 증명
</p>

<p align="center">
  <img src="https://img.shields.io/badge/status-pre--alpha-orange" alt="상태: pre-alpha">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="라이선스: Apache-2.0"></a>
  <img src="https://img.shields.io/badge/Claude_Code-planned-8A2BE2" alt="Claude Code 연동 예정">
  <img src="https://img.shields.io/badge/Codex-planned-111111" alt="Codex 연동 예정">
  <img src="https://img.shields.io/badge/Gemini_CLI-planned-4285F4" alt="Gemini CLI 연동 예정">
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
> 현재 pre-alpha 단계입니다. 아래 명령과 연동 방식은 v0.1 목표 사용성이며 아직 설치 가능한 형태로 배포되지 않았습니다.

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

## 목표 Quickstart

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

```text
$notdone:verify
```

### Gemini CLI

```shell
gemini extensions install https://github.com/bbdyno/NotDone
```

```text
/notdone
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
| `attested` | CI 또는 원격 검증자가 결과에 서명함. v0.1 이후 예정 |

로컬 v0.1은 정직하지만 실수할 수 있는 에이전트를 대상으로 합니다. 근거 없는 완료 주장과 proof packet 변조는 탐지하지만, 같은 운영체제 권한을 가진 악성 프로세스를 완전히 방어한다고 주장하지 않습니다. 자세한 내용은 [위협 모델](docs/threat-model.md)을 참고하세요.

## 프로젝트 상태

1. Protocol schema와 canonical digest
2. Core evidence/verifier
3. CLI와 MCP server
4. Codex, Claude Code, Gemini CLI adapter
5. Cross-runtime conformance
6. 재현 가능한 v0.1 릴리스

현재 범위는 [ROADMAP.md](ROADMAP.md)에 정리되어 있습니다.

## 기여 및 라이선스

기여 전에 [CONTRIBUTING.md](CONTRIBUTING.md)를 읽어주세요. 보안 문제는 공개 이슈 대신 [SECURITY.md](SECURITY.md)의 절차를 따라주세요.

NotDone은 [Apache License 2.0](LICENSE)으로 배포됩니다.
