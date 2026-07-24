<!-- docs-revision: 3 -->

<p align="center">
  <strong>NotDone</strong><br>
  AI エージェントのための完了証明
</p>

<p align="center">
  <img src="https://img.shields.io/badge/status-v0.1.1-blue" alt="ステータス: v0.1.1">
  <a href="https://github.com/bbdyno/NotDone/actions/workflows/ci.yml"><img src="https://github.com/bbdyno/NotDone/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="ライセンス: Apache-2.0"></a>
  <img src="https://img.shields.io/badge/Node.js-%3E%3D22-339933" alt="Node.js 22 以降">
  <img src="https://img.shields.io/badge/Claude_Code-ready-8A2BE2" alt="Claude Code 対応済み">
  <img src="https://img.shields.io/badge/Codex-ready-111111" alt="Codex 対応済み">
  <img src="https://img.shields.io/badge/Gemini_CLI-ready-4285F4" alt="Gemini CLI 対応済み">
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

![NotDone の入力、capability、出力を示す図](docs/assets/notdone-composable-runtime-hero.svg)

> エージェントは「完了」と言います。NotDone は証拠を求めます。

NotDone は、AI コーディングエージェント向けのランタイム中立な完了証明レイヤーです。完了条件を機械可読な契約として固定し、実際のツールから証拠を収集して、エージェントがタスクを完了したと言えるかを独立して検証します。

> [!NOTE]
> v0.1.1 が現在のリリースです。ソースビルド、独立した npm パッケージ、3 つのランタイム連携はリリースワークフローで検証されます。

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

## クイックスタート

### 現在のソースチェックアウトからインストール

Node.js 22 以降と pnpm 11.9.0 が必要です。

```shell
git clone https://github.com/bbdyno/NotDone.git
cd NotDone
pnpm install --frozen-lockfile
pnpm build
npm install --global ./packages/cli ./packages/mcp-server
```

### CLI

npm から 2 つの独立パッケージを次のようにインストールします。

```shell
npm install --global notdone notdone-mcp
notdone init
notdone contract validate
notdone verify
notdone proof inspect .notdone/proofs/<run-id>.proof.json
```

### Claude Code

ローカルのソースチェックアウトでは次のコマンドを使います。

```text
/plugin marketplace add .
/plugin install notdone@notdone-marketplace
/notdone:verify
```

リポジトリ公開後のリモート Marketplace フローは次のとおりです。

```text
/plugin marketplace add bbdyno/NotDone
/plugin install notdone@notdone-marketplace
/notdone:verify
```

### Codex

ローカルのソースチェックアウトでは次のコマンドを使います。

```shell
codex plugin marketplace add .
codex plugin add notdone@notdone-marketplace
```

リポジトリ公開後は `.` を `bbdyno/NotDone` に置き換えます。インストール後、
名前空間付き skill を明示的に呼び出します。

```text
$notdone:verify
```

### Gemini CLI

ローカルのソースチェックアウトでは次のコマンドを使います。

```shell
gemini extensions link .
gemini extensions validate .
```

リポジトリ公開後は
`gemini extensions install https://github.com/bbdyno/NotDone` を使います。
2 つのネイティブコマンドは同じ検証フローを実行します。

```text
/notdone
/notdone:verify
```

## 組み合わせ可能なローカル優先ワークフロー

CLI は、設定されていない backend が実行されたようには表示しません。

| 用途 | コマンド | 動作 |
| --- | --- | --- |
| 検索のみ | `notdone retrieve <query> --json` | 許可されたローカルテキストを検索し、citation と evidence artifact を返します。 |
| 検証のみ | `notdone verify [contract-path]` | 検索やモデルなしで独立した proof workflow を実行します。 |
| 状態確認 | `notdone backends --json`, `notdone packs --json` | ローカル検索/検証、任意モデルの状態、宣言型 Pack を表示します。 |
| 組み合わせの説明 | `notdone run retrieve-model-verify <query> --profile Private --json` | route、egress、citation、保留中の検証、backend 未使用可能状態を表示します。 |

対応パスは Retrieve、Verify、Run、Retrieve → Run、Run → Verify、Retrieve → Run → Verify です。`Private` profile は外部ネットワークを拒否し、`Saver` と `Quality` はリモート経路に承認が必要です。モデル backend は既定で構成されません。

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
| `attested` | CI またはリモート検証者が結果に署名。プロトコルには定義済みだが、ローカル collector はまだ生成しない |

ローカル v0.1 実装は、誠実だが誤る可能性のあるエージェントを対象とします。根拠のない完了主張や proof packet の改ざんは検出しますが、同じ OS 権限を持つ悪意あるプロセスを完全に防御するものではありません。[脅威モデル](docs/threat-model.md)も参照してください。

## プロジェクト状況

v0.1.1 リリースには次の機能が含まれます。

- バージョン付き protocol schema、canonical JSON、SHA-256 packet integrity
- 決定的な command、file、Git diff 検証
- 単独で実行できる `notdone` CLI と `notdone-mcp` パッケージ
- Claude Code、Codex、Gemini CLI のネイティブ配布と完了ゲート
- schema に基づく cross-runtime conformance テスト
- Node.js 22/24 CI、パッケージインストールテスト、依存関係レビュー、
  リリース checksum、npm provenance、GitHub build attestation

リリース成果物と検証手順は GitHub Release で確認できます。
詳しくは [ROADMAP.md](ROADMAP.md)、[プロトコル](docs/protocol.md)、
[CLI リファレンス](docs/cli.md)、[MCP リファレンス](docs/mcp.md)、
[リリース手順](RELEASING.md)を参照してください。

## 現在のチェックアウトを検証

```shell
pnpm check
pnpm pack:release
pnpm pack:verify
```

最初のコマンドは type check、unit test、ランタイム hook test、
conformance、ドキュメントと連携の検査を実行します。パッケージコマンドは
2 つの npm tarball をビルドして隔離環境にインストールし、CLI と MCP
server の応答およびライセンスの同梱を確認します。

## コントリビューションとライセンス

変更を提案する前に [CONTRIBUTING.md](CONTRIBUTING.md) をお読みください。セキュリティ問題は公開 Issue ではなく [SECURITY.md](SECURITY.md) の手順に従ってください。

NotDone は [Apache License 2.0](LICENSE) の下で提供されます。
