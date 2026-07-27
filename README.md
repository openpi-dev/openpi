<p align="center">
  <img src="assets/readme-hero.svg" alt="My Pi Setup — Pi-native multi-agent coding environment" width="100%" />
</p>

<p align="center">
  <strong>让最小的 Pi harness，长出可靠的后台执行、Pi-native 多 Agent、动态工作流与高密度终端界面。</strong>
</p>

<p align="center">
  <a href="https://github.com/earendil-works/pi-mono"><img alt="Pi 0.82+" src="https://img.shields.io/badge/Pi-0.82%2B-2f81f7?style=flat-square"></a>
  <a href="https://github.com/tt-a1i/my-pi-setup/actions"><img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-3178c6?style=flat-square&logo=typescript&logoColor=white"></a>
  <img alt="Tests" src="https://img.shields.io/badge/tests-153%20passing-3fb950?style=flat-square">
  <img alt="Configuration" src="https://img.shields.io/badge/config-natural%20language-d2a8ff?style=flat-square">
  <img alt="License" src="https://img.shields.io/badge/license-see%20notices-7d8590?style=flat-square">
</p>

<p align="center">
  一套经过裁剪、测试和实际使用打磨的 <a href="https://pi.dev">Pi</a> 扩展包。<br />
  不替你决定模型，不强制主题，也不会在安装后偷偷产生额外模型调用。
</p>

<p align="center">
  <a href="#快速安装"><strong>快速安装</strong></a> ·
  <a href="#核心能力">核心能力</a> ·
  <a href="#命令速查">命令速查</a> ·
  <a href="#一个入口完成配置">自然语言配置</a> ·
  <a href="#为什么这样设计">设计原则</a>
</p>

<br />

<p align="center">
  <img src="assets/pi-setup.jpeg" alt="My Pi Setup terminal interface" width="920" />
</p>

> [!NOTE]
> 截图展示完整视觉效果；大型 Pi 标题现在默认关闭，可通过 `/my-pi-setup 显示大标题` 开启。GitHub Dark 主题也是可选项。

---

## 它解决什么问题

Pi 的价值在于小：它提供 Agent loop、工具、Session 和扩展 API，却不把工作方式写死。
但真实开发很快会遇到几个问题：

- Dev server、watcher 和长测试不能阻塞主 Agent；
- 调研、实现和审查需要隔离 Context，而不是把所有噪音塞进一个会话；
- 多阶段任务需要并行执行、结构化汇总和可观察的运行状态；
- 长会话需要主动切换阶段，也需要快速找回历史 Session；
- 模型应该能在真正存在歧义时，用合适的界面向用户提问；
- 终端应该持续展示模型、Context、成本、Git 和后台任务，而不是让用户到处查询。

My Pi Setup 把这些能力组织成一套一致的 Pi-native 工作流：

```text
主 Pi 会话
  ├─ 后台终端 ───────── dev server / watcher / build / test
  ├─ Pi subagents ───── 独立 Context 的并行调研、实现与审查
  ├─ Workflows ──────── 多阶段 fan-out → structured result → synthesis
  ├─ Context Pivot ──── 同一 Session 内从旧阶段切换到干净的新阶段
  └─ Run Recap ──────── 每轮结束后的可读回顾卡片，不污染模型上下文
```

---

## 核心能力

<table>
<tr>
<td width="33%" valign="top">
<strong>Run in background</strong><br/><br/>
Dev server、watcher、build 与 test 在后台运行；日志可见，超时可控，退出自动回传。
</td>
<td width="33%" valign="top">
<strong>Delegate cleanly</strong><br/><br/>
Pi-native Subagent 使用独立 Context，继承父模型与工具，不把调研噪音带回主会话。
</td>
<td width="33%" valign="top">
<strong>Orchestrate deeply</strong><br/><br/>
动态 Workflow 组合阶段、并行 Agent 与结构化输出，并保存完整可检查的运行产物。
</td>
</tr>
<tr>
<td width="33%" valign="top">
<strong>Control context</strong><br/><br/>
Context Pivot 在同一 Session 内切换阶段；Handoff 负责真正跨 Session 的工作交接。
</td>
<td width="33%" valign="top">
<strong>Stay observable</strong><br/><br/>
Footer 持续展示 Model、Context、Cost、Throughput、Git、PR 与后台活动。
</td>
<td width="33%" valign="top">
<strong>Configure naturally</strong><br/><br/>
一个 <code>/my-pi-setup</code> 命令，用自然语言配置模型、并发与界面，不增加命令迷宫。
</td>
</tr>
</table>

<br />

### 1. 后台终端，而不是“开个 Bash 然后等”

模型可以启动长期进程，然后继续工作：

