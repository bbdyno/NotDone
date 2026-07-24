<!-- docs-revision: 3 -->

<p align="center">
  <strong>NotDone</strong><br>
  面向 AI 智能体的完成证明
</p>

<p align="center">
  <img src="https://img.shields.io/badge/status-v0.1.1-blue" alt="状态: v0.1.1">
  <a href="https://github.com/bbdyno/NotDone/actions/workflows/ci.yml"><img src="https://github.com/bbdyno/NotDone/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="许可证: Apache-2.0"></a>
  <img src="https://img.shields.io/badge/Node.js-%3E%3D22-339933" alt="Node.js 22 或更高版本">
  <img src="https://img.shields.io/badge/Claude_Code-ready-8A2BE2" alt="Claude Code 集成已就绪">
  <img src="https://img.shields.io/badge/Codex-ready-111111" alt="Codex 集成已就绪">
  <img src="https://img.shields.io/badge/Gemini_CLI-ready-4285F4" alt="Gemini CLI 集成已就绪">
  <a href="https://github.com/bbdyno/NotDone/stargazers"><img src="https://img.shields.io/github/stars/bbdyno/NotDone?style=social" alt="GitHub stars"></a>
</p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README_KO.md">한국어</a> |
  <a href="README_JA.md">日本語</a> |
  <strong>简体中文</strong> |
  <a href="README_ZH-TW.md">繁體中文</a>
</p>

# NotDone

![展示 NotDone 输入、capability 和输出的图](docs/assets/notdone-composable-runtime-hero.svg)

> 智能体说“完成了”，NotDone 要求它出示证据。

NotDone 是面向 AI 编程智能体的运行时中立完成证明层。它把验收条件冻结为机器可读的契约，从真实工具收集证据，并独立判断智能体是否有资格宣称任务已经完成。

> [!NOTE]
> v0.1.1 是当前版本。源代码构建、独立 npm 软件包以及三个运行时集成都由发布工作流进行验证。

## 为什么需要 NotDone？

AI 智能体可能在没有运行相关测试时报告成功，把部分修改误认为完整结果，或者用自信的总结掩盖未经验证的假设。NotDone 将智能体的声明与支持声明的证据分离。

- 在验证之前冻结完成条件。
- 不把模型生成的完成文本当作证据。
- 记录命令、退出码、Git 状态、文件、日志、截图和外部状态。
- 将必需声明判定为 `verified`、`unverified`、`blocked` 或 `failed`。
- 无需信任原智能体即可重新验证 proof packet。

## 支持的运行时

| 运行时 | 分发方式 | 显式调用 |
| --- | --- | --- |
| Claude Code | Marketplace plugin | `/notdone:verify` |
| Codex | Marketplace plugin 和 skill | `$notdone:verify` |
| Gemini CLI | Extension 和 custom command | `/notdone` 或 `/notdone:verify` |
| 任意 shell/CI | CLI | `notdone verify` |

各运行时的 hook 只负责事件标准化和完成门控。契约评估、证据存储、哈希和验证由公共核心处理。

## 快速开始

### 从当前源代码检出安装

需要 Node.js 22 或更高版本以及 pnpm 11.9.0。

```shell
git clone https://github.com/bbdyno/NotDone.git
cd NotDone
pnpm install --frozen-lockfile
pnpm build
npm install --global ./packages/cli ./packages/mcp-server
```

### CLI

请从 npm 安装以下两个独立软件包：

```shell
npm install --global notdone notdone-mcp
notdone init
notdone contract validate
notdone verify
notdone proof inspect .notdone/proofs/<run-id>.proof.json
```

### Claude Code

在本地源代码检出中使用：

```text
/plugin marketplace add .
/plugin install notdone@notdone-marketplace
/notdone:verify
```

仓库发布后的远程 Marketplace 流程为：

```text
/plugin marketplace add bbdyno/NotDone
/plugin install notdone@notdone-marketplace
/notdone:verify
```

### Codex

在本地源代码检出中使用：

```shell
codex plugin marketplace add .
codex plugin add notdone@notdone-marketplace
```

