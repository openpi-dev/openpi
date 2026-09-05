<p align="center">
  <img src="assets/openpi-launch-card-v1.webp" alt="OpenPI — Pi at the core, power on demand. Small Harness. Clean Context. Deep Extensions." width="100%" />
</p>

<p align="center">
  把后台 Terminal、Pi-native Subagent、可恢复 Workflow 与持续任务装进同一套 <a href="https://pi.dev">Pi</a> 工作台。<br />
  普通回合零常驻 OpenPI 模型工具；明确需要时，才展开对应能力。
</p>

<p align="center">
  <strong>Small Harness.</strong> 不替换 Pi 的 Agent loop，普通回合不常驻 OpenPI 模型工具。<br />
  <strong>Clean Context.</strong> 能力按需加载，Subagent 使用独立 Context，不把所有工作塞进主会话。<br />
  <strong>Deep Extensions.</strong> 后台执行、Subagent、Workflow 与持续任务在 Pi 原生生命周期内统一运行和观察。
</p>

<p align="center">
  <strong>不是把一组插件摆在一起，而是让它们共享同一套配置、权限、状态与清理边界。</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@tt-a1i/openpi"><img alt="npm version" src="https://img.shields.io/npm/v/@tt-a1i/openpi?style=flat-square&color=cb3837"></a>
  <a href="https://github.com/openpi-dev/openpi/actions/workflows/ci.yml"><img alt="CI status" src="https://github.com/openpi-dev/openpi/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/earendil-works/pi-mono"><img alt="Pi 0.84.1+" src="https://img.shields.io/badge/Pi-0.84.1%2B-2f81f7?style=flat-square"></a>
  <img alt="Node.js 22.19+" src="https://img.shields.io/badge/Node.js-22.19%2B-3fb950?style=flat-square&logo=nodedotjs&logoColor=white">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-3fb950?style=flat-square"></a>
</p>

```bash
pi install npm:@tt-a1i/openpi
```

<p align="center">
  <a href="https://openpi-dev.github.io/openpi/"><strong>项目网站</strong></a> ·
  <a href="#30-秒开始"><strong>立即开始</strong></a> ·
  <a href="#默认轻按需强">为什么默认更轻</a> ·
  <a href="#运行模型">看看它怎么工作</a> ·
  <a href="https://github.com/openpi-dev/openpi/issues/22">查看 Benchmark</a>
</p>

<p align="center">
  <sub>OpenPI 是独立社区项目，与 Physical Intelligence 的 openpi 机器人项目及 Pi 官方均无关联。</sub>
</p>

---

## 默认轻，按需强

**OpenPI 最强的地方，不是工具多，而是复杂度只在值得的时候出现。**

普通编码任务继续走 Pi 原生路径：`read`、`bash`、`edit`、`write`，完整历史、Session compaction、工具输出边界、显式 Bash timeout 与 Provider loop。OpenPI 不额外投影历史，不改写测试超时，也不向模型塞恢复提示；只保留独立的工作区删除保护。

任务一旦需要长期进程、并行调研、隔离实现、多阶段协作或跨回合推进，高级能力仍然完整存在。用户直接提出需求，OpenPI 就在当轮加载对应能力；没用到的能力不会常驻模型工具面。

> **轻路径不缴复杂度税，重任务不缺工程能力。** 这不是一套替代 Pi 的 Agent Runtime，而是一组遵守 Pi 生命周期、Session、Provider、模型与 Trust 边界的 Pi-native 深扩展。

| 使用场景                     | 模型看到什么                                      | OpenPI 的行为                                     |
| ---------------------------- | ------------------------------------------------- | ------------------------------------------------- |
| 普通编码任务                 | Pi 原生 `read` / `bash` / `edit` / `write`        | 默认不常驻任何 OpenPI 模型工具                    |
| 用户明确要求委派或高级能力   | 仅与意图匹配的能力组                              | 在当轮开始前直接加载，不要求用户记住工具名        |
| 用户主动开启 `adaptive`      | 一个小型 `openpi_load_tools` 网关                 | 主模型判断确有收益时，可自主加载一个能力组        |
| 后台任务或子 Agent 已经运行  | 对应的状态、等待、继续与停止工具                  | 管理面随真实资源出现，资源结束后按生命周期收敛    |

这套设计保住了两件通常很难同时拥有的东西：Pi 的清爽基本面，以及完整工程工作台的能力上限。

---

## 30 秒开始

```bash
pi install npm:@tt-a1i/openpi
```

重启 Pi，或在当前 Session 运行 `/reload`。然后直接描述真实任务：

```text
在后台启动前端 dev server；用子代理并行检查 API 主链路和测试覆盖；
结果回来后汇总风险，主会话不要原地等待。
```

OpenPI 会把长期进程放到后台，把独立任务交给隔离 Context 的 Pi Subagent，把多阶段依赖组织成 Workflow。状态会持续显示；完整运行可从 `/ps`、`/subagents` 和 `/workflows` 检查或终止。

> [!TIP]
> Capability discovery 默认 `explicit`：明确说出能力意图才会加载对应组。英文 `subagent` 与 `workflow` 是保留授权词，单独输入也会加载对应能力。
> 例如 `subagent, workflow` → 同时加载两组；「在后台运行 dev server」→ 后台终端；「用/使用子代理检查」或句首「子代理了解下项目」→ Subagent；「用工作流编排」→ Workflow；「用 fd/rg 搜索」或「用 git diff 比较分支」→ 搜索与只读 Git 工具。
> 关键是把意图说清楚（说「用子代理」「子代理检查项目」「后台运行」这类带执行动作的短语），不需要记住任何工具名。仅讨论能力的「子代理是什么」不会加载；否定或条件表达也继续 fail closed。
> `/plan` 是一个运行时安全例外：进入或恢复 Plan Mode 时会为当前 Session 自动加载 `search` 组，让只读调研直接使用结构化 Git 工具。
> 在交互输入框中，保留词 `Subagent` / `Workflow`，以及已被识别的中文能力请求，会使用 Claude Code 风格的薰衣草紫显示；浅色终端自动使用更深的紫色以维持可读性。变色表示提交后会加载对应能力。因为英文名称本身就是授权词，讨论中写出它们也会开闸；条件句和否定句仍保持普通显示，Suggestion 幽灵文字也要在用户接受进输入框后才参与识别。

