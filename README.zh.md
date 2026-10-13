---
description: "面向用户与维护者的一次性 Antigravity CLI subagent 提供方，用于安装 Profile bundle、配置无人值守的 Antigravity 委派或排查 headless 子 agent 运行问题。"
kind: "package-bundle"
---

# dsh-subagent-antigravity

[English](README.md) | 中文

## 概述

当委派工作需要在父会话工作区中的真实无人值守 Antigravity CLI 会话内运行时，把 `dsh-subagent-antigravity` 安装进 Profile。每次委派都会启动一个全新的 headless Antigravity 进程，为一个自包含文本任务执行恰好一轮对话，并且只返回其最终答案或安全失败诊断。原生 Antigravity 配置和身份验证继续作为权威来源，而 `permissionMode` 选择非交互审批姿态。Bundle 以全局工具形式添加委派工具。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

当任务需要在父工作区中运行全新的原生 Antigravity CLI 会话时，在插件页启用 **Antigravity 子智能体**，或通过 `dsh plugin --profile <name> add dsh-subagent-antigravity` 安装。

### 前置条件

- Antigravity CLI 已安装且 `agy` 在 `PATH` 上（官方安装脚本见 <https://antigravity.google/docs/cli/install/>）；
- 已交互式运行过一次 `agy` 完成登录——headless 模式只使用缓存凭据，未登录的无终端环境会以 `authentication required` 失败退出而不是挂起。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `providerName` | `antigravity` | `ctx.subagents` 上的非空注册名称；每个已挂载实例都需要唯一值 |
| `command` | `agy` | headless CLI 启动器：PATH 名或绝对路径 |
| `model` | CLI 原生设置 | 为本提供方实例固定的可选模型 slug（`agy models` 列出）；省略时保留 CLI 设置 |
| `effort` | — | 推理强度：`low` / `medium` / `high` |
| `agent` | — | 固定 agent slug（`agy agents` 列出） |
| `env` | `{}` | 叠加在已清理凭据的父环境之上的显式子进程环境 |
| `permissionMode` | `default` | 非交互审批姿态：`default`（CLI 策略，越权工具软拒绝）或 `dangerously-skip-permissions`（全量放行，必须显式选择） |
| `sandbox` | `false` | 追加 `--sandbox` 启用终端沙箱限制 |
| `printTimeout` | — | `--print-timeout` 直通（如 `15m`）；缺省为产品默认 5 分钟 |
| `disposeGraceMs` | `3000` | 共享 managed-range owner 各终止层级之间的宽限 |

已配置的 `model` 会原样传给每次 headless 启动；省略时保留原生模型选择。提供方不会发现模型或改写别名——headless 模式对未知 `--model` 直接非零退出并返回 ERROR，因此固定错误模型会响亮失败。具有凭证特征的环境变量会在显式 `env` 覆盖生效前被移除，因此供子进程使用的密钥必须在该配置中显式提供。

### 暴露工具

Bundle 将 `tool-subagent-antigravity` 作为 Host 条目插入，因此 `subagent_antigravity` 是所有预设都可见的全局工具。若要不选择 bundle 层而手动挂载提供方和工具，在 `cordis.patch.yml` 中插入相同的条目：

```yaml
- insert:
    - id: subagent-antigravity
      name: 'dsh-subagent-antigravity'
    - id: tool-subagent-antigravity
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: antigravity
        toolName: subagent_antigravity
        maxDepth: provider-managed
```

工具接受任务后返回 child id；任务完成后向父 agent 发送结果通知。外部 activation 只执行一次，不支持追加输入或恢复对话。

### 你会得到什么

完成通知包含 Antigravity 的最终答案，或停止原因与可选的安全诊断。父会话还独立保存外部任务的身份和完整终态结果；无需创建本地子 Session。产品推理、工具活动、原始 stderr 与工作区差异不会进入父会话。

### 失败与恢复

启动器缺失、CLI 未安装或未认证的运行会在第一次委派时以安全类别失败：发布前失败（spawn 或 `init` 事件前）以 `initialize` 阶段拒绝；发布后失败扁平化为固定诊断（`Product subagent failure (product: Antigravity; stage: …; category: …)`）。被取消的运行以 `aborted` 结算。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 设计理念