```text
bg_start({
  command: "npm run dev",
  title: "web dev server"
})
```

- 独立捕获 stdout / stderr；
- `/ps` 实时查看日志和状态；
- 进程退出后自动通知 Agent，无需轮询；
- 可为 build、test、migration 设置 `timeout_seconds`；
- 超时后终止整个进程树，并明确记录为 `timed_out`；
- 最多并发 8 个后台进程；
- Session 关闭或 Reload 时自动清理，避免遗留进程。

适合：dev server、watch mode、长测试、流式构建。交互式程序不适合——后台终端没有 stdin。

### 2. Pi-native Subagents

主 Agent 可以把自包含任务交给独立的 Pi Session：

```text
subagent_spawn({
  harness: "pi",
  name: "audit auth flow",
  prompt: "Inspect src/auth end to end ..."
})
```

默认行为刻意保持简单：

- 默认使用 `pi` harness；
- 默认继承父会话的模型和 Thinking Level；
- 每个子 Agent 有独立 Context Window；
- 子 Agent 继承当前 Pi 环境中的工具、Skills、项目上下文和 Trust 决策；
- 最多同时运行 4 个；
- 完成结果自动返回，也可以 `check`、`wait`、`cancel`；
- `/subagents` 可以查看实时 Transcript、工具活动、Context 占用，甚至接管继续对话。

Claude Code 与 Codex Backend 仍作为兼容入口保留，但只有用户明确要求时才使用；仓库不为外部 Harness 写死模型偏好。

### 3. 动态 Multi-Agent Workflows

单个 Subagent 解决“把一件事委派出去”；Workflow 解决“任务本身有阶段、有依赖、有 fan-out”。

模型可以在受限 JavaScript DSL 中组合：

```js
phase("Scan");
const findings = await parallel(
  files.map(
    (file) => () =>
      agent(`Review ${file}`, {
        label: `review:${file}`,
        schema: FINDING_SCHEMA,
      }),
  ),
);

phase("Synthesize");
return await agent(`Synthesize: ${JSON.stringify(findings)}`);
```

- `phase()` 展示阶段进度；
- `agent()` 启动隔离的 Pi Agent；
- `parallel()` 控制并发 fan-out；
- JSON Schema 提供结构化结果；
- 前台运行可实时查看，后台运行结束后自动通知；
- `/workflows` 查看阶段、Agent、Transcript、Token 与成本；
- 脚本运行在无文件、网络和进程权限的独立沙箱；
- 运行产物持久化到 `~/.pi/agent/workflows/<run-id>/`。

默认每个 Workflow 同时运行 **8** 个 Agent，最多调用 **128** 次；可配置到并发 64、总调用 1024。多个 Workflow 彼此独立。

### 4. Context Pivot：同一 Session，切换工作阶段

```text
/context-pivot 从调研切换到实现，先完成 API 主链路
```

当当前 Context 已经积累大量调研过程、失败尝试或上一阶段细节时，Context Pivot 会：

1. 让 Agent 生成下一阶段的自包含 Brief；
2. 主动压缩旧 Context；
3. 将 Brief 放在新 Context 的注意力前沿；
4. 在同一个 Session 中继续执行。

它与 `/handoff` 不同：

| 场景                                          | 使用               |
| --------------------------------------------- | ------------------ |
| 同一 Session 内从调研切到实现、从实现切到审查 | `/context-pivot`   |
| 需要真正的新 Session、分支实验或跨 Agent 交接 | `/handoff` Skill   |
| 只是 Context 太长，但任务阶段没有变化         | Pi 原生 `/compact` |

为避免无意义压缩，Context Pivot 仅在约 30K Context Tokens 后启用。

### 5. Session 搜索与预览

```text
/sessions
```

打开全屏 Session 选择器：

- 按名称、首条消息、Session ID、工作目录实时过滤；
- 预览 User / Assistant / Tool / Summary 内容；
- 查看时间与 Git 变更概况；
- 当前项目与全部 Workspace 之间切换；
- 选中后直接调用 Pi 的安全 Session Switch 生命周期。

### 6. 模型可以真正“问用户”

`ask_user` 不是普通文本提问，而是模型可调用的结构化 TUI：

- 一次支持 1–3 个独立问题；
- 每题 2–5 个互斥选项；
- 推荐项放在第一位，并解释每个选项的权衡；
- 用户可选择、自由填写，或在选项后追加 Notes；
- 支持中文 IME 焦点；
- Esc 明确表示拒绝回答，不会被误当成默认选项；
- 无头子 Agent 和 Workflow Child 无法调用，避免后台任务卡死。

Prompt 约束它只询问真正会改变结果、又无法从代码和上下文推断的决策；禁止用它问“是否继续”。

### 7. 一等文件搜索工具

