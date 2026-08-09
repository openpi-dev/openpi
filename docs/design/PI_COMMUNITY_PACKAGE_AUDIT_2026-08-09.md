# Pi 社区包对照审计（2026-08-09）

## 结论

当前不应把任何重叠包直接并入 `my-pi-setup`。本包已经覆盖 Subagent、Workflow、Tasks、Goal、Plan Mode、Ask User、Footer、文件搜索、Session 管理和后台进程；再安装同类包会产生第二套工具名、状态机、配置入口和 child-session 权限模型。

值得继续推进的方向只有四个：

1. **权限系统兼容试点**：`@gotgenes/pi-permission-system` 填补全局 allow/ask/deny 与敏感路径保护空缺，但必须先解决它与本包 in-process child 的加载和询问转发关系。
2. **代码智能只读试点**：`pi-lens` 的 LSP、symbol/module report 和 content-bound diagnostics 是 `fd`/`rg` 的有效补充；默认自动格式化、autofix 和 tests 均开启，因此不能直接按默认值安装。
3. **借鉴交互设计**：从 `@narumitw/pi-plan-mode`、`@juicesharp/rpiv-ask-user-question` 与 `@narumitw/pi-tui-kit` 借鉴 Plan Ready 管理、批量问卷复核、草稿保留、stale-owner cancellation 等模式，不替换现有安全边界。
4. **先修包发布规范**：本包的 Pi core/TypeBox 依赖应改为 peer dependencies。许可证与 npm 发布契约完成前保持 `private: true`；Gallery preview 是推荐的发布质量项，不是技术阻塞。

`pi-web-access` 与 `pi-intercom` 已作为独立用户包安装，不需要再打进本仓库。

## 调研范围与方法