仓库发布后，将 `.` 替换为 `bbdyno/NotDone`。安装完成后，显式调用带
命名空间的 skill：

```text
$notdone:verify
```

### Gemini CLI

在本地源代码检出中使用：

```shell
gemini extensions link .
gemini extensions validate .
```

仓库发布后，使用
`gemini extensions install https://github.com/bbdyno/NotDone`。以下两个
原生命令运行相同的验证流程：

```text
/notdone
/notdone:verify
```

## 可组合的本地优先工作流

CLI 不会把未配置的 backend 表示为已经执行。

| 需求 | 命令 | 行为 |
| --- | --- | --- |
| 仅检索 | `notdone retrieve <query> --json` | 搜索允许的本地文本，并返回 citation 和 evidence artifact。 |
| 仅验证 | `notdone verify [contract-path]` | 无需检索或模型即可运行独立 proof workflow。 |
| 查看状态 | `notdone backends --json`, `notdone packs --json` | 显示本地检索/验证、可选模型状态和声明式 Pack。 |
| 说明组合 | `notdone run retrieve-model-verify <query> --profile Private --json` | 显示 route、egress、citation、待验证状态和 backend 不可用状态。 |

支持 Retrieve、Verify、Run、Retrieve → Run、Run → Verify 及 Retrieve → Run → Verify。`Private` profile 拒绝外部网络；`Saver` 和 `Quality` 的远程路径需要批准。默认未配置模型 backend。

## 工作原理

```text
任务请求
    ↓
冻结的任务契约
    ↓
智能体工作 + 标准化运行时事件
    ↓
NotDone 收集证据
    ↓
确定性验证
    ↓
Proof packet + 报告 + 完成门控
```

```yaml
id: task-123
title: 修复登录崩溃
claims:
  - id: regression-test
    statement: 登录回归测试通过
    required: true
    checks:
      - type: command
        command: npm test -- login-crash
        expect:
          exitCode: 0
```

## 信任模型

| 级别 | 含义 |
| --- | --- |
| `self-reported` | 只有智能体的文字声明，不可作为完成证据 |
| `observed` | 运行时 hook 观察到工具事件 |
| `executed` | NotDone 执行契约中定义的检查 |
| `reproduced` | 独立验证重新执行了同一检查 |
| `attested` | CI 或远程验证器对结果签名；协议中已定义，但本地收集器尚不生成 |

本地 v0.1 实现面向诚实但可能犯错的智能体。它会发现缺乏依据的完成声明和被篡改的 proof packet，但不会声称能够完全抵御拥有相同操作系统权限的恶意进程。详情请参阅[威胁模型](docs/threat-model.md)。

## 项目状态

v0.1.1 版本包括：

- 带版本的 protocol schema、canonical JSON 和 SHA-256 packet integrity
- 确定性的 command、file 与 Git diff 验证
- 可独立运行的 `notdone` CLI 和 `notdone-mcp` 软件包
- Claude Code、Codex、Gemini CLI 原生分发与完成门控
- 基于 schema 的 cross-runtime conformance 测试
- Node.js 22/24 CI、软件包安装测试、依赖项审查、发布 checksum、
  npm provenance 和 GitHub build attestation

发布产物和验证说明可在 GitHub Release 中查看。详情请参阅
[ROADMAP.md](ROADMAP.md)、[协议](docs/protocol.md)、
[CLI 参考](docs/cli.md)、[MCP 参考](docs/mcp.md)和
[发布流程](RELEASING.md)。

## 验证当前检出

```shell
pnpm check
pnpm pack:release
pnpm pack:verify
```

第一条命令运行 type check、unit test、运行时 hook test、conformance 以及
文档和集成检查。软件包命令会构建两个 npm tarball，将其安装到隔离环境，
并验证 CLI、MCP server 响应和许可证内容。

## 贡献与许可证

提交修改前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。安全问题请按照 [SECURITY.md](SECURITY.md) 私下报告，不要创建公开 Issue。

NotDone 采用 [Apache License 2.0](LICENSE)。