Skill 使用 Pi 原生机制：模型根据名称、描述和路径按需用 `read` 读取；用户明确调用时，在输入开头使用 `/skill:code-review 审查这个 PR`（前提是 Pi 已加载该 Skill）。候选补全、正文展开和运行中追加输入均由 Pi 处理。OpenPI 不提供专门的 `$skill` 语法或独立的 Skill 加载通道。

Skill 正文通过原生用户消息或工具结果进入正常 Session 历史，压缩也交给 Pi。OpenPI 不另存正文快照，不叠加隐藏正文，也不在压缩后自动补回。压缩后不保证全文仍在模型上下文中；需要时可重新读取或显式调用。普通 `read` 的输出限制和模型总上下文限制仍然适用。设计边界见 [Decision 0002](docs/decisions/0002-native-skill-lifecycle.md)。

> [!IMPORTANT]
> 默认安装是安静的：不改主题、不绑定 Provider 或模型、不开启下一步预测，也不执行 post-edit 命令。Capability discovery 默认 `explicit`；只有用户通过 `/openpi-setup` 选择 `adaptive` 后，模型才会常驻看到一个小型发现网关并可自主加载额外能力。

```text
/openpi-setup
```

---

## OpenPI 解决什么

Pi 的价值在于小：Agent loop、工具、Session 与扩展 API 已经足够。真实项目缺的不是另一套平台，而是围绕这些原语的一层可靠运行时。

| 开发现场                                | OpenPI 的处理方式                                                            | 保留的边界                         |
| --------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------- |
| Dev server、watcher、长测试占住主 Agent | 后台 Terminal 管理进程树、日志、超时与完成通知                               | 无 stdin；Session 结束时有界清理   |
| 调研、实现、审查互相污染 Context        | 每个 Subagent 使用独立的进程内 Pi SDK Session                                | Child 不能递归编排或拿回父级工具   |
| 多阶段 fan-out 靠 Prompt 约定           | Workflow 提供 pipeline、schema、handoff、验收与持久产物                      | Sandbox 不暴露文件、网络或进程 API |
| 重跑昂贵，却不能信任旧结果              | 只 Replay 在可观测边界内证明为只读且指纹未变的调用                           | 不确定就真实执行，不猜             |
| 长任务跨回合后失去方向                  | Tasks、Goal、Plan Mode 与 Context Pivot 分别管理工作项、目标、批准和阶段切换 | 它们记录与控制，不伪造执行事实     |
| 后台能力看不见、停不住                  | Footer、Dashboard、Artifacts 与完成通知统一展示状态                          | 每类运行都有检查、取消与唯一终态   |

**核心原则：增强 Pi 的深度，不扩大隐式权限。** OpenPI 沿用用户已有的 Provider、模型、Skills、Trust 与 Session；Suggestion 只有用户开启后才运行，Subagent / Workflow 只在明确的任务动作后运行——主 Agent 调用对应工具，或用户在交互 TUI 中执行 `/btw`——不会因安装或启动自行消费模型。

---

## 能力地图

OpenPI 把成熟 Coding Agent 的工作习惯做成 Pi-native 能力，但不复制另一套 Runtime：

| 工作面       | 已包含的能力                                                                                              |
| ------------ | --------------------------------------------------------------------------------------------------------- |
| 执行         | Background Terminal、Pi-native Subagent、Dynamic Workflow、隔离 Worktree                                  |
| 编排         | `pipeline` / `parallel`、结构化输出、Result Handoff、Operator、Safe Replay、派生 Graph |
| 连续性       | Tasks、Goal、Plan Mode、Context Pivot、Session Browser、Session-scoped Cron                               |
| 自定义 Agent | `explorer` / `implementer` / `reviewer` / `advisor`，支持全局与项目角色文件、独立模型与 effort            |
| 终端工作台   | 自定义 Footer 与任务栏、运行状态、紧凑 Tool Result、Next-action Suggestion、Git / PR 信号                 |
| 快捷工作流   | `/btw` 旁路提问（TUI）、`/lg` 浏览 Diff（TUI）、`/pr` 查 PR、`/copy-all`、`fd`、`rg`、只读 Git 工具       |
| 人类决策     | `ask_user` 草稿与最终复核、parent-only `human_handoff`、Plan Ready 实施门禁                               |
| 统一配置     | `/openpi-setup` 管理 OpenPI 自有模型、并发、Footer、输出密度与 Post-edit 偏好                             |
| 模型授权     | `/login google-antigravity`；实验性的 `/login cursor`（仅聊天，不执行 Cursor 原生工具）                   |

OpenPI 采用 [MIT License](LICENSE)；第三方来源与保留声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

---

## 运行模型

<p align="center">
  <picture>
    <source media="(max-width: 820px)" srcset="assets/readme-runtime-mobile.svg">
    <img src="assets/readme-runtime.svg" alt="OpenPI runtime: one parent Pi session, three execution paths, continuity, and observability" width="100%" />
  </picture>
</p>

主 Pi Session 始终拥有用户交互、配置和生命周期。Terminal、Subagent 与 Workflow 是三条执行路径；Tasks、Goal、Session 和 Context Pivot 保持连续性；Footer、Dashboard、Artifacts 与清理逻辑负责观察和控制。

### 一项任务应该去哪里？

```text
长期进程                         → Background Terminal
一项自包含、可继续对话的委派     → Subagent
多阶段、依赖、fan-out 与综合      → Workflow
跨回合工作项                     → Tasks
持续自主目标                     → Goal
同一 Session 的阶段切换          → Context Pivot
真正跨顶层 Session               → 独立 pi-intercom package（按需安装）
```

---

## 三条执行路径

### Background Terminal：长期进程不阻塞 Agent

```text
bg_start({
  command: "npm run dev",
  title: "web dev server"
})
```

- stdout / stderr 独立捕获，完整日志有私有、有界的临时落盘；
- `/ps` 查看状态，`bg_kill` 终止整个进程树；
- 进程退出后自动通知，不需要轮询；
- build、test、migration 可设置 `timeout_seconds`；
- server 和 watcher 不设超时，可用 `bg_watch` 等待 `Ready in|Traceback|ERROR`；
- 最多同时运行 8 个后台终端，Reload 或 Session Shutdown 时统一清理。

