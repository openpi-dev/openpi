<p align="center">
  <img src="assets/openpi-package.png" alt="OpenPI logo" width="240" />
</p>

<h1 align="center">OpenPI</h1>

<p align="center">
  <strong>给 Pi 补上后台执行、多 Agent 编排、持久任务和可观测终端，同时保留它原本的轻量与可控。</strong>
</p>

<p align="center">
  <a href="https://github.com/earendil-works/pi-mono"><img alt="Pi 0.84.1+" src="https://img.shields.io/badge/Pi-0.84.1%2B-2f81f7?style=flat-square"></a>
  <img alt="Node.js 22.19+" src="https://img.shields.io/badge/Node.js-22.19%2B-3fb950?style=flat-square&logo=nodedotjs&logoColor=white">
  <img alt="TypeScript strict" src="https://img.shields.io/badge/TypeScript-strict-3178c6?style=flat-square&logo=typescript&logoColor=white">
  <a href="https://github.com/tt-a1i/my-pi-setup/actions/workflows/ci.yml"><img alt="CI status" src="https://github.com/tt-a1i/my-pi-setup/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="Model neutral" src="https://img.shields.io/badge/models-user--selected-bc8cff?style=flat-square">
</p>

<p align="center">
  一套在真实开发中持续使用的 <a href="https://pi.dev">Pi</a> 扩展包。<br />
  不替你选模型，不强制主题，安装后也不会偷偷增加模型调用。
</p>

<p align="center">
  <sub>OpenPI 是独立社区项目，与 Physical Intelligence 的 openpi 机器人项目及 Pi 官方均无关联。</sub>
</p>

<p align="center">
  <a href="#快速开始"><strong>快速开始</strong></a> ·
  <a href="#为什么装它">为什么装它</a> ·
  <a href="#核心能力">核心能力</a> ·
  <a href="#安全边界">安全边界</a> ·
  <a href="#统一配置">统一配置</a> ·
  <a href="#命令速查">命令速查</a> ·
  <a href="#faq">FAQ</a>
</p>

---

## 快速开始

```bash
pi install npm:@tt-a1i/openpi
```

重启 Pi，或在当前 Session 运行 `/reload`。然后直接描述任务：

```text
启动前端 dev server；并行让两个子 Agent 检查 API 主链路和测试覆盖；
结果回来后汇总风险，主会话不要原地等待。
```

Pi 会把长期进程放到后台，把独立任务交给隔离 Context 的子 Agent，并在结果完成时自动继续。Subagent 和 Workflow 状态显示在 Footer；后台终端有编辑器上方状态条，完整信息分别从 `/ps`、`/subagents` 和 `/workflows` 查看。

> [!IMPORTANT]
> 默认安装是安静的：不修改主题、不绑定 Provider 或模型、不开启下一步预测，也不执行 post-edit 命令。所有用户偏好统一通过 `/openpi-setup` 显式配置。

> [!TIP]
> `subagent_spawn` 会立即返回。主 Agent 应继续处理确定性工作；只有下一步确实依赖子 Agent 结果时，才调用 `subagent_wait`。

---

## 为什么装它

Pi 的价值在于小：Agent loop、工具、Session 和扩展 API 都有，但工作方式没有被平台写死。真实项目需要的，则是围绕这些原语的一层可靠运行时。

<table>
<tr>
<td width="33%" valign="top">
<strong>后台执行</strong><br/><br/>
Dev server、watcher、build 和长测试不再占住主 Agent。日志可查，超时可控，退出自动回传。
</td>
<td width="33%" valign="top">
<strong>干净委派</strong><br/><br/>
Subagent 使用独立 Pi Context。调研、实现和审查可以并行，不把全部过程塞回主会话。
</td>
<td width="33%" valign="top">
<strong>动态编排</strong><br/><br/>
Workflow 支持 pipeline、parallel、结构化输出、显式验收、恢复执行和持久产物。
</td>
</tr>
<tr>
<td width="33%" valign="top">
<strong>连续工作</strong><br/><br/>
Tasks 记工作项，Goal 驱动持续目标，Context Pivot 在阶段变化时主动换一块干净工作面。
</td>
<td width="33%" valign="top">
<strong>全程可见</strong><br/><br/>
模型、Context、缓存、成本、Git、PR 与后台活动集中显示；每类运行都有检查和取消入口。
</td>
<td width="33%" valign="top">
<strong>边界明确</strong><br/><br/>
子 Agent 不能递归编排；未知工具、不可证明安全的 Replay、状态不明的 Worktree 一律 fail closed。
</td>
</tr>
</table>