- 读取 [Pi Package Catalog](https://pi.dev/packages) 当前前 50 项；目录总量约 5.3k，下载量只作为发现线索，不作为质量结论。
- 读取 Pi 官方 [Package 文档](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)。
- 对照本仓库源码与 8 个社区仓库的固定提交：
  - [`nicobailon/pi-subagents@7ab2a1b`](https://github.com/nicobailon/pi-subagents/tree/7ab2a1bb5377455775426d5cc40b2c714707a70f)
  - [`QuintinShaw/pi-dynamic-workflows@bab5ad7`](https://github.com/QuintinShaw/pi-dynamic-workflows/tree/bab5ad78457bc2046f34b3ab2964adee9a342c25)
  - [`apmantza/pi-lens@3d8522b`](https://github.com/apmantza/pi-lens/tree/3d8522bbcc5186154671265b2a5c21c95c4bf729)
  - [`gotgenes/pi-packages@4482a5d`](https://github.com/gotgenes/pi-packages/tree/4482a5db8385d4538c206816dc5274fa4ab248b1)
  - [`narumiruna/pi-extensions@5355962`](https://github.com/narumiruna/pi-extensions/tree/535596225994a9c602613207097c6f787a153239)
  - [`juicesharp/rpiv-mono@226ec6e`](https://github.com/juicesharp/rpiv-mono/tree/226ec6e18f94dbed334a76ff907e1759d768b4bb)
  - [`Hypabolic/Hypa@782953d`](https://github.com/Hypabolic/Hypa/tree/782953d53a9fdb0a5b9f89f8f081a41b366013f5)
  - [`backnotprop/plannotator@d5ae439`](https://github.com/backnotprop/plannotator/tree/d5ae439f7a06d0c461e89db05b30e674ea46bd65)

Pi 包拥有完整系统权限。官方文档明确要求安装前审查源码；以下建议不把 npm 下载量当作安全背书。

## 能力重叠地图

| 社区包 | 与本包关系 | 决策 |
| --- | --- | --- |
| `pi-subagents` | Subagent、Workflow、roles、worktree、resume、observability 高度重叠 | 不安装；只借鉴显式 host verification 和 model scope |
| `@quintinshaw/pi-dynamic-workflows` | Pipeline、parallel、TUI、resume、worktree 高度重叠 | 不安装；本包的 fail-closed isolation 更强 |
| `@juicesharp/rpiv-todo` | 与 Session Tasks 重叠 | 不安装 |
| `@narumitw/pi-goal` | 与 Session Goal 重叠 | 不安装；借鉴状态感知管理菜单 |
| `@narumitw/pi-plan-mode` | 与本包 Plan Mode 重叠 | 不安装；借鉴 Plan Ready 生命周期与 review/export/handoff UX |
| `@juicesharp/rpiv-ask-user-question` | 与 `ask_user` 重叠 | 不安装；借鉴多问题复核与草稿保持 |
| `pi-powerline-footer` / `pi-statusline` | 与可配置 Footer 重叠 | 不安装 |
| `pi-intercom` | 顶层 Pi Session 间通信，互补 | 已独立安装并保持 parent-only |
| `pi-web-access` | Web research，互补 | 已独立安装，不打包 |
| Memory 类包 | 持久 Agent Memory | 与明确约束冲突，不安装 |

## 候选一：权限系统

### 值得借鉴

`@gotgenes/pi-permission-system` 提供统一的 allow/ask/deny gate，覆盖工具、Bash、MCP、Skill、外部目录与敏感路径。它的关键设计符合本包原则：

- 规则同时匹配引用路径与 symlink-resolved canonical path；
- `path → external_directory → per-tool → bash` 采用 most-restrictive-wins；
- 无法解析的 Bash 和内部 gate error 不会静默放行；
- 不受信任项目不能用 project config 放宽 global policy。

来源：[README — What It Does / path policy](https://github.com/gotgenes/pi-packages/blob/4482a5db8385d4538c206816dc5274fa4ab248b1/packages/pi-permission-system/README.md)。

### 为什么不能直接安装

本包的 Direct/Workflow child 是同一进程内的 Pi Session。全局第三方 extension 可能被 child Resource Loader 加载，而 permission system 的 headless `ask` 转发只声明了对其原生 Subagent 集成。未经兼容测试直接安装，会产生三种风险：

1. child 的 `ask` 无 UI、无正确 parent identity；
2. permission policy 与本包 child allowlist/Trust 的 authority 顺序不清楚；
3. `/my-pi-setup` 之外出现第二套配置与批准语义。

### 建议

先做一次临时、父会话限定的兼容试点，不写进本包依赖。正式引入前必须增加：

- third-party extension 的 parent/child 分类；
- project Trust 与 global policy 的 most-restrictive contract test；
- external path、symlink、malformed Bash、无 authority、shutdown 场景测试；
- headless child 明确 deny 或可审计地转发到唯一 parent UI。

不引入 `pi-permission-model-judge`。模型裁决只能作为显式、deny-first 的可选优化，不能成为权限根。

## 候选二：代码智能

### 值得借鉴

`pi-lens` 补足本包目前没有的语义代码反馈：

- LSP diagnostics 与 navigation；
- `symbol_search → module_report → read_symbol/read_enclosing` 的低 Context 导航链；
- diagnostics 与 workspace/content state 绑定，减少旧诊断误报；
- AST structural search 和 impact/review graph。

来源：[pi-lens README](https://github.com/apmantza/pi-lens/blob/3d8522bbcc5186154671265b2a5c21c95c4bf729/README.md)、[Agent tools](https://github.com/apmantza/pi-lens/blob/3d8522bbcc5186154671265b2a5c21c95c4bf729/docs/agent-tools.md)。

### 风险

它不是轻量只读 LSP adapter。当前 npm 包解压约 19 MB，包含 grammar、AST/LSP/scan 工具和可选外部程序。更重要的是默认配置中以下能力开启：

- LSP diagnostics；
- deferred autoformat；
- autofix；
- test runner；
- Opengrep；
- read-before-edit monitor；
- context injection。

来源：[Settings — Defaults at a glance](https://github.com/apmantza/pi-lens/blob/3d8522bbcc5186154671265b2a5c21c95c4bf729/docs/settings.md#defaults-at-a-glance)。

### 建议

作为独立 companion 做 mutation-minimized 试点，不立即加入本包，也不在验证前称为“只读”。试点初始策略：关闭 format、autofix、tests、额外 scanner 和 context injection，只评估 diagnostics、symbol search、module report、read symbol。Lens 允许 project `.pi-lens.json` 重新开启部分 mutation path；正式试点必须先用恶意 project config 验证 one-way CLI disables 仍占优，或在隔离环境中完全阻止 project config 加载。通过以下门槛后再决定：

- 对 TypeScript/Python/Go 各选一个真实项目，比较 `fd/rg` 与 Lens 的定位正确率、Tool calls、Token 和首结果延迟；
- 所有 path 必须限制在 trusted workspace，LSP subprocess 有界退出；
- 每个 Lens tool 明确分类为 parent-only 或 child-safe；未分类时 child 不可见；
- adversarial project config 无法重新开启任何 mutation path，否则试点失败。

## 最值得移植的交互设计

### 1. Plan Ready 生命周期

`@narumitw/pi-plan-mode` 的安全策略与本包不同，不应直接替换。但它的产品状态比当前 `/plan` 完整：

- `plan_mode_complete` 显式结束规划，不从自然语言猜测；
- completed plan 进入 ready state；
- 用户可 review、save、export、implement here，或启动 fresh linked session 只携带批准后的 plan；
- reload/resume/compaction 保留精确 plan，清理策略与具体 implementation 绑定。

来源：[pi-plan-mode README](https://github.com/narumiruna/pi-extensions/blob/535596225994a9c602613207097c6f787a153239/packages/pi-plan-mode/README.md)。

本包应保留自己的严格 Bash whitelist 和 child narrowing，只移植最小状态机：

```text
inactive → planning → ready → implementing / saved / cleared
```

第一版只需要 `/plan` 状态菜单、独立完成工具、review、Implement here、Start fresh、Clear。Export/retention 等到真实需求出现再加。

### 2. Ask User 的提交前复核

`@juicesharp/rpiv-ask-user-question` 有几项明显优于当前顺序式问卷：

- 多问题用 tabs 切换；
- Submit tab 汇总答案并提示未回答项；
- 自由输入和 Notes 的草稿在切换选项后保留；
- 可折叠 overlay 阅读背后的 transcript；
- RPC/ACP 使用 host dialog，non-interactive 模式直接移除工具。

来源：[rpiv-ask-user-question README](https://github.com/juicesharp/rpiv-mono/blob/226ec6e18f94dbed334a76ff907e1759d768b4bb/packages/rpiv-ask-user-question/README.md)。

本包应保留现有 `ask_user` 名称、1–3 问题、互斥选项和 child exclusion。最小改进顺序：Submit review → 草稿保持 → collapse transcript → RPC degradation。Multi-select 会改变现有 schema，不先做。

### 3. TUI 生命周期模式

`@narumitw/pi-tui-kit` 已解决多个容易出错的交互细节：

- generation/AbortSignal 防 stale owner 回写；
- owner replacement、外部 dispose、pending work drain；
- disabled reason、rejected action rollback；
- TUI/RPC 双通道；
- settings/input/review/multi-select 等标准 screen。

来源：[pi-tui-kit README](https://github.com/narumiruna/pi-extensions/blob/535596225994a9c602613207097c6f787a153239/packages/pi-tui-kit/README.md)。

现在不增加依赖。Plan manager 与 Ask User review 都开始实现后，再比较复用 kit 与本地继续维护的总代码量；只有第三个相同交互出现时才抽公共层。

## 只借概念、不直接采用

### 显式 host verification

`pi-subagents` 的 acceptance 支持 deterministic verify commands 和 independent review。当前 Workflow Acceptance Ledger 刻意没有隐式 shell 或额外模型调用，这个约束应保留。

如果未来增加 verification，必须是调用方显式声明的独立阶段：

- 命令、cwd、timeout 和 worktree 明示；
- 计入调用/时间/资源账本；
- 输出进入 evidence ledger；
- independent reviewer 显示为单独 child/model call；
- 任何 trust 或状态不确定均拒绝。

来源：[pi-subagents acceptance implementation](https://github.com/nicobailon/pi-subagents/blob/7ab2a1bb5377455775426d5cc40b2c714707a70f/src/runs/shared/acceptance.ts)。

### 可恢复的输出压缩

Hypa 的正确方向不是“让模型总结日志”，而是 deterministic reducer + full artifact + provenance/TTL。这个模式可用于改进内置 Bash 大输出；本包的 `fd`/`rg` 和 Background Terminal 已经有有界输出与完整落盘，不需要第二套 authority。

不直接安装 `@hypabolic/pi-hypa`：它带独立 CLI/runtime、postinstall shim、SQLite trust/artifact authority，且许可为 FSL-1.1-ALv2。

来源：[Hypa README](https://github.com/Hypabolic/Hypa/blob/782953d53a9fdb0a5b9f89f8f081a41b366013f5/README.md)、[pi-hypa package](https://github.com/Hypabolic/Hypa/blob/782953d53a9fdb0a5b9f89f8f081a41b366013f5/packages/pi-hypa/package.json)。

## 明确不采用

### 第二套 Subagent / Workflow runtime

`pi-subagents` 增加 Missions/Schedules、external CLI runner、fallback、per-agent memory 等本包明确不需要的表面积。可参考其 model scope 与 acceptance，但不引入 runtime。

`@quintinshaw/pi-dynamic-workflows` 的功能面高度重叠，且 capability contract 明确写着：请求 Worktree isolation 失败后会记录并继续使用共享工作区。这与本包“未知即保留、隔离失败即拒绝”冲突。

来源：[dynamic-workflows capability contract](https://github.com/QuintinShaw/pi-dynamic-workflows/blob/bab5ad78457bc2046f34b3ab2964adee9a342c25/src/workflow-capability-contract.ts#L305-L320)。

### Plannotator 直接接管 Plan Mode

Plannotator 的浏览器 Plan/Code Review UI 很强，尤其是行级 annotation 和 plan diff；可以作为用户主动安装的 review 工具。但它的 Pi Plan Mode 文档同时声明 planning phase 的 Bash unrestricted，主要靠 system prompt 避免破坏性命令，不能替换本包的机械门禁。

来源：[Plannotator Pi extension](https://github.com/backnotprop/plannotator/blob/d5ae439f7a06d0c461e89db05b30e674ea46bd65/apps/pi-extension/README.md)。

若以后集成，只调用它的 `plan-review` / `code-review` event API，继续由本包拥有 Plan Mode、工具边界和执行状态机。

### Persistent Memory

`pi-hermes-memory`、`pi-memory`、Remnic 等与“暂不引入持久 Agent Memory”冲突。Session Search、Tasks、Goal 和 Context Pivot 已覆盖当前连续性需求。

## 本包自身的 Package 修正

Pi 官方文档要求这些 Pi core packages 以 `peerDependencies: { "*" }` 声明，不应放在 runtime `dependencies`：

- `@earendil-works/pi-ai`
- `@earendil-works/pi-coding-agent`
- `@earendil-works/pi-tui`
- `typebox`

当前 `package.json` 不符合这一建议。修正时将它们放入 `peerDependencies`，并在 `devDependencies` 保留开发版本，避免独立 module root 与类型/运行时身份漂移。

Gallery 只收录 npm 上带 `pi-package` keyword 的包，支持 `pi.image`（PNG/JPEG/GIF/WebP）或 `pi.video`（MP4）。本仓库当前：

- `private: true`；
- 没有项目级开源许可证；
- 没有 npm 发布；
- `pi` manifest 没有 Gallery preview；
- 缺少 `repository`、`homepage`、`bugs`、`engines`、明确 `files` 白名单和 pack/install smoke test。

因此发布顺序应为：许可证决策 → peer dependency 修正 → `npm pack --dry-run` / 临时安装 smoke → npm publish。PNG/MP4 preview 可选，但建议在公开推广前补齐并验证 Gallery 展示。Fork Network 是否脱离不影响 npm 技术发布，但会影响项目归属表达。

来源：[Pi Package docs — Dependencies / Gallery Metadata](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md#dependencies)。

## 建议路线图

### P0：包卫生与发布准备

1. 决定项目级许可证；未决定前保持 private。
2. 修正 Pi core/TypeBox peer dependencies。
3. 增加 `npm pack --dry-run`、临时目录安装和 `pi -e` smoke test。
4. 补 `repository/homepage/bugs/engines/files`。
5. 导出 README Hero 的静态 PNG 作为 Gallery image。

### P1：产品 UX

1. 给 `/plan` 增加 `planning → ready` 状态和显式完成工具。
2. Ready 菜单先实现 Review / Implement here / Start fresh / Clear。
3. Ask User 增加 Submit review 和 per-question draft retention。
4. 两处完成后再决定是否引入 `@narumitw/pi-tui-kit`。

### P1：外部能力试点

1. Permission System：只在临时父会话和 restrictive policy 下验证；正式安装前完成 child compatibility。
2. pi-lens：mutation path 全关，只评估只读 diagnostics/navigation；建立真实项目基准。

### P2：上下文与验收

1. 为内置 Bash 大输出设计 deterministic reducer + recoverable artifact，不引入第二套 trust DB。
2. 只有真实 Workflow 需要时，增加显式 host verification；继续禁止隐藏 reviewer/model call。

## 不变约束

任何后续引入都必须继续满足：

- `/my-pi-setup` 是本包唯一用户配置入口；
- 第三方工具在 child 中必须显式分类，未知即拒绝；
- 无递归 fan-out、Mission/Schedule、持久 Agent Memory 或隐式模型调用；
- 不因限流自动切换模型；
- Replay、Worktree、Trust、Shutdown 继续 fail closed；
- 新包安装前固定版本、审查源码、记录许可证和 install scripts。