后台进程没有 stdin。需要交互输入的命令应由用户直接运行，而不是放进后台。

前台执行沿用 Pi 的 Bash 合同：`timeout` 可选且没有统一默认值，是否设置以及设置多长由模型或用户按命令语义决定。OpenPI 不再通过正则改写测试命令 timeout；确实需要有界执行时应显式传入 timeout，长期运行的 build、test、migration 或 server 可使用 Background Terminal 的生命周期能力。

### Pi-native Subagent：隔离 Context，不另起系统

```text
subagent_spawn({
  agent_type: "explorer",
  name: "audit auth flow",
  prompt: "Trace src/auth end to end and report file:line evidence."
})
```

每个 Subagent 都是新的进程内 Pi SDK Session：

- 默认继承父会话的 Provider 与模型；用户可明确指定 Thinking Level，否则模型根据角色建议、任务难度与目标模型实际支持的档位选择；
- 继承普通 child-safe 工具、Skills、项目说明与 Trust 决策；
- 最多 4 个模型发起的 Subagent 并发运行，结束后自动回传；
- 可 `check`、`wait`、`cancel`，也可用 `subagent_send` 继续同一子会话；
- 输入框下方显示实时摘要，空输入时按 `↓` 聚焦，`Enter` 或 `→` 打开管理界面。

内置角色由 Harness 强制工具边界，不靠 Prompt 自律：

| `agent_type`  | 适合             | 相对 effort 建议    | 强制能力                      |
| ------------- | ---------------- | ------------------- | ----------------------------- |
| `explorer`    | 代码追踪与探索   | 中等，难题可提高    | 只读发现工具                  |
| `implementer` | 聚焦实现         | 中高，按范围与风险调整 | read / bash / edit / write 等 |
| `reviewer`    | 正确性与回归审查 | 较高                | 只读发现工具                  |
| `advisor`     | 深度技术建议     | 较高                | 只读发现工具                  |

上述只是模型的相对选择提示，不会为内置角色写死具体档位。用户明确指定的 `reasoning_effort` 始终优先；否则模型结合任务难度，从目标模型实际支持的档位中选择。

角色可由全局 `~/.pi/agent/agents/*.md` 或受信任项目 `.pi/agents/*.md` 覆盖。模型优先级是：显式调用 > Agent Type 文件 > `/openpi-setup` 角色模型 > 父模型继承。更高优先级定义损坏时会阻断 fallback，而不是悄悄退回更宽松的能力。

<details>
<summary><strong>并行写文件时如何隔离 Worktree？</strong></summary>

默认并行 Agent 共享 checkout 与 git index。只读 fan-out 不受影响；并行写入应使用：

```text
subagent_spawn({
  name: "implement retry",
  isolation: "worktree",
  prompt: "Implement the retry path, test it, and commit the result."
})
```

Worktree 建在 `.git/pi-worktrees/`，拥有独立 checkout 与分支。已提交工作会删除 checkout、保留分支；dirty、untracked、ignored 文件，detached HEAD，Git 探测失败或超时都会保留现场。只有完整证明为空时才回收。

全新 checkout 不包含 `.env` 或其他 gitignored 内容。可用时 OpenPI 会在 worktree 中建立 `node_modules` 依赖 symlink。

</details>

### Dynamic Workflow：让多 Agent 工作有阶段、有证据、有产物

单个 Subagent 负责一项委派。Workflow 处理阶段依赖、动态 fan-out、结构化结果、恢复与综合：

```js
phase("Scan");
const checked = await pipeline(
  files,
  (file) =>
    agent(`Trace ${file} for reliability risks`, {
      agent_type: "explorer",
      label: `scan:${file}`,
      schema: FINDING_SCHEMA,
    }),
  (scan, file) =>
    scan.ok
      ? agent(`Verify findings in ${file}`, {
          agent_type: "reviewer",
          label: `verify:${file}`,
          inputs: [scan.ref],
        })
      : null,
);

phase("Report");
const verified = checked.filter((result) => result?.ok);
log(`${verified.length}/${checked.length} files verified`);
return agent("Synthesize the verified findings", {
  agent_type: "advisor",
  inputs: verified.map((result) => result.ref),
});
```

| 原语         | 作用                                                                       |
| ------------ | -------------------------------------------------------------------------- |
| `phase()`    | 标记当前阶段                                                               |
| `log()`      | 向实时界面与最终报告追加一行进度                                           |
| `usage()`    | 读取累计 Token、缓存、成本及本轮并发/调用余量；Token 是 lower bound，不是预算器 |
| `agent()`    | 启动 Pi Agent；支持 role、schema、inputs、operator 与 worktree |
| `pipeline()` | 每个 item 完成上阶段后立即进入下一阶段；多阶段 fan-out 的默认选择          |
| `parallel()` | 并发 barrier；只在下一阶段确实需要全部结果时使用                           |

Workflow 默认并发 8 个 Agent，单次最多 128 次调用；可配置到 64 和 1024。前台运行可实时查看，后台运行完成后自动回传；`/workflows` 展示阶段、Agent、Transcript、Graph、用量与产物。每个 Child Provider turn 必须在 45 秒内产生模型可见的 thinking、text、tool call 或完成事件，并在持续输出时按进展续期；空 stream start 与 transport heartbeat 不算进展。用户显式配置了更宽的 Pi `httpIdleTimeoutMs` 时沿用该上限。超时会 abort 当前 Child、保留已有 Transcript/usage/evidence，并让 sibling 与后续阶段继续结算。

---

## Workflow 不只是并行

OpenPI 把一次调用拆成可以审计的生命周期，而不是把“进程退出 0”当成业务成功。

### Result Handoff 与派生 Graph

成功调用返回同一 Run 内有效的 opaque `ref`。后续调用通过 `inputs: [previous.ref]` 显式接收上游结论；每个结论最多 16 KiB，合计最多 48 KiB，并标记为不可信数据。Artifacts 从这些引用派生只读 Graph，用来观察 lineage，不参与调度。

### Invocation Ledger

每次 `agent()` 独立记录 intent、admission 与 execution 状态。崩溃后仍未终结的调用恢复为 `uncertain`，不会猜成成功、失败或安全重试。这不是跨重启 exactly-once，也不伪装成 exactly-once。