- **每次运行一个全新进程、一个会话与一轮。** 每次运行都 spawn 全新 `agy --input-format stream-json --output-format stream-json`、写一条 `user` 事件并恰好执行一轮；没有续接、恢复或池化。
- **原生配置是权威。** Antigravity 配置与身份验证经父级 cwd 与系统 keyring 保持原生；提供方只覆盖可选模型/强度/agent 以及权限与超时旗标。
- **刻意无人值守。** headless 模式没有交互提示：工具确认由 CLI 策略自动处理（默认越权软拒绝并在 stderr 提示如何放行），产品没有服务器反向请求面需要应答。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：config schema、提供方注册 |
| [`src/run.ts`](src/run.ts) | 运行生命周期、发布门、结果选择与诊断 |
| [`src/wire.ts`](src/wire.ts) | 最小的 headless stream-json 事件流实现 |
| [`cordis.patch.yml`](cordis.patch.yml) | 注册提供方并添加全局委派工具的 Profile 配置层 |

### 运行流程

一次启动只接受非空的文本块序列，并使用子代理服务选择的子级 cwd。它经子进程 seam spawn 固定命令，等待流首的 `init` 事件（发布门），然后写一条 `user` 事件并等待权威 `result` 事件。答案以 `result.response` 为准；流式 `agent_response` 文本增量为兼容回退；SUCCESS 但答案为空判为 `invalid-result`。终态映射：`SUCCESS`→completed；`ERROR`→粗类别（无效模型→product-error、认证→access-policy、配额→limit、超时→service）；`CANCELED`/`INTERRUPTED`→失败；`WAITING`/`INVALID`→product-error；`RUNNING`（进程先退未到终态）→transport。stderr 原样转发到 Host 仅作观察。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Antigravity CLI headless 官方文档](https://antigravity.google/docs/cli/headless/)——stream-json 协议、旗标与状态值真源。
- [Subagent 子系统](https://github.com/deepseek-ai/deepseek-harness)——DSH 的服务约定、提供方约定与终态结果语义。
- [`@deepseek-ai/dsh-subagent-codex`](https://www.npmjs.com/package/@deepseek-ai/dsh-subagent-codex)——本插件对标的产品后端，经官方 app-server 协议驱动 Codex。

-----

<a id="model-experience"></a>
## 模型体验

### 子级请求

子级在全新 headless 会话中以单轮接收这些独立文本块。它的工作区是所选子级工作目录；所选提供方实例固定已配置的模型、强度、agent、环境与非交互审批姿态，省略的模型及其余产品设置来自 CLI 原生配置。子级 token 不会进入父级上下文；缓存复用只取决于 Antigravity 自身的提供方与请求形态。

### 父级调度与结果（间接）

通过 `dsh-tool-subagent`，父模型先收到 child id，随后收到 Antigravity 最终答案或带停止原因与安全诊断的失败通知。诊断只包含固定的阶段、类别和已观测的进程事实。产品推理、中间消息、工具活动、stderr、用量与原始协议载荷不会复制到父 Session。

## 已知限制与延期工作

- **每次运行均新建一个进程与一轮**——不支持续接、恢复、池化、进度流或产品会话持久化。
- **载荷来自宿主 PATH**——与 Codex 版锁定 npm 包内 wrapper 不同，Antigravity CLI 无 npm 发行版；`command` 必须由部署保证存在且版本受控。
- **无协议级中断**——headless 流没有 `turn/interrupt` 等价物；取消 = 本地结算 + managed-range 终止阶梯，取消前已更改的文件或外部系统不会恢复原状。
- **审批由 CLI 策略自治**——越权工具软拒绝（exit 0 + stderr 提示）；`dangerously-skip-permissions` 全量放行，必须显式选择。
- **静态选择实例**——Profile 配置项固定提供方名称、可选模型与工具绑定；调用无法动态选择或修改。
- **身份验证与账户状态仍由原生机制管理**——需要先交互式登录；未登录的无终端运行直接失败。

### 开发备注

- 协议依据 2026-10 官方 headless 文档实现；`result` 信封字段（`status`/`response`/`error`/`usage`）与七种终态值以该文档为准，上游变更需重新验证。
- 冒烟测试以 mock `agy` 回放四种场景（ok/error/empty/hang+cancel），覆盖发布门、结果映射、失败扁平化与取消拆除。