### 运行模型

<p align="center">
  <picture>
    <source media="(max-width: 640px)" srcset="assets/readme-runtime-mobile.svg">
    <img src="assets/readme-runtime.svg" alt="OpenPI runtime model" width="100%" />
  </picture>
</p>

主 Pi Session 始终拥有用户交互、配置和生命周期。后台 Terminal、Subagent 与 Workflow 是三条执行路径；Tasks、Goal、Session 和 Context Pivot 保持连续性；Footer、Dashboard、Artifacts 与清理逻辑负责可观察性。

---

## 核心能力

### 1. 后台终端：长期进程不再阻塞 Agent

```text
bg_start({
  command: "npm run dev",
  title: "web dev server"
})
```

- stdout / stderr 独立捕获，完整日志有私有、有界的临时落盘；
- `/ps` 查看状态与日志，`bg_kill` 终止整个进程树；
- 进程退出后自动通知，不需要轮询；
- build、test、migration 可设置 `timeout_seconds`；
- server 和 watcher 不设超时，用 `bg_watch` 等待 `Ready in|Traceback|ERROR` 一类字面签名；
- 最多同时运行 8 个后台终端；Session 关闭或 Reload 时统一清理。

后台终端没有 stdin，因此不适合交互式程序。它适合 server、watch mode、长测试和流式构建。

### 2. Pi-native Subagents：隔离 Context，而不是另起一套系统

```text
subagent_spawn({
  agent_type: "explorer",
  name: "audit auth flow",
  prompt: "Trace src/auth end to end and report file:line evidence."
})
```

每个 Subagent 都是新的进程内 Pi SDK Session：

- 默认继承父会话的 Provider、模型和 Thinking Level；
- 继承普通 child-safe 工具、Skills、项目说明与 Trust 决策，但不获得父级编排/交互工具；
- 最多 4 个模型发起的 Subagent 并发运行；`/btw` 使用独立小池；
- 结束后自动回传，可 `check`、`wait`、`cancel`；
- `subagent_send` 可以继续指导运行中的 Agent，也能恢复刚结束的同一子会话；
- 输入框下方展示实时摘要，空输入时按 `↓` 聚焦，`Enter` 或 `→` 打开管理界面。

内置角色由 harness 强制工具边界，不靠提示词自律：

| `agent_type`  | 用途           | 默认 effort | 强制能力                         |
| ------------- | -------------- | ----------- | -------------------------------- |
| `explorer`    | 代码追踪与探索 | high        | 只读发现工具                     |
| `implementer` | 聚焦实现       | high        | read / bash / edit / write 等    |
| `reviewer`    | 正确性与回归审查 | medium      | 只读发现工具                     |
| `advisor`     | 深度技术建议   | xhigh       | 只读发现工具                     |