### Safe Replay

`resume_from_run_id` 只 Replay 在 OpenPI 可观测边界内能证明为只读、且指纹未变的调用。指纹覆盖 prompt、schema、model/provider/effort、规范化 cwd、仓库状态、已加载资源与 Trust；外部进程造成但未进入这些观测面的变化不在保证范围内。

以下调用一定真实执行：

- 无 Agent Type，或工具范围无限制；
- 带 `bash`、`edit`、`write` 或未知自定义工具；
- 使用 per-call Worktree；
- ignored 文件可能影响结果却无法纳入指纹；
- Journal、资源、路径、并发重叠或指纹状态不确定。

匹配依据是调用内容，不是并发完成顺序。失败调用不缓存；Journal 有 2 MiB 上限。

### Operator Continuity

`operator: "name"` 在同一 Run 内复用一个内存 Child Session，并把同名 activation 串行化。首个 activation 固定 model、role/tool surface、effort、structured mode 与 cwd。Operator 不与 per-call Worktree 或 Replay 混用，也不承诺跨重启持久记忆。

### Deprecated Acceptance compatibility

`acceptance` 自 OpenPI 0.5 起弃用，并计划在 1.0 删除。兼容期仍读取旧 DSL、journal 与 artifact，但 ledger 只是执行任务的同一个模型所写的 `model-self-attestation`，不是 runtime-observed evidence，也不再决定 `agent().ok`；`ok` 只表示 child execution 与结果制品是否成功。

新 Workflow 应使用普通 `schema` 返回判断材料，由父模型结合退出码、测试结果、文件指纹和 tool receipts 等真实运行时事实综合判断。旧的可选 `acceptance: { criteria: [...] }` 仍可要求同一个 Agent 返回 ledger：

```js
acceptance: {
  criteria: [
    {
      id: "tests",
      description: "Focused tests pass.",
      requiredEvidence: ["test-command"],
    },
  ],
}
```

条件缺失、格式错误或被拒绝时，原始输出与 ledger 仍保留并明确标注 authority/deprecation；它们不会把成功执行改成失败，也不会把失败执行改成成功。OpenPI 不会暗中再启动 reviewer、Shell 或额外 Judge 模型。

未设置 `requiredEvidence` 的 criterion 是对 `description` 的自我声明，不是有证据约束的验收门禁；需要 evidence-backed gate 时，必须声明所需证据标签。

### Worktree Handoff

Workflow 在清理隔离 checkout 前原子保存有界 Handoff Manifest：tracked binary patch、stat、branch/HEAD、untracked/ignored 清单与 cleanup receipt。状态不明就保留现场，不自动 merge、apply 或强删。

设计细节见 [Workflow invocation graph](https://github.com/openpi-dev/openpi/blob/main/docs/design/WORKFLOW_INVOCATION_GRAPH.md)。

---

## 连续工作，而不是堆 Context

| 能力          | 使用方式                                | 它负责什么                                                          |
| ------------- | --------------------------------------- | ------------------------------------------------------------------- |
| Tasks         | `tasks_add` / `tasks_update` / `/tasks` | 逐项同步当前批次工作意图并刷新完整快照；不推断完成、不执行工作      |
| Goal          | `/goal <目标>`                          | 驱动一个持续到终态的自主目标；完成前要求证据审计                    |
| Plan Mode     | `/plan [目标]`                          | 自动加载结构化搜索/Git 做只读调研；`plan_ready` 后才准备实施 Prompt |
| Context Pivot | `/context-pivot <下一阶段>`             | Context 超过约 30K Tokens 且任务换阶段时，用自包含 Brief 替换旧噪音 |
| Sessions      | `/sessions`                             | 搜索、预览并通过 Pi 安全生命周期切换 Session                        |
| Human Input   | `ask_user` / `human_handoff`            | 收集经复核的决策，或等待只有用户能完成的外部操作                    |

Tasks 是咨询性记录，Goal 是持续目标，Subagent 与 Workflow 才执行工作。文件、Git、测试、Artifacts 和用户确认始终是事实来源。

Next-action Suggestion 是可选的：完整主 Agent Run 结束后，在空编辑器显示一条暗色 inline 建议；`Right` 只填入、不提交，其他输入取消。它默认关闭，不写入 Session，也不进入模型 Context。

---

## 终端体验

默认 Footer 把真实运行状态压进一行，指标自带小图标（无需 Nerd Font):

```text
 model   context                ⎇ git  PR   cwd
```

Footer 使用一套 Codicon 线性图标：`` 模型、`` context、`` 目录；`⎇` 表示分支。`thinking`、`cache`、`cost`、`throughput` 也是可选指标，可通过 `/openpi-setup` 加入自定义布局。未安装包含 Codicons 的 Nerd Font 时，图标可能显示为空框，但后面的文字指标仍然完整可读。

- 默认把高频的模型与 context 放在最左侧，把项目定位信息归到右侧，并以当前目录作为最右锚点；支持 `powerline`、`powerline-mono`、`compact`，也支持自定义多行布局；
- 终端变窄时按优先级隐藏次要指标，不机械截断尾部；
- Subagent 与 Workflow 活动时自动出现，空闲时不占空间；
- Bash、Write/Edit 与 Subagent 结果可独立选择 `full` 或 `compact`，默认均为 `compact`；普通 `read`、`grep`、`find`、`ls` 以及 compact Bash/Write/Edit 默认显示一行语义活动摘要，包含目标、状态与关键规模；Nerd Font 可为读取、终端、编辑、搜索和目录动作显示 Codex 风格线框图标，未安装时动词与全部信息仍保持可读；
- 折叠内容用 Pi 的 `app.tools.expand` 快捷键临时展开（默认 `Ctrl+O`），展开后直接恢复 Pi 原生参数、输出、错误、diff、耗时与 full-output 证据；进入 Direct Subagent 或 Workflow child 详情页时会继承父会话的当前展开状态，详情页内切换只影响该页，不改变父会话；
- Git 状态本地刷新；只有显式运行 `/pr` 才查询 GitHub PR。

