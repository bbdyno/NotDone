<!-- docs-revision: 1 -->

<p align="center">
  <strong>NotDone</strong><br>
  面向 AI 智能体的完成证明
</p>

<p align="center">
  <img src="https://img.shields.io/badge/status-pre--alpha-orange" alt="状态: pre-alpha">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="许可证: Apache-2.0"></a>
  <img src="https://img.shields.io/badge/Claude_Code-planned-8A2BE2" alt="计划支持 Claude Code">
  <img src="https://img.shields.io/badge/Codex-planned-111111" alt="计划支持 Codex">
  <img src="https://img.shields.io/badge/Gemini_CLI-planned-4285F4" alt="计划支持 Gemini CLI">
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

> 智能体说“完成了”，NotDone 要求它出示证据。

NotDone 是面向 AI 编程智能体的运行时中立完成证明层。它把验收条件冻结为机器可读的契约，从真实工具收集证据，并独立判断智能体是否有资格宣称任务已经完成。

> [!WARNING]
> 当前处于 pre-alpha 阶段。以下命令和集成方式描述的是 v0.1 的目标体验，尚未发布为可安装产品。

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

## 目标 Quickstart

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
| `attested` | CI 或远程验证器对结果签名，计划在 v0.1 之后支持 |

本地 v0.1 面向诚实但可能犯错的智能体。它会发现缺乏依据的完成声明和被篡改的 proof packet，但不会声称能够完全抵御拥有相同操作系统权限的恶意进程。详情请参阅[威胁模型](docs/threat-model.md)。

## 项目状态

1. Protocol schema 和 canonical digest
2. Core evidence/verifier
3. CLI 和 MCP server
4. Codex、Claude Code、Gemini CLI adapter
5. Cross-runtime conformance
6. 可复现的 v0.1 发布

当前范围请参阅 [ROADMAP.md](ROADMAP.md)。

## 贡献与许可证

提交修改前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。安全问题请按照 [SECURITY.md](SECURITY.md) 私下报告，不要创建公开 Issue。

NotDone 采用 [Apache License 2.0](LICENSE)。
