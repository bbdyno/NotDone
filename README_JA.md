<!-- docs-revision: 1 -->

<p align="center">
  <strong>NotDone</strong><br>
  AI エージェントのための完了証明
</p>

<p align="center">
  <img src="https://img.shields.io/badge/status-pre--alpha-orange" alt="ステータス: pre-alpha">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="ライセンス: Apache-2.0"></a>
  <img src="https://img.shields.io/badge/Claude_Code-planned-8A2BE2" alt="Claude Code 対応予定">
  <img src="https://img.shields.io/badge/Codex-planned-111111" alt="Codex 対応予定">
  <img src="https://img.shields.io/badge/Gemini_CLI-planned-4285F4" alt="Gemini CLI 対応予定">
  <a href="https://github.com/bbdyno/NotDone/stargazers"><img src="https://img.shields.io/github/stars/bbdyno/NotDone?style=social" alt="GitHub stars"></a>
</p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README_KO.md">한국어</a> |
  <strong>日本語</strong> |
  <a href="README_ZH-CN.md">简体中文</a> |
  <a href="README_ZH-TW.md">繁體中文</a>
</p>

# NotDone

> エージェントは「完了」と言います。NotDone は証拠を求めます。

NotDone は、AI コーディングエージェント向けのランタイム中立な完了証明レイヤーです。完了条件を機械可読な契約として固定し、実際のツールから証拠を収集して、エージェントがタスクを完了したと言えるかを独立して検証します。

> [!WARNING]
> 現在は pre-alpha です。以下のコマンドと連携方法は v0.1 の目標であり、まだインストール可能な状態では公開されていません。

## なぜ NotDone なのか

AI エージェントは、必要なテストを実行せずに成功を報告したり、部分的な変更を完了と誤認したり、未検証の前提を自信のある要約で覆い隠すことがあります。NotDone はエージェントの主張と、それを裏付ける証拠を分離します。

- 検証前に完了条件を固定します。
- モデルが書いた完了メッセージを証拠として扱いません。
- コマンド、終了コード、Git 状態、ファイル、ログ、スクリーンショット、外部状態を記録します。
- 必須 claim を `verified`、`unverified`、`blocked`、`failed` に分類します。
- 元のエージェントを信頼せずに proof packet を再検証できます。

## 対応ランタイム

| ランタイム | 配布方法 | 明示的な呼び出し |
| --- | --- | --- |
| Claude Code | Marketplace plugin | `/notdone:verify` |
| Codex | Marketplace plugin と skill | `$notdone:verify` |
| Gemini CLI | Extension と custom command | `/notdone` または `/notdone:verify` |
| 任意の shell/CI | CLI | `notdone verify` |

ランタイム固有の hook はイベント正規化と完了ゲートだけを担当し、契約評価、証拠保存、ハッシュ、検証は共通コアが行います。

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

## 仕組み

```text
タスク要求
    ↓
固定されたタスク契約
    ↓
エージェント作業 + 正規化されたランタイムイベント
    ↓
NotDone による証拠収集
    ↓
決定的な検証
    ↓
Proof packet + レポート + 完了ゲート
```

```yaml
id: task-123
title: ログインクラッシュを修正
claims:
  - id: regression-test
    statement: ログイン回帰テストが成功する
    required: true
    checks:
      - type: command
        command: npm test -- login-crash
        expect:
          exitCode: 0
```

## 信頼モデル

| レベル | 意味 |
| --- | --- |
| `self-reported` | エージェントの文章だけ。完了証拠には使用しない |
| `observed` | ランタイム hook がツールイベントを観測 |
| `executed` | NotDone が契約に定義された検証を実行 |
| `reproduced` | 独立検証で同じチェックを再実行 |
| `attested` | CI またはリモート検証者が署名。v0.1 以降に予定 |

ローカル v0.1 は、誠実だが誤る可能性のあるエージェントを対象とします。根拠のない完了主張や proof packet の改ざんは検出しますが、同じ OS 権限を持つ悪意あるプロセスを完全に防御するものではありません。[脅威モデル](docs/threat-model.md)も参照してください。

## プロジェクト状況

1. Protocol schema と canonical digest
2. Core evidence/verifier
3. CLI と MCP server
4. Codex、Claude Code、Gemini CLI adapter
5. Cross-runtime conformance
6. 再現可能な v0.1 リリース

現在の範囲は [ROADMAP.md](ROADMAP.md) にあります。

## コントリビューションとライセンス

変更を提案する前に [CONTRIBUTING.md](CONTRIBUTING.md) をお読みください。セキュリティ問題は公開 Issue ではなく [SECURITY.md](SECURITY.md) の手順に従ってください。

NotDone は [Apache License 2.0](LICENSE) の下で提供されます。