`fd` 与 `rg` 是结构化模型工具，不拼接 Shell。它们默认遵守 `.gitignore`，支持 Glob、类型、Smart Case、固定字符串与上下文。`git_show`、`git_diff`、`git_log` 以结构化参数提供只读提交、差异和历史检查，并禁用仓库配置的 external diff/textconv。两类工具的输出均限制为 50 KiB / 2000 行，完整截断内容最多私有保存 10 MiB，并在 Session Shutdown 时清理。

macOS/Linux arm64 与 x64 缺少二进制时，OpenPI 会从官方 Release 下载固定版本、校验 SHA-256 后原子安装。其他平台需自行提供 `fd` 与 `rg`。

---

## 安全边界

这里的安全不是一段 Prompt，而是运行时约束。

| 边界             | 行为                                                                      |
| ---------------- | ------------------------------------------------------------------------- |
| Child 递归编排   | 禁止；Subagent / Workflow child 不获得父级编排、交互与状态工具            |
| Agent Type 工具  | Harness 强制白名单；声明不能突破父级 denylist                             |
| 类型与工具预检   | 未知、损坏、错名或最终未注册的工具在首个 Token 前失败                     |
| Workflow Sandbox | 无文件、网络、进程、import、eval 或 timer API；进程仅可读启动包目录       |
| Replay           | 只有可证明只读、指纹完整且无不安全重叠的调用才缓存                        |
| Worktree 清理    | 未知即保留；Git、Handoff 或超时状态不确定时绝不删除                       |
| 终端输出         | 控制字符、方向格式符与超长内容在 ingress / render 边界清洗、限长          |
| Shutdown         | Terminal、Subagent、Workflow 都有有界取消、清理与唯一终态                 |
| 用户配置         | 单一受限 typed tool 写入；不散落扩展私有配置入口                          |
| 模型消费         | Suggestion 默认关闭；adaptive 仅在显式开启后允许模型自主加载能力           |