模型直接获得结构化 `fd` 与 `rg`：

- 默认遵守 `.gitignore`；
- 支持名称、Glob、类型、扩展名、Smart Case、固定字符串和上下文行；
- 参数经过严格 argv 构造，不依赖 Shell 拼接；
- 标准限制为 50KB / 2000 行，完整截断结果保存在当前 Session 的临时文件；
- Session 结束自动清理临时结果；
- 系统没有 `fd` / `rg` 时，会从官方 Release 通过 HTTPS 下载固定版本，校验 SHA-256 后原子安装。

`rg.max_matches_per_file` 明确表达它是“每个文件”的限制，不会让模型误以为是全局上限。

### 8. 高密度终端 Dashboard

默认 Footer 持续展示：

```text
~/project                         provider/model · thinking
34%/1M · $0.18 · ~52 tok/s        main · 3 files changed · PR #42
```

并在其后保留 Subagents、Workflows 等扩展状态。

- Context 与模型信息直接来自 Pi Runtime；
- 成本累计 Assistant、嵌套 Tool、Compaction 和 Branch Summary 的已记录 Usage；
- Token 速度用 `~` 明确标记为流式估算；
- Git 每 5 秒刷新，并在输入或工具结束后立即刷新；
- `/lg` 浏览本地文件与 Diff；
- `/pr` 刷新当前分支对应的 GitHub PR；
- 大型 ASCII Header 默认关闭；
- Footer 可以通过统一配置关闭，恢复 Pi 原生 Footer。

### 9. Run Recap，不占主 Context

每轮 Agent 完整结束后，聊天中会出现一张 Recap 卡片：

- 做了什么；
- 关键结果和失败；
- 下一步是什么。

Recap 使用 `pi.appendEntry()`，会随 Session 保存，但不会进入后续模型上下文。

默认使用本地规则生成，不调用模型。用户可以显式选择任何当前 Pi Registry 中可用的低成本模型来改善摘要质量。

---

## 快速安装

### 要求

- Pi `0.82.0` 或更新版本；
- Node.js 22+；
- macOS 或 Linux 可使用自动安装的 `fd` / `rg`；其他平台请自行安装二进制。

### 推荐：作为 Pi Package 安装

```bash
pi install git:github.com/tt-a1i/my-pi-setup
```

重启 Pi，或在现有 Pi Session 中运行：

```text
/reload
```

开发本仓库时，也可以直接安装本地 Checkout：

```bash
git clone https://github.com/tt-a1i/my-pi-setup.git ~/work/my-pi-setup
cd ~/work/my-pi-setup
npm install
pi install ~/work/my-pi-setup
```

### 可选：GitHub Dark 主题

安装包会注册主题，但不会替你切换。通过 Pi `/settings` 选择 `github-dark-default`，或在 `~/.pi/agent/settings.json` 中设置：

```json
{
  "theme": "github-dark-default"
}
```

---

## 一个入口完成配置

所有属于本包的用户配置都走一个命令：

```text
/my-pi-setup
```

无参数时显示当前状态和示例；后面直接跟自然语言即可：

```text
/my-pi-setup 摘要使用 seal/deepseek-v4-flash，关闭推理
/my-pi-setup 关闭自动摘要
/my-pi-setup 摘要改用本地 fallback，不调用模型
/my-pi-setup workflow 同时跑 16 个 agent，总任务最多 256 个
/my-pi-setup 显示大标题
/my-pi-setup 隐藏大标题
/my-pi-setup 关闭自定义状态栏
```

当前模型负责理解自然语言，受限配置工具负责保存结果。配置位于：

```text
~/.pi/agent/my-pi-setup.json
```

安装默认值：

| 配置                     |                          默认值 |
| ------------------------ | ------------------------------: |
| Run Recap                | 开启，本地 fallback，不调用模型 |
| Workflow 并发            |                               8 |
| Workflow 最大 Agent 调用 |                             128 |
| 大型 Header              |                            关闭 |
| Dashboard Footer         |                            开启 |
| 主题                     |              不修改用户现有选择 |

---

## 命令速查

| 命令                        | 作用                                         |
| --------------------------- | -------------------------------------------- |
| `/my-pi-setup [自然语言]`   | 查看或修改本包配置                           |
| `/sessions`                 | 搜索、预览并切换 Session                     |
| `/ps`                       | 查看和管理后台终端                           |
| `/subagents`                | 查看、取消或接管子 Agent                     |
| `/btw`                      | 在旁路 Pi Context 中问一个问题，不打断主任务 |
| `/workflows`                | 查看 Workflow 运行、阶段和产物               |
| `/context-pivot <下一阶段>` | 在同一 Session 中清理 Context 并切换阶段     |
| `/lg`                       | 浏览 Working Tree 改动和 Diff                |
| `/pr`                       | 刷新当前分支的 GitHub PR 信息                |
| `/copy-all`                 | 复制当前分支可见的 User / Assistant 对话     |

