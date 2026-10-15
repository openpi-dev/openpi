# 选择 OpenPI 扩展：能力、前提与组合

先按要做的事选扩展，再检查执行前提。Pi 仍负责包资源选择、项目 Trust、Session、模型与凭据；本指南不改变配置或执行权限。安装步骤见 [SETUP](SETUP.md)。

本指南来自 [#737](https://github.com/openpi-dev/openpi/issues/737) 中 SereinSos 的提议和认领，以及维护者对用户指南的支持。它交付可读的选择说明；讨论中的 schema、生成器和依赖闭合保证不属于已实现功能。

## 先分清三个层次

| 层次 | 说明 | 不能据此推断 |
| --- | --- | --- |
| Pi 的扩展复选项 | 当前包有 **35 个** `extensions/<name>/index.ts` 入口。Pi 选择并加载入口；`shared/` 等帮助目录不是额外复选项。修改选择后按 Pi 的要求重载或重启。 | 文件在磁盘上不代表该扩展已加载；扩展已加载也不代表每个可选功能已开启。 |
| OpenPI 的运行时发现组 | `capabilities` 按请求加载 **6 个**组，将已注册且符合状态的工具投影给模型。默认 `explicit`；`adaptive` 需要主动配置。 | 组不是安装包、权限授权或依赖解析器。加载组不会补装未选择的扩展、下载其任意依赖或开始执行。 |
| 真正执行前提 | 相关二进制、Pi 模型与凭据、项目 Trust、父/子工具权限、当前模式、用户授权以及实时资源。 | 工具可见、命令注册成功或模型声称完成，都不能证明操作执行或配置保存成功。 |

普通文件和 Shell 工作使用 Pi 的原生工具即可。若要使用下面的发现流程，选择 `capabilities`；保留 `setup` 便于通过唯一入口 `/openpi-setup [自然语言请求]` 配置和读取状态，但它不是每个工具执行的硬依赖。`/my-pi-setup` 只是兼容别名。扩展选择本身属于 Pi，不由 `/openpi-setup` 代替。

## 按任务选择的起点

以下是源码与隔离 SDK 加载检查支持的起点，**不是所有平台、Provider 或任意扩展子集的端到端可用性保证**。普通请求仍需当前 Pi Session 的可用模型；下面的模型前提指额外执行限制，不表示可以无模型进行对话。

| 想做的事 | 为这条发现路径选择的扩展 | 仍需确认 | 如何看待缺件 |
| --- | --- | --- | --- |
| 结构化文件搜索与只读 Git 调查 | `capabilities` + `file-search` + `git-read` | 文件搜索使用 `fd`/`rg`；Git 使用系统 `git` 和有效仓库。 | 可以只选择一个 owner；`search` 组只提供实际注册的部分，不会补齐另一半。缺二进制、非 Git 仓库与组未加载是不同情况。 |
| 把独立任务交给子代理 | `capabilities` + `subagents` | Pi 当前模型或已明确配置的角色模型及其凭据；子工具受父级与角色权限交集约束；隔离 worktree 另需 Git 条件。 | 工具注册不证明模型可调用。模型不可用、无权限或取消应按实际终态判断，不能把任务名当作完成。 |
| 多阶段 Workflow | `capabilities` + `workflows` | 可用的 Pi 子会话模型、角色权限与 Workflow 配额；脚本按现有 sandbox 边界执行。 | **无需为此额外勾选 `subagents` 或加载 `delegate`**：Workflow 直接复用包内帮助模块，拥有自己的工具和子会话生命周期。勾选 `subagents` 只在同时需要直接委派时有价值。 |
| 启动并管理后台命令 | `capabilities` + `background-terminals` | 可用 Shell、命令与工作目录、执行授权及空闲配额。 | `background` 只暴露已注册工具；`bg_status` 等管理工具还依赖真实任务状态。启动成功不等于后台工作已完成；后台 Terminal 不提供 stdin。 |
| 记录 Session 任务与显式长期目标 | `capabilities` + `tasks` 和/或 `goal` | 原生 Session 与对应任务/目标状态。 | `session` 组内两个 owner 可分开选择。任务和目标记录不是执行或验收证据；UI 数据源可另选。 |
| 终端信息工作台 | `ui-customization`，按需加 `model-info`、`git-info`、`turn-time` | 交互式 TUI；Git/PR 信息还有下表的外部前提。 | 缺信息发布者会少相应指标，不会因此获得委派、Workflow 或后台工具。它们也不是运行这些工具的前置。 |

例：同时需要结构化搜索、直接委派和后台服务器，可以合并前三类所需的 owner，保留一个 `capabilities`。只需要 Workflow 时，不必再选直接委派或终端装饰项。组合不会扩大 Pi Trust、子工具权限或已有安全门禁。

向模型明确提出“用 fd/rg 搜索”“用子代理调查”或“启动后台命令”等实际任务，`explicit` 发现会按既有规则加载相应组；如果网关已可用，模型也可调用 `openpi_load_tools`。只列出可用组不会执行任务。主动选用 `adaptive` 只是让小型网关可常驻，由模型判断是否加载；不是默认安装策略。

## 六个发现组，对应哪些 owner

名称以 [`OPENPI_CAPABILITY_GROUPS`](extensions/shared/tool-surface.ts) 为准；同组不构成依赖闭包。

| 组 | 选择的 owner 入口 | 发现后的主要工具 |
| --- | --- | --- |
| `search` | `file-search`、`git-read`，可各自选择 | `fd`、`rg`；`git_show`、`git_diff`、`git_log` |
| `delegate` | `subagents` | `subagent_spawn`、`subagent_wait`、`subagent_cancel`、`subagent_send`、`subagent_check`、`subagent_list` |
| `workflow` | `workflows` | `workflow`、`workflow_stop`、`workflow_status` |
| `background` | `background-terminals` | `bg_start`；其余管理面受资源状态约束 |
| `session` | `tasks`、`goal`，可各自选择 | `tasks_add`、`create_goal`；后续管理面受状态约束 |
| `runtime` | `runtime-snapshot` | `runtime_snapshot`，有界、脱敏、只读检查 |

没有列入这六组的扩展仍可能提供命令、受模式约束的工具或纯显示功能。尤其 `web-search` 是当前模型请求内的 Provider 托管能力，`code-mode` 使用 Pi 原生 `codemode`；两者都不是新增的 OpenPI 发现组。

## 全部 35 个复选项速查

表中名称对应 `extensions/<name>/index.ts`，链接指向实现入口。前提缺失时先检查这一行，不能靠多加载一个组修复。所有模型执行仍沿用 Pi 的实际连接和权限。

| 入口 | 用途 / 发现组 | 执行或显示前提；缺件时的边界 |
| --- | --- | --- |
| [`ai-providers`](extensions/ai-providers/index.ts) | 可选 Google Antigravity / 实验性 Cursor Provider | 用户原生登录并选择支持模型才会使用；未登录不自动发起模型请求，不提供 Cursor 原生编码工具。 |
| [`ask-user`](extensions/ask-user/index.ts) | `ask_user` / `human_handoff`，不属于发现组 | 仅在 Plan 或 setup episode 中投影到父会话；单独勾选不会让普通回合常驻这些工具。TUI、RPC/Web 的交互路径不同，无可用人工交互不能伪造回答。 |
| [`background-terminals`](extensions/background-terminals/index.ts) | `background`；`/ps` | Shell、cwd、命令、授权与限额；管理面跟随实际后台资源，没有 stdin。 |
| [`browser`](extensions/browser/index.ts) | `openpi_browser`，配置门控 | 默认关闭；需 setup 总开关、目标浏览器授权、Web bridge/对应连接和实时观察。浏览器未连接或未授权会拒绝，不切换目标来绕过。 |
| [`capabilities`](extensions/capabilities/index.ts) | 六组发现与 `openpi_load_tools` | 只管理已注册且允许的工具；无对应 owner 时不能创造工具。`explicit` 默认，`adaptive` 需 opt-in。 |
| [`clear-context`](extensions/clear-context/index.ts) | TUI 空编辑器、空闲时 Ctrl+C 发起原生 `/new` | 需要交互式 TUI；不是第二套 Session 存储或通用取消替代。 |
| [`code-mode`](extensions/code-mode/index.ts) | 启用 Pi 原生 `codemode` 的包偏好 | 需宿主真正提供 builtin `codemode`；保留 Pi 显式 defaultTools/CLI/SDK allowlist，没有该原语时不安装替代执行器。 |
| [`codemode-display`](extensions/codemode-display/index.ts) | Code Mode 的 TUI 呈现 | 宿主需 `registerToolRenderer`；旧宿主保留原生显示。单选此项不会启用 Code Mode 执行。 |
| [`context-pivot`](extensions/context-pivot/index.ts) | `/context-pivot` 与状态门控工具 | 当前 Session 可估算上下文达到 30,000 tokens 才显示工具；未知或低于阈值时隐藏，命令也会拒绝。不是发现组，不能代替模型选择或自动执行新阶段。 |
| [`copy-all`](extensions/copy-all/index.ts) | `/copy-all` 复制对话 | 系统剪贴板支持；复制失败与对话执行状态无关。 |
| [`cron`](extensions/cron/index.ts) | 用户 `/cron` 安排本 Session 提示 | Session 需保持运行；内存任务在 shutdown 清除，无跨重启调度保证，也无模型自行调度工具。 |
| [`file-mutation-display`](extensions/file-mutation-display/index.ts) | Pi 文件/Shell 工具的紧凑活动呈现 | 沿用原生工具与配置；不会提供 `fd`/`rg`，也不授权被 Trust/Plan 拒绝的写操作。 |
| [`file-search`](extensions/file-search/index.ts) | `search` 的 `fd` / `rg` | 先找系统或私有缓存二进制，缺失时仅在支持平台下载官方校验版本；TUI 启动解析，headless/Web 首次调用解析。失败会报告，不等于扩展未注册。见 [SETUP](SETUP.md#fd-rg-and-read-only-git-tools)。 |
| [`git-info`](extensions/git-info/index.ts) | Git 信息、`/lg`、`/pr` | `git` 与仓库；PR 查询另需已认证可用的 `gh`，`/lg` 需 TUI。缺 PR 信息不影响 `git-read` 注册。 |
| [`git-read`](extensions/git-read/index.ts) | `search` 的三个只读 Git 工具 | 系统 `git` 与有效仓库；不依赖勾选 `file-search`，也不需要 `gh`。包内输出帮助模块不等于扩展注册依赖。 |
| [`goal`](extensions/goal/index.ts) | `session` 的目标工具；`/goal` | 用户明确请求的原生 Session 目标及其状态；与 `tasks` 独立，完成标签不能代替结果证据。 |
| [`image-paste`](extensions/image-paste/index.ts) | TUI 图片附件/占位符 | 原生粘贴、实际图片文件与支持图像的当前模型；显示占位符不证明模型支持图片，不改变 Provider 能力。 |
| [`model-info`](extensions/model-info/index.ts) | 当前模型、上下文、usage 等事件数据 | Pi 模型/运行事件；可为 `ui-customization` 提供指标，缺失值不应解释为零或成功。 |
| [`plan-mode`](extensions/plan-mode/index.ts) | `/plan`、`plan_ready` 与只读门禁 | 原生 Session Plan 状态与明确批准；进入/恢复 Plan 会加载已注册的 `search` 工具，但不能补装 owner 或放开 Trust。 |
| [`post-edit`](extensions/post-edit/index.ts) | 成功编辑后的 TUI 前台命令 | 默认命令为空；需用户明确配置可结束命令及本地工具。不是验收门禁，也不覆盖其他 Session 或子代理。 |
| [`runtime-snapshot`](extensions/runtime-snapshot/index.ts) | `runtime` 的 `runtime_snapshot` | 只读投影当前运行时事实；无法确认的组件保留 unavailable/unknown，不修复安装、权限或连接。 |
| [`sessions`](extensions/sessions/index.ts) | `/sessions` Session 浏览 | Pi 原生 Session 目录与交互 UI；不是另一个 Session 数据库，不会恢复不存在的运行资源。 |
| [`setup`](extensions/setup/index.ts) | `/openpi-setup`，兼容别名 `/my-pi-setup` | 无参数读状态；写入需当前模型的受限 setup episode、合法配置及非 Plan 状态。取消/关闭 episode 不等于已应用；以持久化回执为准。 |
| [`subagents`](extensions/subagents/index.ts) | `delegate`；`/subagents`、TUI `/btw` | 可用 Pi 模型/凭据、角色及父工具权限；不依赖 `workflows`。子代理不能因父组可见而递归编排或扩大能力。 |
| [`suggestions`](extensions/suggestions/index.ts) | TUI next-action suggestion | 默认关闭；需明确启用并选择 Registry 模型和 reasoning，会额外消耗模型调用。与普通委派/Workflow 无前置关系。 |
| [`tasks`](extensions/tasks/index.ts) | `session` 的任务工具；`/tasks` | 原生 Session 中任务状态；可独立于 `goal` 选择。工具管理记录，不证明任务内容已执行。 |
| [`turn-time`](extensions/turn-time/index.ts) | 请求结束后的 TUI 用时 | 原生请求生命周期事件；显示统计，不是后台任务存活时间或每次 HTTP 请求耗时。 |
| [`ui-customization`](extensions/ui-customization/index.ts) | TUI Footer / Header | TUI 与包展示偏好；Git、模型栏依赖相应事件发布者提供信息，缺数据只减少显示，不阻止模型工具。 |
| [`usage`](extensions/usage/index.ts) | `/usage` Provider 用量查询 | 支持的 Provider 适配器和其 Pi 凭据/查询接口；无法获取时显示不可用，不把它当成零额度。 |
| [`user-input-fold`](extensions/user-input-fold/index.ts) | TUI 长用户消息折叠 | 宿主 Markdown transformer；只改显示，模型上下文和 Session 保留完整原文。 |
| [`web`](extensions/web/index.ts) | TUI `/web` 启动独立本机 Web 工作台 | TUI 空闲、包内 Web 制品与可解析的 Pi CLI；Web 自有模型/工作区选择，不接管当前终端 Session。浏览器控制授权另算。 |
| [`web-search`](extensions/web-search/index.ts) | 当前模型的 Provider 托管 Web search | 默认关闭；需 setup opt-in、支持的确切协议/模型/端点与相应服务权限；不属于六组，无独立搜索 key 或自动降级 Provider。见 [SETUP](SETUP.md#optional-web-search)。 |
| [`windows-terminal-compat`](extensions/windows-terminal-compat/index.ts) | Windows TUI 终端兼容 | 仅对应平台/终端模式启用，保留显式 `clearOnShrink` 设置；其他平台不提供额外能力。 |
| [`workflows`](extensions/workflows/index.ts) | `workflow`；`/workflows` | 原生子会话、模型/凭据、角色权限、并发/调用限额；无需 `subagents` 入口注册。sandbox 不提供任意文件、网络或进程 API。 |
| [`workspace-cleanup-guard`](extensions/workspace-cleanup-guard/index.ts) | 工作区既存文件删除保护 | 现有 write/bash hook、路径来源与确认结果；拒绝或确认取消不会授权删除。它不是完整的任意命令安全解析器或 Pi Trust 替代。 |

## 工具不出现或执行不了时

1. 先确认 Pi 已加载所需 owner，且安装来源正确。不要同时加载 npm 和本地两份 OpenPI；源码验收按 [README 的运行时说明](README.md#开发运行时区分-npm-与当前源码)执行。
2. owner 已加载但工具未展示：检查发现组、`explicit`/`adaptive` 选择及当前模式/资源。列组、载组和实际执行是三件事。
3. 工具可见但失败：分别检查二进制、模型/凭据、Trust/角色权限、配置回执和实时连接；照实际错误处理，不能靠多勾无关扩展授权。
4. Plan 模式不允许 setup 或实施；先按既有流程退出。setup 取消、未确认或模型回合结束都不是保存成功；用无参数 `/openpi-setup` 读取状态并核对结果。
5. 子会话使用 fail-closed 的父级/角色权限交集；父 Session 加载一个组不会自动把其全部工具给 child。切勿把六组名称当作 child 权限集合。

## 本次说明的证据与限制

源代码基准为 [`f98d6a47`](https://github.com/openpi-dev/openpi/tree/f98d6a4737461ba8d8ee100f113b5a7c3a0001a0)。35 个入口及上面的 source 链接用于核对选择和注册；六组映射来自 `extensions/shared/tool-surface.ts`，自然语言发现来自 `extensions/capabilities/index.ts`。这份手工指南不是另一个运行时 registry，也不推导或承诺任意勾选组合的依赖闭合。

隔离、无模型请求的 SDK 检查覆盖 `search`、`delegate`、`workflow`、`background` owner 的加载/工具投影，以及缺 owner 不会凭空出现工具。它验证注册与发现，不验证真实模型任务、二进制下载、浏览器连接或所有平台的安装体验。其他表格项是对应入口与配置实现的源码核对，不宣称已做端到端组合实测。源码测试与 npm 用户当前加载的运行资产也必须分开判断。