独立的 [pi-intercom](https://github.com/nicobailon/pi-intercom) package 只适合顶层 Pi Session。它使用进程级身份，而 OpenPI Child 是同一进程内的并发 Session；Child Resource Loader 会从 npm、Git 和 local package source 中精确移除 pi-intercom 扩展与 Skill，避免身份串线，同时保留普通同名项目资源。Replay 也不会复用其调用。

---

## 配置与参考

### 一个配置入口

```text
/openpi-setup
/my-pi-setup  # legacy alias
```

无参数时，OpenPI 展示当前状态并引导修改；带自然语言时只改指定项：

<!-- config-contract: capabilities.discovery suggestions.enabled suggestions.model workflows.concurrency workflows.maxAgentCalls ui.showHeader ui.customFooter ui.footerStyle ui.footerLines ui.subagentResultDisplay ui.bashToolDisplay ui.fileMutationDisplay postEdit.command subagents.roleModels -->

```text
/openpi-setup 开启下一步预测，选择 Registry 里的轻量模型，minimal 推理
/openpi-setup 让模型在合适时自主发现并采用 OpenPI 能力
/openpi-setup workflow 同时跑 16 个 agent，总调用最多 256
/openpi-setup Footer 两行：cwd flex model / context cost flex git
/openpi-setup Bash 展开，Write/Edit 保持紧凑
/openpi-setup 编辑后自动跑 npm run format
/openpi-setup 给 explorer 指定模型，让 reviewer 继承父模型
```

配置保存在 `~/.pi/agent/my-pi-setup.json`，与包代码分离，升级不会覆盖。

Footer 布局以 `footerLines` 作为唯一持久化格式。旧版 `footerItems` 会在读取时迁移，但迁移后的配置不保证能被旧版 OpenPI 正确解释，因此不承诺配置文件的降级兼容性。

一次 `/openpi-setup` episode 最多成功写入一次；成功后配置工具立即隐藏。若本轮没有成功写入，Runtime 会追加一条可见、持久且进入后续模型上下文的关闭凭据，明确 writer 已隐藏，后续修改必须重新执行 `/openpi-setup <自然语言请求>`。writer 只有在 OpenPI 能验证当前激活的是包自身定义时才可用；重复或来源不匹配会显式 fail closed，不会发布假的 setup-active 状态。不要让模型重调已隐藏工具，也不要绕过入口直接编辑配置文件。

<details>
<summary><strong>默认值</strong></summary>

| 配置                         | 默认值                                         |
| ---------------------------- | ---------------------------------------------- |
| Capability discovery         | `explicit`；`adaptive` 必须显式开启            |
| Next-action Suggestion       | 关闭；启用时显式选择 Registry 模型与 reasoning |
| Workflow 并发 / 总调用       | 8 / 128；硬上限 64 / 1024                      |
| 大型 Header                  | 关闭                                           |
| Dashboard Footer             | 开启；单行 `plain`                           |
| Subagent / Bash / Write/Edit | `compact` / `compact` / `compact`             |
| Post-edit 命令               | 关闭；单条命令最多 500 字符                    |
| 内置角色模型                 | 全部继承父模型                                 |
| 主题                         | 保留用户现有选择                               |

</details>

### 安装要求与来源

- Pi `0.84.1` 或更新版本；
- Node.js `22.19.0` 或更新版本；
- npm 安装：`pi install npm:@tt-a1i/openpi`；
- GitHub 安装：`pi install git:github.com/openpi-dev/openpi`。

#### 开发运行时：区分 npm 与当前源码

npm 制品、GitHub 安装和本地 checkout 是三个不同的运行资产。源码目录更新、测试通过或版本号相同，都不能证明当前 Pi 已经加载这份代码。所有本地开发、Provider 兼容排查、手工 smoke 和 UI 验收都使用下面这一条证据链。

**1. 先固定源码和加载来源**

```bash
git status --short --branch
git rev-parse --short HEAD
pi list
```

完成标准：知道正在修改哪个 checkout、分支和提交；`pi list` 中只有一个 OpenPI 来源，并能明确它是 npm、GitHub 还是某个本地绝对路径。其他 Pi package（例如 `pi-intercom`）不属于重复 OpenPI 来源。

**2. 开发时让 Pi 直接加载当前 checkout**

```bash
git clone https://github.com/openpi-dev/openpi.git ~/work/openpi
cd ~/work/openpi
bun install --frozen-lockfile

# 若 pi list 显示了旧 OpenPI，把变量设为它显示的 package spec 或绝对路径。
OLD_OPENPI_SOURCE=/absolute/path/to/old/openpi
pi remove "$OLD_OPENPI_SOURCE"
pi install "$PWD"
pi list
```

已经安装当前 checkout 时，不需要反复 remove/install。切换分支或修改源码后，运行 `/reload` 或重启 Pi 才会重载扩展。`/reload` 之前的界面和工具集合只证明旧内存状态。

完成标准：`pi list` 唯一的 OpenPI 路径就是当前 checkout，且该路径的 HEAD 与预期提交一致。不要修改 `~/.pi/agent/npm/node_modules/@tt-a1i/openpi` 来冒充源码修复。

**3. 分层验证改动**

```bash
# 开发环：先运行与改动最接近的测试，并沿用 package.json 的 runner。
node --test --experimental-strip-types path/to/relevant.test.ts
bunx vitest run path/to/relevant.spec.ts

# 仓库门禁：提交或交付前两项都要通过。
bun run check
bun run test
```

自动化通过只证明代码、类型和测试合同。涉及运行时或界面时，还要在已 `/reload` 的真实 Pi 中完成对应 smoke：

- 工具或生命周期改动：在普通工具模式实际触发成功、失败和结束路径；
- Provider 兼容改动：保留正常工具 Schema，不用 `--no-tools` 绕过问题；
- UI 改动：在真实 TUI 触发目标状态并肉眼检查，必要时保存截图；
- 配置改动：通过 `/openpi-setup` 写入，再核对无参数状态输出和实际行为。

完成标准：分别记录 checkout HEAD、`pi list` 来源、专项测试、`bun run check`、完整测试和手工 smoke。没有执行的层级写成“未验证”，不能用另一层的绿色结果代替。

**4. 保持工作区可恢复**

- 开始前检查 dirty worktree；保存用户的未提交、未跟踪和 ignored 文件；
- 本地 Benchmark、日志和原始结果可以通过 `.git/info/exclude` 隐藏，但 ignore 不是备份；
- 使用 `git clean -nd` 只能预览普通未跟踪文件；不要运行会删除 ignored 资产的 `git clean -fdx`；
- 稳定运行副本和开发 checkout 只有在确有隔离需求时才并存，并始终用 `pi list` 说明 Pi 加载哪一个；
- 提交前复查 diff，确保本地配置、密钥、模型结果和评测原始数据没有进入版本控制。

Host SDK 与 TypeBox 按 Pi Package 契约声明为 Peer Dependencies；仓库开发依赖不随包重复提供。

### 独立可选：顶层 Pi Session 通信

[pi-intercom](https://github.com/nicobailon/pi-intercom) 是独立维护的 Pi package。OpenPI 不探测、推荐、安装或配置它；需要跨顶层 Session 通信时，请先审查其独立仓库，再通过 Pi 原生 package 命令按需安装：

```bash
pi install npm:pi-intercom
```

安装、配置和升级均由 Pi 与 pi-intercom 自身负责；OpenPI 不写入或迁移已有 intercom 偏好。跨顶层 Session 可使用 pi-intercom，OpenPI 父子委派继续使用 `subagent_*` 与 Workflow 原生结果通道。

### 独立 Web 工作台

Web runtime 不嵌入交互式终端 Session。它由独立进程创建自己的 Pi `AgentSessionRuntime`、独立 `~/.pi/agent/web-sessions` 持久化目录和生命周期；浏览器发送消息、新建 Session 或切换工作区，不会写入或切换任何已经运行的终端 Pi Session，Web Session 也不会出现在终端的默认 Session 列表中。在侧栏选择 Session 会把它激活为 Web 进程的当前 Pi Session；Prompt 只会投递到请求时仍匹配的活动 Web Session。独立的只读历史浏览不属于首版范围。

同一 Pi agent 目录一次只允许一个 Web Host 持有该 Session/元数据目录。第二个 `openpi web` 会明确拒绝启动；正常关停会先排空共享目录变更再释放租约，进程崩溃后仅在确认原 owner 的 PID 与进程启动身份不再匹配时恢复。一个 Host 可在侧栏管理多个工作区，因此不需要为每个仓库启动一个进程。

Host 仅监听 loopback。启动链接中的高熵 token 属于本次 Web Host 进程，浏览器会从 URL fragment 取出后保存到当前标签页的 `sessionStorage`，并立即清除地址栏 fragment；关闭 Host 后该 token 失效。这不是远程身份或长期登录机制。

发布包提供 `openpi` 可执行文件。需要同时使用终端扩展和 Web 时，安装同一版本的 Pi package 与 CLI：

```bash
pi install npm:@tt-a1i/openpi
npm install --global @tt-a1i/openpi
openpi web                    # 使用当前目录启动 Web
openpi web /path/to/repo      # 指定初始工作区
```

两处应保持同一 OpenPI 版本。Pi 的 managed package 与全局 CLI 即使位于不同物理路径，同一 Web 进程内也通过带版本的共享 registry 按 Pi `SessionManager` 身份连接 capability 投影；它不保存第二份状态，也不兼容任意混装版本。

已经在 Pi 中安装 OpenPI 时，也可以直接执行 `/web`。它通过 Pi 官方的交互式终端 seam 暂停当前 TUI，运行当前 package 内完全相同的 `openpi web` 子进程，并在 `Ctrl+C` 停止 Web 后恢复原来的终端 Session。运行期间终端只归 Web 子进程使用；父 Pi 不读取按键，也不会把当前 Session id、消息、上下文或工作目录传给浏览器。Web 会恢复它自己的已有 Session 和工作区；没有可用项时，由用户在浏览器中添加或选择，不会把启动 `/web` 时的终端目录自动注册为 Web 工作区。选择前的内部引导态不暴露 Session、不绑定 extension 生命周期，也不接受 Prompt 或模型变更。选择工作区后发送第一条消息会先创建真实 Web Session，再向它投递。

Pi 当前只原生分派 `install`、`remove`、`update`、`list`、`config` 和 `auth` 等固定子命令，package 不能注册新的顶层子命令。因此 Web 入口是独立 CLI 的 `openpi web`，不是会被 Pi 当成初始 Prompt 的 `pi open`。Web 进程仍沿用 Pi 的 Provider、模型、凭据、Settings、Trust、Session 格式和 extension 资源加载，不引入第二套 Provider 或 Session 存储。

### 命令速查

| 命令                       | 作用                                           |
| -------------------------- | ---------------------------------------------- |
| `/openpi-setup [自然语言]` | 查看或修改 OpenPI 自有配置                     |
| `/web`                     | 前台运行独立 Web 工作台；`Ctrl+C` 后返回 Pi    |
| `/ps`                      | 查看、跟踪与终止后台终端                       |
| `/subagents` / `/btw`      | 管理 Subagent / 在旁路 Context 中提问；仅 TUI  |
| `/workflows`               | 查看阶段、Agent、Graph 与产物；可停止运行      |
| `/tasks` / `/goal ...`     | 查看工作项 / 管理持续目标                      |
| `/context-pivot <阶段>`    | 在同一 Session 中压缩旧阶段并继续              |
| `/sessions`                | 搜索、预览与切换 Session                       |
| `/plan [目标]`             | 只读调研；Plan Ready 后显式选择实施方式        |
| `/cron ...`                | 为当前 Session 安排一次或周期性 Prompt         |
| `/lg` / `/pr`              | 浏览 Diff（`/lg` 仅 TUI）/ 显式刷新当前分支 PR |
| `/copy-all`                | 复制当前分支可见对话                           |

<details>
<summary><strong>模型工具速查</strong></summary>

Capability discovery 默认是 `explicit`：普通父 Session 不常驻任何 OpenPI 模型工具，首轮保持 Pi 原生 `read`、`bash`、`edit`、`write`。用户明确要求结构化搜索、Subagent、Workflow、后台进程或 Session Goal/Tasks 时，OpenPI 在 `before_agent_start` 直接加载对应能力组；明确询问 OpenPI capabilities/tools/features 时显示 `openpi_load_tools`。可通过 `/openpi-setup` 显式选择 `adaptive`：此时只让小型 `openpi_load_tools` 网关常驻，模型可在判断任务确实受益时自主加载一个能力组。该选择也授权模型启动该组内的昂贵工作，因此不作为默认值。句首「子代理了解下项目」这类带执行动作的表达会加载 Delegate；「子代理是什么」这类讨论、否定表达和条件句（例如 “If you delegate…”）不会被当成显式委派意图。能力组在当前 Session 内单调保持，避免反复增删工具破坏缓存。Delegate 一经加载便一次性开放完整、稳定的 Subagent 工具族；资源不存在时由工具执行层明确返回空状态或 fail-closed，而不再按实例生命周期改变模型接口。其他组内管理工具仍只在资源成功创建或状态确实存在后出现。Mode / Setup / Context 工具独立跟随实时状态显示和隐藏。Background、Subagent 与 Workflow 的 Skill 文件仍随包发布，但只在对应能力触发后提示读取，不常驻普通系统 Prompt。

普通产品采用 Pi-native execution：保留 Pi 原生完整历史、工具输出上限、Session compaction、显式 Bash timeout 与 provider loop，不额外做固定事务投影、成功 Bash 二次裁剪、测试 timeout 改写、重复失败硬拦或恢复/轨迹提示。OpenPI 只保留一层工作区清理护栏：源码中可识别的 `rm` 只有在整条命令是直接、可静态验证的 literal `rm`，且目标都是工作区内相对路径时，才会进入 provenance 与确认流程；可识别的复合、嵌套或动态 target `rm` 会 fail closed，并提示改用独立的 literal `rm` 重试。单条 standalone 普通命令中可静态识别的 bare、single-quoted 或 double-quoted 参数、Bash comment，以及独占输入的单个非展开 heredoc 中的 `rm` 文本不受影响；复合命令、已知 command forwarder 和带后续命令的 heredoc 会保守阻止 source-visible `rm`，可拆成独立命令重试。Guard 会从实际文件状态识别本轮通过原生写入、文字重定向或 literal `mkdir -p` 创建的 scratch，避免误拦其清理；它不是任意程序文件系统行为的 sandbox，也不承诺识别运行时生成的命令名或其他程序内部的文件系统行为。

| 工具                                                                                                     | 用途                           | 可见时机                         |
| -------------------------------------------------------------------------------------------------------- | ------------------------------ | -------------------------------- |
| `openpi_load_tools`                                                                                      | 列出或加载可选工具组           | 明确询问；或启用 `adaptive`      |
| `bg_start`, `bg_status`, `bg_list`, `bg_watch`, `bg_kill`                                                | 后台进程生命周期               | 明确意图或 adaptive；启动后展开  |
| `subagent_spawn`, `subagent_check`, `subagent_list`, `subagent_wait`, `subagent_send`, `subagent_cancel` | 独立子 Agent                   | 明确意图或 adaptive；整组稳定加载 |
| `workflow`, `workflow_status`, `workflow_stop`                                                           | 动态多阶段编排与运行管理       | 明确意图或 adaptive；能力组一次稳定展开 |
| `tasks_add`, `tasks_update`, `tasks_list`                                                                | Session 工作项                 | 明确意图或 adaptive；存在后展开  |
| `get_goal`, `create_goal`, `update_goal`                                                                 | Session Goal                   | 明确意图或 adaptive；存在后展开  |
| `context_pivot`                                                                                          | Context 阶段切换               | Context 达到阈值时               |
| `ask_user`, `human_handoff`                                                                              | 经复核的用户决策与用户专属操作 | Plan 或 Setup 进行中             |
| `plan_ready`                                                                                             | 显式完成计划，不自动开始实施   | Plan 调研阶段                    |
| `fd`, `rg`, `git_show`, `git_diff`, `git_log`                                                            | 文件、内容与只读 Git 检查      | 明确意图或 adaptive 加载 search  |
| `configure_my_pi_setup`                                                                                  | 受限配置写入                   | `/openpi-setup` 进行中           |

</details>

### 可选主题

包内注册 `github-dark-default`，但不自动切换。通过 Pi `/settings` 选择即可。

---

## FAQ

<details>
<summary><strong>安装后会自动调用额外模型吗？</strong></summary>

默认不会。Suggestion 默认关闭；Capability discovery 默认 `explicit`。如果用户显式开启 `adaptive`，网关本身不发模型请求，但主模型可以自主加载 Subagent 或 Workflow 并启动额外模型调用；并发和 Workflow 总调用上限仍然生效。

</details>

<details>
<summary><strong>Subagent 会阻塞主 Agent 吗？</strong></summary>

`subagent_spawn` 立即返回，结束后自动回传并重新唤醒主 Agent。交互会话没有其他工作时，主 Agent 应结束当前轮、让用户继续交互；“下一步依赖结果”本身不是阻塞理由。只有用户明确要求当前回复等完，或非交互自动化必须在同一次调用中返回完整结果时，才应调用 `subagent_wait`。

</details>

<details>
<summary><strong>为什么同时提供 Subagent 和 Workflow？</strong></summary>

Subagent 是一项可继续对话的自包含委派；Workflow 是多阶段编排，强调 fan-out、结构化结果、恢复、验收与持久产物。前者可以接管继续，后者更适合自动化流水线。

</details>

<details>
<summary><strong>Plan Mode 为什么允许 git log，却拒绝 npm install？</strong></summary>

Plan Mode 不猜“任意 Shell 是否只读”，只放行由已知安全零件组成的命令。不会生成 diff 的窄白名单 Git / GitHub 查询（例如原始 `git log`、`git status`、`git blame`）可以通过；Shell 元字符、未知 flag、安装、写入和无法证明的形式全部拒绝。

进入或恢复 Plan Mode 时，OpenPI 会为当前 Session 加载 `search` 组。差异检查使用结构化 `git_diff` / `git_show`，历史浏览使用 `git_log`；前两者固定传入 `--no-ext-diff --no-textconv --no-color`。原始 Bash `git diff`、`git show`、`git whatchanged`，以及 `git log -p`、`--stat`、`--name-only`、`-L` 等会生成 diff 的形式会被拒绝，避免仓库的 `diff.external` 或 textconv driver 执行外部程序。

这项保证精确覆盖 Git diff driver 边界，并不宣称任意 hostile Git 配置都无副作用；其余允许的 Git 调研命令仍位于 Pi 已有的项目 Trust 边界内。

</details>

<details>
<summary><strong>后台服务会不会变成孤儿进程？</strong></summary>

正常的 `/new`、`/resume`、`/fork`、`/reload` 与退出都会触发 Session Shutdown。扩展会终止后台进程树并清理临时日志；也可随时用 `bg_kill` 或 `/ps` 管理。

</details>

<details>
<summary><strong>这是稳定 API 吗？</strong></summary>

这是持续实际使用的独立发行版，不承诺扩展 API 永远不变。改动会经过 TypeScript、格式检查与专项测试；Pi 上游变化时，优先保持 Session 生命周期、工具边界、结果去重与资源清理这些行为不变量。

</details>

---

## 仓库结构与开发

```text
extensions/
├── ai-providers/          # Antigravity 与实验性 Cursor OAuth 模型 Provider
├── setup/                 # /openpi-setup 与受限配置工具
├── capabilities/          # 最小能力发现入口与 Session 工具面加载
├── background-terminals/  # 长进程、日志、/ps
├── subagents/             # Pi-native Backend、角色、/subagents
├── workflows/             # DSL、Ledger、Graph、Replay、Artifacts
├── tasks/ + goal/         # 工作项与持续目标
├── context-pivot/         # 定向 Compaction
├── plan-mode/ + cron/     # 批准门禁与 Session 定时 Prompt
├── ask-user/              # Reviewed input 与 Human Handoff
├── workspace-cleanup-guard/ # pre-existing 文件删除保护
├── file-search/           # fd / rg 与安全二进制获取
├── git-read/              # 只读 git show / diff / log
├── sessions/              # Session 搜索与切换
├── suggestions/           # Ephemeral next-action suggestion
├── ui-customization/      # Header、Footer、Terminal title
└── shared/                # Child policy、配置、Worktree、终端清洗

bin/openpi.js              # 独立 Web CLI 入口
web/                       # Web Host、Pi Runtime Adapter、协议与浏览器 UI
skills/                    # Background terminal、Subagent 与 Workflow 指南
themes/                    # github-dark-default
```

Web 日常开发、前后端边界、Vite HMR 和后端自动重启说明见 [`docs/development/OPENPI_WEB_DEVELOPMENT.md`](docs/development/OPENPI_WEB_DEVELOPMENT.md)。正式运行仍使用 `openpi web [workspace]`；Vite 只用于本地 UI 开发。

开发工具链使用 Bun `1.3.14` 管理依赖和脚本，Biome 负责 TypeScript / JavaScript / JSON 格式与基础 lint；产品运行时仍是 Node，测试仍由 `node:test` 与 Vitest 执行：

根目录的 `tsconfig.json` 是所有 extension 的唯一 TypeScript 项目配置；不要在 extension 目录中添加局部 `tsconfig.json`。单独类型检查使用根目录的 `bun run typecheck`，完整校验执行：

```bash
bun install --frozen-lockfile
bun run check
bun run test
```

npm 仍用于发布包的 `pack` / clean-install 验证，因为用户通过 npm Registry 安装 OpenPI。

测试覆盖进程树终止与竞态、Subagent 生命周期与工具边界、Workflow Sandbox / Ledger / Graph / Replay / Acceptance、Worktree 数据保全、Session 状态恢复、配置迁移和 TUI 渲染。设计记录见 [docs/design/](https://github.com/openpi-dev/openpi/tree/main/docs/design/)，问题请提交到 [GitHub Issues](https://github.com/openpi-dev/openpi/issues)。

---

## 来源、许可与致谢

本项目最初基于 [davis7dotsh/my-pi-setup](https://github.com/davis7dotsh/my-pi-setup) 演进，现作为独立发行版维护。感谢原作者提供起点。

`extensions/ai-providers/` 的部分协议实现改编自 [oh-my-pi](https://github.com/can1357/oh-my-pi)；`extensions/sessions/` 改编自 [jayshah5696/pi-agent-extensions](https://github.com/jayshah5696/pi-agent-extensions)。独立可选的顶层 Session 通信 package 见 [pi-intercom](https://github.com/nicobailon/pi-intercom)。完整第三方说明见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。

本项目以 MIT 许可证发布（见 [`LICENSE`](LICENSE)）；`THIRD_PARTY_NOTICES.md` 记录第三方来源与各自许可。