## 模型工具速查

| 工具                                                                                    | 用途                                  |
| --------------------------------------------------------------------------------------- | ------------------------------------- |
| `bg_start`, `bg_status`, `bg_list`, `bg_kill`                                           | 后台进程生命周期                      |
| `subagent_spawn`, `subagent_check`, `subagent_list`, `subagent_wait`, `subagent_cancel` | 独立子 Agent                          |
| `workflow`                                                                              | 动态多阶段 Agent 编排                 |
| `context_pivot`                                                                         | Agent 主动切换 Context 阶段           |
| `ask_user`                                                                              | 结构化用户决策                        |
| `fd`, `rg`                                                                              | 文件发现与内容搜索                    |
| `configure_my_pi_setup`                                                                 | `/my-pi-setup` 背后的受限配置写入工具 |

---

## 为什么这样设计

### Pi-native 优先

默认子 Agent 是新的 Pi SDK Session，而不是另起一个外部 CLI。它自然继承用户已经配置好的 Provider、模型、Tools、Skills 和项目 Trust。

### 没有隐式模型消费

仓库不写死私有 Provider 或模型名。Summary 默认不调用模型；Pi Subagent 默认继承父模型；外部 Harness 只有用户明确要求时才启用。

### Context 是资源，不是垃圾桶

- 一次任务委派给 Subagent；
- 多阶段依赖交给 Workflow；
- 阶段变化使用 Context Pivot；
- 真正跨 Session 使用 Handoff；
- Recap 留给人看，不塞回模型 Context。

### 后台能力必须可观察、可终止

后台 Terminal、Subagent、Workflow 都有：

- 明确 ID 与状态；
- 实时或截断输出；
- UI Dashboard；
- 取消与 Shutdown 清理；
- 一次且仅一次的完成通知。

### 约束错误，而不是约束能力

默认并发足够高，并允许用户继续放宽；同时保留机械上限、输出上限、调用预算和沙箱边界，防止错误脚本无限扩张。

---

## 架构

```text
extensions/
├── setup/                 # /my-pi-setup 与受限配置工具
├── background-terminals/  # 长进程、日志、/ps
├── subagents/             # Pi / Claude Code / Codex Backend + /subagents
├── workflows/             # JS DSL、Agent Runner、Sandbox、Artifacts
├── context-pivot/         # 定向 Compaction
├── sessions/              # Session 搜索、预览、切换
├── ask-user/              # 结构化用户输入
├── file-search/           # fd / rg 与二进制解析
├── summaries/             # Run Recap
├── git-info/              # Git / PR 与 /lg
├── model-info/            # Model / Context / Cost / Throughput
├── ui-customization/      # Header / Footer / Terminal title
├── copy-all/              # 可见对话复制
└── shared/                # Child session、配置、状态与超时策略

skills/
├── background-terminals/
└── subagents/

themes/
└── github-dark-default.json
```

扩展之间通过 Pi Event Bus 和小型共享状态通信；长生命周期资源均绑定 Session Shutdown。Workflow JavaScript 在独立 Node Permission Sandbox 中运行，Agent Child 则使用 Pi SDK 的独立 Session 与 Trust-aware Resource Loader。

---

## 开发与验证

```bash
npm install
npm run check
npm run format:check
npm test
```

核心测试覆盖：

- 后台进程树终止、SIGTERM → SIGKILL、超时、日志和竞态；
- Subagent 并发、结果去重、取消、Context 使用量；
- Workflow 沙箱、调用预算、结构化输出、Artifact 原子写入；
- `fd` / `rg` argv、官方二进制下载、SHA-256 和输出截断；
- Session 搜索、Summary 脱敏、配置边界与 TUI 选择状态。

仓库的 [`AGENTS.md`](AGENTS.md) 还定义了维护约束：任何新增的模型、开关、权限、并发或 UI 偏好，都必须同步接入 `/my-pi-setup`，保持单一配置入口。

---

## 来源与致谢

本项目基于 [davis7dotsh/my-pi-setup](https://github.com/davis7dotsh/my-pi-setup) 演进，并针对 Pi-native 子代理、统一自然语言配置、Context Pivot、Session 浏览、结构化提问、可配置 Workflow Fan-out、后台超时与资源清理进行了持续打磨。

`extensions/sessions/` 改编自 [jayshah5696/pi-agent-extensions](https://github.com/jayshah5696/pi-agent-extensions)。完整第三方说明见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。

---

<div align="center">

**Small harness. Deep extensions. Clean context.**

</div>
