<!-- docs-revision: 1 -->

<p align="center">
  <strong>NotDone</strong><br>
  提供給 AI 代理程式的完成證明
</p>

<p align="center">
  <img src="https://img.shields.io/badge/status-pre--alpha-orange" alt="狀態: pre-alpha">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="授權條款: Apache-2.0"></a>
  <img src="https://img.shields.io/badge/Claude_Code-planned-8A2BE2" alt="預計支援 Claude Code">
  <img src="https://img.shields.io/badge/Codex-planned-111111" alt="預計支援 Codex">
  <img src="https://img.shields.io/badge/Gemini_CLI-planned-4285F4" alt="預計支援 Gemini CLI">
  <a href="https://github.com/bbdyno/NotDone/stargazers"><img src="https://img.shields.io/github/stars/bbdyno/NotDone?style=social" alt="GitHub stars"></a>
</p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README_KO.md">한국어</a> |
  <a href="README_JA.md">日本語</a> |
  <a href="README_ZH-CN.md">简体中文</a> |
  <strong>繁體中文</strong>
</p>

# NotDone

> 代理程式說「完成了」，NotDone 要求它提出證據。

NotDone 是提供給 AI 程式開發代理程式的執行環境中立完成證明層。它會把驗收條件凍結為機器可讀的合約，從實際工具收集證據，並獨立判定代理程式是否有資格宣稱工作已完成。

> [!WARNING]
> 目前仍是 pre-alpha。以下指令與整合方式描述的是 v0.1 目標體驗，尚未發布為可安裝產品。

## 為什麼需要 NotDone？

AI 代理程式可能在沒有執行相關測試時回報成功、把部分修改誤認為完整結果，或以充滿信心的摘要掩蓋尚未驗證的假設。NotDone 會把代理程式的聲明與支援該聲明的證據分開處理。

- 在驗證前凍結完成條件。
- 不把模型產生的完成文字視為證據。
- 記錄指令、結束碼、Git 狀態、檔案、日誌、螢幕截圖與外部狀態。
- 將必要聲明判定為 `verified`、`unverified`、`blocked` 或 `failed`。
- 不必信任原始代理程式，也能重新驗證 proof packet。

## 支援的執行環境

| 執行環境 | 發布方式 | 明確呼叫 |
| --- | --- | --- |
| Claude Code | Marketplace plugin | `/notdone:verify` |
| Codex | Marketplace plugin 與 skill | `$notdone:verify` |
| Gemini CLI | Extension 與 custom command | `/notdone` 或 `/notdone:verify` |
| 任意 shell/CI | CLI | `notdone verify` |

各執行環境的 hook 只負責事件正規化與完成閘門。合約評估、證據儲存、雜湊與驗證均由共用核心處理。

## 目標 Quickstart

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

## 運作方式

```text
工作需求
    ↓
凍結的工作合約
    ↓
代理程式執行 + 正規化執行環境事件
    ↓
NotDone 收集證據
    ↓
決定性驗證
    ↓
Proof packet + 報告 + 完成閘門
```

```yaml
id: task-123
title: 修正登入崩潰
claims:
  - id: regression-test
    statement: 登入回歸測試通過
    required: true
    checks:
      - type: command
        command: npm test -- login-crash
        expect:
          exitCode: 0
```

## 信任模型

| 等級 | 意義 |
| --- | --- |
| `self-reported` | 只有代理程式的文字聲明，不可作為完成證據 |
| `observed` | 執行環境 hook 觀察到工具事件 |
| `executed` | NotDone 執行合約中定義的檢查 |
| `reproduced` | 獨立驗證重新執行相同檢查 |
| `attested` | CI 或遠端驗證器簽署結果，預計於 v0.1 之後支援 |

本機 v0.1 的目標是誠實但可能犯錯的代理程式。它會偵測缺乏根據的完成聲明與遭竄改的 proof packet，但不宣稱能完全抵禦擁有相同作業系統權限的惡意程序。詳情請參閱[威脅模型](docs/threat-model.md)。

## 專案狀態

1. Protocol schema 與 canonical digest
2. Core evidence/verifier
3. CLI 與 MCP server
4. Codex、Claude Code、Gemini CLI adapter
5. Cross-runtime conformance
6. 可重現的 v0.1 發布

目前範圍請參閱 [ROADMAP.md](ROADMAP.md)。

## 貢獻與授權

提出變更前請閱讀 [CONTRIBUTING.md](CONTRIBUTING.md)。安全性問題請依照 [SECURITY.md](SECURITY.md) 私下回報，不要建立公開 Issue。

NotDone 採用 [Apache License 2.0](LICENSE)。