角色可由全局 `~/.pi/agent/agents/*.md` 或受信任项目 `.pi/agents/*.md` 完整覆盖。精确格式、工具清单与优先级见 [`extensions/subagents/docs/agent-types.md`](https://github.com/tt-a1i/my-pi-setup/blob/main/extensions/subagents/docs/agent-types.md)。

<details>
<summary><strong>并行写文件时如何隔离 Worktree？</strong></summary>

默认并行 Agent 共享 checkout 和 git index。只读 fan-out 不受影响；会写文件的并行任务应开启：

```text
subagent_spawn({
  name: "implement retry",
  isolation: "worktree",
  prompt: "Implement the retry path, test it, and commit the result."
})
```

Worktree 建在 `.git/pi-worktrees/`，拥有独立 checkout 和分支。Direct Subagent 的 checkout 与它的可恢复 Session 同寿命。退役时，已提交工作删除 checkout、保留分支；dirty/untracked/ignored 文件、detached HEAD、Git 探测失败或超时则保留 checkout 路径。只有完整证明为空时才全部回收。

全新 checkout 不包含 `.env` 或其他 gitignored 内容。可用时会在 `.git/pi-worktrees/node_modules` 建立依赖 symlink，让 checkout 通过父目录解析依赖；Worktree 仍要求当前目录是 Git 仓库。

</details>

<details>
<summary><strong>模型与 Agent Type 的优先级</strong></summary>

模型：显式调用 > Agent Type 文件 > `/openpi-setup` 的角色模型 > 父模型继承。

Effort：显式调用 > Agent Type 默认值 > 父会话。

同名角色定义：内置 < 全局 < 受信任项目。更高优先级文件如果损坏，会阻断 fallback，而不是悄悄退回更宽松的定义。工具白名单只能收窄，也无法重新拿回父会话专属工具。

</details>

### 3. Dynamic Workflows：让多 Agent 任务有阶段、有证据、有产物

单个 Subagent 负责一项自包含委派。Workflow 处理多阶段、有依赖、需要 fan-out 和综合的任务：

```js
phase("Scan");
const checked = await pipeline(
  files,
  (file) =>
    agent(`Trace ${file} for reliability risks with file:line evidence`, {
      agent_type: "explorer",
      label: `scan:${file}`,
      schema: FINDING_SCHEMA,
    }),
  (scan, file) =>
    scan.ok
      ? agent(`Verify these findings in ${file}: ${scan.output}`, {
          agent_type: "reviewer",
          label: `verify:${file}`,
        })
      : null,
);

phase("Report");
log(`${checked.filter(Boolean).length}/${checked.length} files verified`);
return await agent(`Synthesize: ${JSON.stringify(checked)}`, {
  agent_type: "advisor",
});
```

| 原语         | 作用                                                                 |
| ------------ | -------------------------------------------------------------------- |
| `phase()`    | 标记当前阶段                                                         |
| `log()`      | 向实时界面与最终报告追加一行进度                                     |
| `usage()`    | 读取累计 Token、缓存与成本的单调 lower bound；它不是预算限制器        |
| `agent()`    | 启动一个隔离 Pi Agent，可指定 role、schema、acceptance 或 worktree    |
| `pipeline()` | 每个 item 完成上一阶段后立即进入下一阶段；多阶段 fan-out 的默认选择   |
| `parallel()` | 并发 barrier；只有下一阶段确实需要全部结果时使用                      |

Workflow 默认并发 8 个 Agent、单次最多 128 次调用；可分别配置到 64 和 1024。Workflow DSL 不暴露文件、网络或进程 API；Sandbox 进程只保留启动所需的包目录读取权限。`usage()` 在 Agent 压缩 Context 后可能低估实际总量，只适合观察趋势。前台运行可实时查看，后台运行完成后自动回传；`/workflows` 检查阶段、Agent、Transcript、用量与产物，`workflow_stop` 或 Dashboard 中的 `x` 可以取消。

<details>
<summary><strong>Replay、Acceptance Ledger 与隔离写入</strong></summary>

`resume_from_run_id` 只 Replay 能被完整证明为只读且上下文未变的调用。指纹覆盖 prompt、schema、model/provider/effort、规范化 cwd、仓库状态、已加载资源和 Trust。下列调用一定真实执行：

- 无 Agent Type 或工具范围无限制；
- 带 `bash`、`edit`、`write` 或未知自定义工具；
- 使用 `isolation: "worktree"`；
- 存在会影响结果但无法纳入指纹的 ignored 文件；
- 旧 journal、指纹失败，或与不可缓存调用发生不安全重叠。

匹配依据是调用内容，不是调用序号，因此 `pipeline()` 的并发完成顺序变化不会把 A 的结果错配给 B。失败调用从不缓存。Journal 上限 2MB，超出后丢弃最旧条目并显式报告。

可选 `acceptance: { criteria: [...] }` 要求同一个 Agent 返回 evidence ledger。条件缺失、格式错误或被拒绝时，该调用 `ok: false`，但原始输出与 ledger 仍保留；不会暗中再启动 reviewer 或 shell。

并行写入使用 `isolation: "worktree"`。Workflow 在清理 checkout 前原子保存有界 handoff manifest，包括 tracked binary patch、stat、branch/HEAD、untracked/ignored 清单和 cleanup receipt。状态不明时保留，不自动 merge、apply 或强删。

</details>

---

## 连续性与交互

<table>
<tr>
<td width="50%" valign="top">
<strong>Session Tasks</strong><br/><br/>
<code>tasks_add / tasks_update / tasks_list</code><br/>
跨 Agent Run 和用户回合记录当前批次的工作意图。稳定 ID、可审计状态、Session 分支恢复；全部完成后关闭批次，下批从 T1 重新开始。Tasks 不执行工作。
</td>
<td width="50%" valign="top">
<strong>Session Goal</strong><br/><br/>
<code>/goal &lt;目标&gt;</code><br/>
Codex 风格的持久自主目标。支持 pause、resume、edit、clear 和可选 Token budget；系统规则要求模型先完成证据审计再声明 complete，工具本身只记录声明。
</td>
</tr>
<tr>
<td width="50%" valign="top">
<strong>Context Pivot</strong><br/><br/>
<code>/context-pivot &lt;下一阶段&gt;</code><br/>
Context 超过约 30K Tokens 且任务切换阶段时，用自包含 Brief 替换旧阶段噪音，在同一 Session 继续。普通超长对话仍用 Pi 原生 <code>/compact</code>。
</td>
<td width="50%" valign="top">
<strong>Session Browser</strong><br/><br/>
<code>/sessions</code><br/>
按名称、首条消息、Session ID 和目录搜索；预览 User、Assistant、Tool 与 Summary；通过 Pi 安全生命周期切换。
</td>
</tr>
<tr>
<td width="50%" valign="top">
<strong>Reviewed Human Input</strong><br/><br/>
<code>ask_user</code> · <code>human_handoff</code><br/>
<code>ask_user</code> 在 TUI/RPC 中收集 1–3 个结构化决策，支持 Notes、预览、草稿修改与提交前复核；空白自由输入会要求模型重写或拆分问题。只有用户能完成的登录、授权或硬件操作才使用 parent-only handoff，Done 后仍须验证完成信号。
</td>
<td width="50%" valign="top">
<strong>Next-action Suggestion</strong><br/><br/>
完整主 Agent Run 结束后，可在空编辑器首行显示一条暗色 inline 建议。行尾为中文 IME 预留预编辑区域，避免拼音覆盖建议；<code>Right</code> 只填入、不提交，其他输入取消。默认关闭且不写入 Session 或模型 Context。
</td>
</tr>
</table>

### Tasks 与 Goal 怎么分工

- Tasks 是多个工作项的咨询性记录，不调度、不委派，也不参与 Goal 完成判定；
- Goal 是一个持续到终态的自主目标，模型只能提交 `complete` 或经过连续审计的 `blocked`；
- Subagent 与 Workflow 才执行工作；文件、Git、测试、Artifacts 和用户确认仍是事实来源。

### Plan Mode、Cron 与 Post-edit

- `/plan [目标]` 先做只读调研；模型以 `plan_ready` 显式提交完整计划后，`/plan` 才提供继续规划、当前 Session 实施或 Fresh Session 实施。两个实施入口都只填入可编辑 Prompt，不自动提交；Planning/Ready 状态按 Session branch 持久化并在 Reload、Resume、Tree navigation 后恢复；Plan Mode 使用严格命令白名单，不尝试“理解”任意 Shell 是否只读；
- `/cron ...` 在当前 Session 中排定一次或周期性提示词；
- Post-edit 可在成功 Write/Edit 的 Turn 后运行一条用户配置的命令，例如 `npm run format`。默认关闭，最多 500 字符，不猜测 Bash 是否改过文件。

---

## 终端体验

### 一行 Footer，持续显示真实状态

默认 Powerline Footer：

```text
cwd  model  thinking  context  cache  cost  throughput   git  PR
```

支持 `powerline`、`powerline-mono` 与 `compact` 三个 preset，也可用 `footerLines` 自定义多行布局。终端变窄时按优先级隐藏次要指标，而不是机械截断尾部。

| 指标         | 内容                                     |
| ------------ | ---------------------------------------- |
| `cwd`        | 当前目录                                 |
| `model`      | Provider / Model                         |
| `thinking`   | Thinking 档位                            |
| `context`    | Context 占用与容量；占用未知时只显示容量 |
| `cache`      | Session 报告的 Prompt Cache 命中率       |
| `cost`       | Session 累计成本                         |
| `throughput` | 当前流式运行的估算 Token 速度            |
| `git` / `pr` | 当前分支与对应 PR                        |
| `flex`       | 同一行左右对齐的分隔点                   |

Subagent 与 Workflow 状态属于 Footer 的基础可观察性：活动时自动出现，空闲时不占空间。后台终端使用编辑器上方状态条和 `/ps`，不混进 Footer。本地 Git 状态自动刷新；GitHub PR 查询只有用户显式运行 `/pr` 时才会发起。Nerd Font 只改善 Powerline 分隔符 ``，不是硬依赖。

### 输出密度按内容类型独立控制

- Subagent 结果默认完整显示；
- Bash 默认折叠为单行命令、有限输出与最终状态；
- Write/Edit 默认最多显示三行渲染内容；
- 三类结果都能在 `/openpi-setup` 中独立切换 `full` / `compact`；
- 折叠内容用 Pi 当前的 `app.tools.expand` 快捷键临时展开，默认是 `Ctrl+O`。

### 文件搜索是一等工具

`fd` 与 `rg` 使用结构化参数，不拼接 Shell；默认遵守 `.gitignore`，支持 Glob、类型、Smart Case、固定字符串和上下文。结果限制为 50KB / 2000 行；不超过 10 MiB 的完整截断内容保存在 Session 临时文件中并于 Shutdown 时清理，超过该上限时搜索会终止且部分临时文件会立即删除。

macOS/Linux 的 arm64 与 x64 环境缺少二进制时，会通过 HTTPS 下载固定官方版本、校验 SHA-256 后原子安装。其他架构和平台需自行提供 `fd` 与 `rg`。

---

## 安全边界

这里的安全不是一段 Prompt，而是运行时约束。

| 边界                     | 行为                                                                 |
| ------------------------ | -------------------------------------------------------------------- |
| 子 Agent 递归编排        | 禁止。Subagent/Workflow child 不获得 `subagent_*`、`workflow` 等父级工具 |
| Agent Type 工具          | Harness 强制白名单；声明不能突破父级 denylist                        |
| 类型与工具预检           | 未知、损坏、错名或最终未注册的工具在首个 Token 前失败                 |
| Workflow Sandbox         | DSL 无文件、网络、进程、import、eval 或 timer API；进程仅可读启动包目录 |
| Replay                   | 只有可证明只读、上下文指纹完整且无不安全重叠的调用才缓存              |
| Worktree 清理            | 未知即保留；Git 状态、handoff 或超时不确定时绝不删除                  |
| 终端输出                 | 控制字符、方向格式符与超长内容在 ingress/render 边界清洗和限长         |
| Shutdown                 | Terminal、Subagent、Workflow 都做有界取消、清理与唯一终态             |
| 用户配置                 | 一个受限 typed tool 写入；没有散落的扩展私有入口                      |
| 模型消费                 | Suggestion 默认关闭；Subagent/Workflow 只在任务显式触发时运行          |

可选的 [pi-intercom](https://github.com/nicobailon/pi-intercom) 只在顶层 Pi Session 加载。它依赖进程级身份，而 Direct/Workflow child 是同一进程内的并发 Session；为避免身份串线，child Resource Loader 会移除 pi-intercom 的扩展与 Skill。

---

## 统一配置

本包只有一个 canonical 用户配置入口；旧命令保留为兼容别名：

```text
/openpi-setup
/my-pi-setup  # legacy alias
```

无参数时，若未安装可选的 pi-intercom，OpenPI 会先用原生确认框说明权限与安全默认值；拒绝不会产生任何改动。随后当前模型解释已有设置与影响并引导修改。直接跟自然语言则只改指定项：

```text
/openpi-setup 开启下一步预测，选择当前 Registry 里的轻量模型，minimal 推理
/openpi-setup workflow 同时跑 16 个 agent，总调用最多 256
/openpi-setup Footer 两行：cwd flex model / context cost flex git
/openpi-setup Footer 用 mono powerline
/openpi-setup Bash 展开，Write/Edit 保持紧凑
/openpi-setup 编辑后自动跑 npm run format
/openpi-setup 给 explorer 指定模型，让 reviewer 继承父模型
```

配置保存在 `~/.pi/agent/my-pi-setup.json`，与包代码分离。升级不会覆盖。

### 默认值

| 配置                     | 默认值                                                       |
| ------------------------ | ------------------------------------------------------------ |
| Next-action suggestion   | 关闭；启用时必须显式选择 Registry 中可用的模型与 reasoning   |
| Workflow 并发            | 8，硬上限 64                                                 |
| Workflow 总 Agent 调用   | 128，硬上限 1024                                             |
| 大型 Header              | 关闭                                                         |
| Dashboard Footer         | 开启；单行 `powerline`                                       |
| Subagent 结果            | `full`                                                       |
| Bash 输出                | `compact`                                                    |
| Write/Edit 输出          | `compact`                                                    |
| Post-edit 命令           | 关闭；单条命令最多 500 字符                                  |
| 内置角色模型             | `explorer / implementer / reviewer / advisor` 均继承父模型   |
| pi-intercom              | 不静默安装；进入 `/openpi-setup` 后由用户明确选择             |
| 主题                     | 保留用户现有选择                                             |

任何新增的模型、开关、权限、并发或 UI 偏好都必须接入 `/openpi-setup`。仓库的 [`AGENTS.md`](https://github.com/tt-a1i/my-pi-setup/blob/main/AGENTS.md) 用测试守住这份单一入口契约。

---

## 安装与可选集成

### 要求

- Pi `0.84.1` 或更新版本；
- Node.js 22.19.0 或更新版本；
- macOS/Linux 的 arm64 或 x64 可自动安装 `fd` / `rg`；其他架构和平台需自行安装。

### Pi Package

```bash
pi install npm:@tt-a1i/openpi
```

需要直接审计当前源码时，也可以从 GitHub 安装：

```bash
pi install git:github.com/tt-a1i/my-pi-setup
```

开发本仓库时可以安装本地 checkout：

```bash
git clone https://github.com/tt-a1i/my-pi-setup.git ~/work/my-pi-setup
cd ~/work/my-pi-setup
npm install
pi install ~/work/my-pi-setup
```

安装或更新后重启 Pi，或运行 `/reload`。Pi 提供的 `pi-ai`、`pi-coding-agent`、`pi-tui` 和 `typebox` 按官方 Package 契约声明为 Peer Dependencies；仓库中的开发依赖仅用于本地检查，不随包重复提供 Host SDK。

### 可选：多个顶层 Pi Session 通信

运行 `/openpi-setup`，在原生确认框中选择安装即可；也可手动执行：

```bash
pi install npm:pi-intercom
```

setup 使用 Pi 官方 Package Manager 安装固定来源 `npm:pi-intercom`。新建的私有配置默认 `confirmSend: true`、`inboundTrigger: "replies"`；已有偏好文件绝不重写，缺少这两个字段或配置损坏时会拒绝安装并给出修复要求。包下载失败不会写配置；启用持久化状态不确定时保留安全配置但明确报告失败。安装成功后需运行 `/reload`。

pi-intercom 通过本地 IPC 传递消息；传输本身不调用模型。OpenPI 保证它只留在顶层 Session，Direct/Workflow child 不加载扩展或 Skill，Replay 也不复用其调用。跨顶层 Session 用 pi-intercom；父子委派继续使用 `subagent_*` 和 Workflow 原生结果通道。

### 可选：GitHub Dark 主题

安装包会注册主题，但不会自动切换。通过 Pi `/settings` 选择 `github-dark-default`，或配置：

```json
{
  "theme": "github-dark-default"
}
```

---

## 命令速查

| 命令                        | 作用                                                            |
| --------------------------- | --------------------------------------------------------------- |
| `/openpi-setup [自然语言]`  | 查看或修改 OpenPI 配置；可选择安装 pi-intercom                  |
| `/my-pi-setup [自然语言]`   | `/openpi-setup` 的兼容别名                                      |
| `/ps`                       | 查看、跟踪和终止后台终端                                        |
| `/subagents`                | 查看、取消或接管子 Agent                                        |
| `/btw`                      | 在旁路 Pi Context 中提问，不打断主任务                          |
| `/workflows`                | 查看阶段、Agent 与产物；`/workflows <id> stop` 取消运行         |
| `/tasks`                    | 查看当前 Session 的工作项                                      |
| `/goal ...`                 | 创建、查看、编辑、暂停或恢复持久 Goal                           |
| `/context-pivot <下一阶段>` | 在同一 Session 中压缩旧阶段并继续                              |
| `/sessions`                 | 搜索、预览并切换 Session                                        |
| `/plan [目标]`              | 只读调研，进入 Plan Ready 后显式选择实施方式                     |
| `/cron ...`                 | 为当前 Session 安排定时或周期性 Prompt                          |
| `/lg` / `/pr`               | 浏览 Working Tree Diff / 刷新当前分支 PR                       |
| `/copy-all`                 | 复制当前分支可见的 User / Assistant 对话                        |

<details>
<summary><strong>模型工具速查</strong></summary>

| 工具                                                                                                     | 用途                                |
| -------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `bg_start`, `bg_status`, `bg_list`, `bg_watch`, `bg_kill`                                                | 后台进程生命周期                    |
| `subagent_spawn`, `subagent_check`, `subagent_list`, `subagent_wait`, `subagent_send`, `subagent_cancel` | 独立子 Agent                        |
| `workflow`, `workflow_status`, `workflow_stop`                                                           | 动态多阶段编排与运行管理            |
| `tasks_add`, `tasks_update`, `tasks_list`                                                                | Session 工作项                      |
| `get_goal`, `create_goal`, `update_goal`                                                                 | Session Goal                        |
| `context_pivot`                                                                                          | Context 阶段切换                    |
| `ask_user`                                                                                               | TUI/RPC 中带草稿与提交前复核的结构化用户决策 |
| `human_handoff`                                                                                          | 等待用户专属操作并返回待验证的状态          |
| `plan_ready`                                                                                             | 显式完成计划，不自动开始实施                |
| `fd`, `rg`                                                                                               | 文件发现与内容搜索                  |
| `configure_my_pi_setup`                                                                                  | 受限配置写入                        |

</details>

---

## 设计原则

### Pi-native first

子 Agent 是 Pi SDK Session，不是独立 CLI。Provider、模型、Skills、Trust 与普通 child-safe 工具沿用用户已有环境；编排、交互和父级状态工具明确移除。

### Context 有明确去向

一项委派交给 Subagent；多阶段依赖交给 Workflow；阶段变化用 Context Pivot；真正跨 Session 用 Handoff；下一步建议只停留在编辑器 UI。

### 后台能力必须可见，也必须能停

Terminal、Subagent、Workflow 都有 ID、状态、检查入口、取消路径、有界 Shutdown 和一次性完成通知。无界后台工作不属于“方便”，只是把问题藏起来。

### 少猜一次，多拒绝一次

不可证明只读就不 Replay，不能确认干净就不删 Worktree，损坏的高优先级角色定义不 fallback。拒绝会留下可见错误；猜错可能留下错误代码、旧结果或丢失数据。

---

## FAQ

<details>
<summary><strong>安装后会自动调用额外模型吗？</strong></summary>

不会。Next-action suggestion 默认关闭；只有用户通过 `/openpi-setup` 显式选择模型后，完整主 Agent Run 结束时才可能增加一次小型预测调用。Subagent 与 Workflow 也只在任务实际触发时运行。

</details>

<details>
<summary><strong>Pi Subagent 会阻塞主 Agent 吗？</strong></summary>

不会。`subagent_spawn` 立即返回，结束后自动回传。只有显式调用 `subagent_wait` 才会等待；它只适合下一步确实依赖结果的场景。

</details>

<details>
<summary><strong>为什么同时提供 Subagent 和 Workflow？</strong></summary>

Subagent 是一项可继续对话的自包含委派；Workflow 是多阶段编排，强调 fan-out、结构化结果、可恢复执行和持久产物。前者可以接管继续，后者更适合自动化流水线。

</details>

<details>
<summary><strong>Plan Mode 下为什么 `git log` 能运行，`npm install` 不能？</strong></summary>

Plan Mode 不分析“任意 Shell 是否只读”，而只放行由已知安全零件组成的命令。它允许窄白名单中的 `git` / `gh` 查询形式；Shell 元字符、未知 flag、安装、写入和无法证明的形式全部拒绝。这里的方向是单向的：放行意味着已证明只读，拒绝只表示未能证明。

Plan Mode 仍可启动只读 Subagent，但会把工具收窄到发现工具；`subagent_send` 和 Workflow 会被拦截，因为它们可能恢复或创建拥有写权限的执行路径。

</details>

<details>
<summary><strong>配置和升级会互相覆盖吗？</strong></summary>

不会。包代码、Pi 自己的模型认证与 `~/.pi/agent/my-pi-setup.json` 相互分离。更新仓库不会重写用户配置。

</details>

<details>
<summary><strong>后台服务会不会变成孤儿进程？</strong></summary>

正常的 `/new`、`/resume`、`/fork`、`/reload` 和退出都会触发 Session Shutdown。扩展会终止后台进程树并清理临时日志；也可随时用 `bg_kill` 或 `/ps` 手动管理。

</details>

<details>
<summary><strong>这是稳定 API 吗？</strong></summary>

这是持续实际使用的独立发行版，不承诺扩展 API 永远不变。改动会经过 TypeScript、格式检查和专项测试；Pi 上游变化时，优先保持 Session 生命周期、工具边界、结果去重和资源清理这些行为不变量。

</details>

---

## 仓库结构

```text
extensions/
├── setup/                 # /openpi-setup、兼容别名与受限配置工具
├── background-terminals/  # 长进程、日志、/ps
├── subagents/             # Pi-native Backend、角色、/subagents
├── workflows/             # DSL、Runner、Sandbox、Replay、Artifacts
├── tasks/                 # Session 工作项
├── goal/                  # 持久自主 Goal
├── context-pivot/         # 定向 Compaction
├── plan-mode/             # 只读调研与批准门禁
├── cron/                  # Session 内定时 Prompt
├── post-edit/             # 成功编辑后的可选命令
├── sessions/              # Session 搜索与切换
├── ask-user/              # 结构化用户输入
├── file-search/           # fd / rg 与安全二进制获取
├── file-mutation-display/ # Bash / Write / Edit 紧凑渲染
├── suggestions/           # Ephemeral next-action suggestion
├── git-info/              # Git、PR 与 /lg
├── model-info/            # Model、Context、Cost、Throughput
├── turn-time/             # Turn 耗时
├── ui-customization/      # Header、Footer、Terminal title
├── copy-all/              # 可见对话复制
└── shared/                # Child policy、配置、Worktree、终端清洗

skills/
├── background-terminals/
└── subagents/

themes/
└── github-dark-default.json
```

扩展通过 Pi Event Bus 和小型共享状态通信。长生命周期资源绑定 Session Shutdown；Workflow JavaScript 在独立 Permission Sandbox 中运行；Agent child 使用 Pi SDK Session 和 Trust-aware Resource Loader。

---

## 开发与验证

```bash
npm install
npm run check
npm run format:check
npm test
```

测试覆盖进程树终止与竞态、Subagent 生命周期与工具边界、Workflow Sandbox/Replay/Acceptance、Worktree 数据保全、文件搜索二进制校验、Session 状态恢复、配置迁移和 TUI 渲染。

设计记录与多模型评估见 [`docs/design/`](https://github.com/tt-a1i/my-pi-setup/tree/main/docs/design)。欢迎通过 [Issues](https://github.com/tt-a1i/my-pi-setup/issues) 提交可复现 Bug 或真实工作流；新增能力应优先复用 Pi 原生原语，并遵守 [`AGENTS.md`](https://github.com/tt-a1i/my-pi-setup/blob/main/AGENTS.md) 的单一配置入口与 child-session 边界。

---

## 来源与致谢

本项目最初基于 [davis7dotsh/my-pi-setup](https://github.com/davis7dotsh/my-pi-setup) 演进，现作为独立发行版维护。感谢原作者提供起点。

`extensions/sessions/` 改编自 [jayshah5696/pi-agent-extensions](https://github.com/jayshah5696/pi-agent-extensions)。可选的顶层 Session 通信由 [pi-intercom](https://github.com/nicobailon/pi-intercom) 提供。完整第三方说明见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。

本仓库目前没有项目级开源许可证；`THIRD_PARTY_NOTICES.md` 只记录第三方来源与各自许可，不等同于授予本项目使用许可。

<p align="center">
  <strong>Small harness. Deep extensions. Clean context.</strong>
</p>
