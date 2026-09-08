# Pi 社区能力研究：值得学习的机制与验证入口

- 状态：`validated`，仅指下列来源、源码路径和隔离 Git 探针经过核对；采用建议仍是提案，不是已采纳的 Decision。
- 创建日期 / 最后核实：2026-09-08。
- OpenPI 对照：`ed9dbc1018f890fd54375f5371990ddfee8af5df`；开发 Pi 基线 `0.85.1`。
- 范围：Web/IDE、外部工具与 MCP、Context/Memory、执行与 Worktree、安全与长任务体验。
- 版本与证据清单：[候选清单](PI_COMMUNITY_ECOSYSTEM_2026-09-08.candidates.json)。GitHub 源码 SHA、源码 manifest 和 npm 发布版本分开记录。
- 历史关系：补充 [2026-08-09 社区包审计](../design/PI_COMMUNITY_PACKAGE_AUDIT_2026-08-09.md)，不覆盖其历史结论；Supersedes: none。
- 相关 Issue/Discussion：见发布回执；文档 [Draft PR #479](https://github.com/openpi-dev/openpi/pull/479)。所有公共跟踪项链接回本记录。

## 结论

优先学习能够补齐 OpenPI 真实任务路径的小机制：原生交互请求能够在 Web 回答、生成的产物能够领取并检查版本、选中的原文能够成为可审阅的反馈草稿、历史结果能够定位到源消息、后台完成能够留下投递收据。

本轮还从社区 Worktree 实现中发现了 OpenPI 的具体数据保全缺口：`assume-unchanged` / `skip-worktree` 可以让修改从 status 中消失，当前 `reclaimWorktree` 会成功删除合成修改内容。这个问题具有直接生产函数证据，应独立修复。

社区包的数量、下载量、README 功能或 peer 通配范围不证明质量及当前兼容性。没有推荐批量安装，没有修改用户包配置，没有运行第三方插件或付费模型。学习一个机制不要求采用它的所有工具、存储、后台进程和默认策略。

## 方法与证据等级

本轮共 74 条方向研究记录，合并同名包/集合后为 **70 个包或扩展候选**；其中 **49 个候选阅读了具体实现源码**，其余核对文档与发布元数据。源码阅读包含针对性检查，不能理解为 49 个整包完成深度审计或运行验收。

发现入口包括 [Pi Package Catalog](https://pi.dev/packages) 和 [BubblePtr/awesome-pi 固定目录](https://github.com/BubblePtr/awesome-pi/blob/bed430639d03e3cbf8588e6ff5ef5104574c1401/README.md)。后者提取出 146 条目录线索，仅用于发现，不把它们全部算作已审查插件。目录当前展示约 5.4k 包，这不是本轮完整覆盖范围。

[qualisero 的当前 README](https://github.com/qualisero/awesome-pi-agent/blob/d2ffdd4433fc4f64a59c8ffbb9a344a32ee669a7/README.md) 已声明过时并退休，不能使用旧搜索快照当现状。每个入选候选继续核对维护者仓库、发布 manifest 或公开发布源码。包目录、npm repository 字段、GitHub HEAD 和 npm tarball 可能不一致。

- `metadata`：维护者 README、manifest、版本及许可声明核对，不证明实现或运行结果。
- `source`：阅读固定源码中的具体控制、存储或交互路径，不证明整包兼容、无缺陷或用户收益。
- `fixture`：仅 Worktree 项执行隔离合成 Git 仓库及 OpenPI 生产函数，分别检查回执、磁盘文件和分支。
- `runtime acceptance / benchmark`：本轮没有第三方插件运行验收、跨平台认证、模型效果或成本 Benchmark。声明支持的版本范围与实际通过测试的版本不同。

独立复核检查了关键提案、已有 Issue/Discussion 和探针记录，纠正了“已有 TUI /btw 被描述成新能力”、Memory 研究建议被当作已采纳约束、以及 registry/latest 引用漂移等问题。独立复核没有重跑删除探针，也不构成第二次运行认证。

## 确定有价值的工作

### 1. Worktree 自动回收必须识别被 index 隐藏的修改

OpenPI [status/ignored 检查与回收](https://github.com/openpi-dev/openpi/blob/ed9dbc1018f890fd54375f5371990ddfee8af5df/extensions/shared/worktree.ts#L383-L487) 没有检查 index flags。[`@narumitw/pi-worktree`](https://github.com/narumiruna/pi-extensions/blob/09d0f4d4d8d31f506e6f2478a0060be5f5c31c09/packages/pi-worktree/src/git.ts#L658-L695) 将隐藏 tracked 内容视为需要保留的数据，提供了可借鉴的检查机制。

Node 26.3.0 / Git 2.50.1 的两种合成 fixture 中，直接调用生产 `reclaimWorktree` 均返回 `removed:true, branchDeleted:true, dirty:false, ignored:false, commits:0`；独立检查确认修改文件、worktree 目录和分支消失。这不是声称标记会自动从父 checkout 继承，也不是 ignored 文件问题。没有运行完整 Child/Workflow 生命周期。

应先保证 unknown/index inventory 失败时保留数据，不为检查清除用户标记，不自动 reset/clean。普通 sparse checkout 的安全回收是另一项需要证明的边界。[规范化探针回执](PI_COMMUNITY_WORKTREE_INDEX_FLAGS_2026-09-08.json)保留固定源码与两组执行结果。

### 2. Web 需要能回应 Pi 原生交互的适配层

[`@jmfederico/pi-web`](https://github.com/jmfederico/pi-web/blob/182c5ade390fc4c31189f44f0daf518817c74e71/src/server/sessions/piSessionService.ts#L1824-L1904) 将 confirm/select/input 转成有 Session 身份的 pending request、浏览器事件与等待中的 Promise。超时、abort、Session teardown 关闭准确请求；[等待器](https://github.com/jmfederico/pi-web/blob/182c5ade390fc4c31189f44f0daf518817c74e71/src/server/sessions/extensionDialogWaiters.ts#L28-L101)与可观察状态分离。

这给 [#343](https://github.com/openpi-dev/openpi/issues/343) 提供具体实现样本。回复需绑定 Session/runtime epoch/request id，刷新只恢复投影，过期/重复答复不得授权。原生三种简单请求不等于任意 `ui.custom` 界面都可用，OpenPI ask_user 等自定义 UI 需要独立适配或明确不支持。Pi 和原扩展继续拥有权限规则，不引入社区项目的独立 daemon 或多机器控制面。

### 3. 产物访问、版本与反馈应形成完整路径

[`pi-studio` 的资源 grant](https://github.com/omaclaren/pi-studio/blob/e04fc7aa3275b0f3f69cbbc0cbc7393a58b9f4bd/shared/studio-resource-grants.js#L5-L164)区分精确文件和目录；[watcher](https://github.com/omaclaren/pi-studio/blob/e04fc7aa3275b0f3f69cbbc0cbc7393a58b9f4bd/shared/studio-file-watcher.js#L25-L95)用内容 revision 判断更新。[pi-markdown-preview](https://github.com/omaclaren/pi-markdown-preview/blob/273bc5af58095a76c9a02f42ab642aa2e5d5f9f9/index.ts#L4872-L4892)明确展示上次可用预览与清理失败。

已有 [#345](https://github.com/openpi-dev/openpi/issues/345) 应先完成 Session/workspace 归属的只读产物入口：生成 → 预览/下载 → 修改 → 看见新版本。relative link 按产物目录解析，认证由宿主处理；不能开放任意本地路径。可编辑文件浏览器后置，内容版本检查不应被表述为解决了全部文件系统竞态。

新建的窄功能提案是：已完成回答中的选区 → 带原文、message/Session 身份和内容版本的反馈草稿 → 用户显式发送。[Plannotator 的选区数据](https://github.com/backnotprop/plannotator/blob/9c85310151feb335cb8a8e74beae79349873382d/packages/ui/types.ts#L61-L85)与[反馈导出](https://github.com/backnotprop/plannotator/blob/9c85310151feb335cb8a8e74beae79349873382d/packages/ui/utils/parser.ts#L1442-L1462)是参考；其[锚点漂移限制](https://github.com/backnotprop/plannotator/blob/9c85310151feb335cb8a8e74beae79349873382d/packages/ui/HANDOFF.md#L258-L285)也应进入验收。先解决引用与草稿归属，不自动发消息、批准 Plan 或创建审阅 Agent。

### 4. 现有研究 Issue 可以落到具体对照对象

| 跟踪 | 本轮新增对照 | 应验证的机制与反例 |
| --- | --- | --- |
| [#169 外部能力](https://github.com/openpi-dev/openpi/issues/169) | [pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter/blob/8243eba3421e301c88c047444f34ab7d5d57163e/tool-approval.ts#L91-L182) | 独立配置、逐内部调用 broker、owner 取消；顶层 `mcp` 同名不能证明读写权限相同 |
| [#163 LSP](https://github.com/openpi-dev/openpi/issues/163) | [pi-lsp 单请求 scope](https://github.com/narumiruna/pi-extensions/blob/09d0f4d4d8d31f506e6f2478a0060be5f5c31c09/packages/pi-lsp/src/session-lifecycle.ts#L24-L57)、[pi-lsp-client 共享池](https://github.com/code-yeongyu/pi-lsp-client/blob/1c981dfcacc456fe4ce9f4120a2f0250b54d6844/src/lsp/manager.ts) | 比较冷/热开销、诊断新鲜度、取消与清理；不直接复制六个常驻工具/自动安装 |
| [#168 DAP](https://github.com/openpi-dev/openpi/issues/168) | [lsp-pi 的原生 Pi DAP 入口](https://github.com/trotsky1997/pi-lsp-extension/blob/39d56f0cdaf4b5e77ee038f0670de14cd19e228d/debug.ts#L1-L16) | 可以降低实验成本；旧依赖、全局 manager、attach/evaluate/写内存仍需收窄和适配 |
| [#349 历史搜索](https://github.com/openpi-dev/openpi/issues/349) | [pi-session-search 增量 FTS](https://github.com/samfoy/pi-session-search/blob/30acb79abc225ac1907d67eeed1eeb1079890431/src/fts-index.ts#L89-L165)、[hermes 源锚点](https://github.com/chandra447/pi-hermes-memory/blob/34c6fe49f832e6a0957ce517586158a8bdde71a4/src/store/session-anchor-search.ts#L1-L120) | 索引可重建、结果能回原消息；同 size 修改、CJK、超长单行、总扫描预算必须验收 |
| [#156 Cache 诊断](https://github.com/openpi-dev/openpi/issues/156) | [pi-cache-graph](https://github.com/championswimmer/pi-cache-graph/blob/40c5ae469c3956f7aba7fadc40f64391c1c74706/src/session-data.ts) | 借鉴 active branch / whole tree 的口径展示；OpenPI 已有逐 turn tracker，且已统计更多 usage-bearing entry，不能照搬而回退 |
| [#167 Durable Learning](https://github.com/openpi-dev/openpi/issues/167) | [pi-memory forget/restore](https://github.com/jayzeng/pi-memory/blob/39e6b998a2279c8fad4a2c6c64e26828c1d6023e/index.ts#L2113-L2195) | 未来若证明值得采用，应可恢复删除、立即失效旧注入快照；本轮不决定建立 Memory 系统 |
| [#160 后台投递](https://github.com/openpi-dev/openpi/issues/160) | Pi 社区后台任务与 Subagent 的 owner / delivery 实现，见候选清单 | producer 终态、transport 接收、消费收据分别记录；借鉴持久回执，不统一执行状态机 |
| [Discussion #381 互操作](https://github.com/openpi-dev/openpi/discussions/381) | [pi-acp](https://github.com/svkozak/pi-acp/blob/d1cffc047ab37a096ee70ca39cfc1de463db8d12/src/acp/session.ts#L871-L965)、[pi-nvim-context prefill](https://github.com/omaclaren/pi-nvim-context/blob/b3d5bc991dbe125a1173850a6a5927eb632e3e73/index.ts#L345-L368) | 区分协议映射、Agent-as-provider、仅追加草稿；工具已执行的投影不能触发二次执行 |

## 先讨论、再用实验决定的方向

1. **可恢复的工具结果折叠。** [pi-fold 的 bounded peek](https://github.com/shaneconner/fold/blob/7eb2ab47e291f4616ba4850e3648724fa5600a16/extensions/lib/folding.ts#L1414-L1478)与 [pi-context-prune](https://github.com/championswimmer/pi-context-prune/blob/92c80e6e26e3dbfcecbe16675c9e192d4dcd85af/src/pruner.ts)可比较 pending/commit、摘要及按需回读。基线是现有 Pi compaction/pivot；必须计入 summarizer、缓存改写、回读和 child 成本，并验证 tool call/result 配对与源引用权限。上下文变短不是收益结论。
2. **包产物风险收据。** [pi-vetter](https://github.com/jesset/pi-vetter/blob/7e620ca5c6a3d09dba3badaab5664d0bc5ba9568/src/install/gated-installer.ts)绑定版本、integrity、基线与文件摘要。应先比较独立包、Skill/维护者流程、只读诊断的价值；Pi 继续拥有安装更新。扫描 incomplete、来源不匹配、签名无法验证必须分别呈现，不能把 ALLOW 当安全担保，安装后对比也不能阻止已执行的脚本。
3. **长任务通知与保持唤醒。** [notify](https://github.com/mitsuhiko/agent-stuff/blob/122e2994adddb113c04764c5697217dae120fcc6/extensions/notify.ts)和 [pi-caffeinate](https://github.com/narumiruna/pi-extensions/blob/09d0f4d4d8d31f506e6f2478a0060be5f5c31c09/packages/pi-caffeinate/src/caffeinate.ts)提供小机制。需证明父 idle/child active、多个 Session、迟到获取、shutdown、权限拒绝下 owner 与通知不失真。`agent_end` 不等于 Goal/Workflow 完成，通知请求不等于已送达。
4. **Web 呈现已有 /btw。** OpenPI 已有 TUI 旁问和非主模型 context 的持久记录。借 [pi-btw](https://github.com/dbachelder/pi-btw/blob/4f858102706910ee9d520a9666832f3103631b61/README.md)和 Pi Studio 比较一次侧问、多轮面板、显式 Bring to main，先证明比普通追问/fork 更有价值。社区侧 Session 的 write/bash 权限不能当只读模板。
5. **可回查原文的来源展示。** [pi-web-access 的 source/passages](https://github.com/nicobailon/pi-web-access/blob/811ef82a6dd04fe4abd73fa40b079aa39ee1870d/source-check.ts#L11-L54)保留抓取版本、hash、offset 与错误。值得验证最小来源展示能否减少用户核对步骤；其 supported/contradicted/confidence 是[英文词重叠启发式](https://github.com/nicobailon/pi-web-access/blob/811ef82a6dd04fe4abd73fa40b079aa39ee1870d/source-check.ts#L162-L214)，不能变成 OpenPI 的事实认证。

另外两个候选保留在研究清单，不为数量额外发帖：登录态浏览器与隔离 QA 浏览器的先后顺序；AST package 与 Skill 调用同一个已安装 binary 的收益对照。已有 #169/#165 可以承接它们的后续证据。

## 当前不建议整体采用的情况

- 已有 Subagent/Workflow/Tasks/Goal/Plan/Footer 的重复实现；更多 agent 数量、固定流程和独立 daemon 不是增益证明。
- Browser/PTY/Memory 包中额外的后台 worker、直接模型调用、自动下载、cloud embedding 或自动 context 注入；这些成本必须显式决定。
- Bash-only sandbox 不等于约束整个 Agent，初始化失败退回普通 Bash 不能用于强制隔离承诺。模型 authorizer 或正则 guard 也不能成为系统隔离根。
- 源码与发布产物不同：pi-mcp-adapter 源码允许 Pi AI 0.85，而本轮 [npm 2.32.1](https://registry.npmjs.org/pi-mcp-adapter/2.32.1)只声明 `^0.84.1`；实际兼容仍未验证。
- `@gotgenes/pi-subagents` 的目录 repo 与 npm 当前 monorepo 不同；`@ollama/pi-web-search` 发布源码仍有旧 Pi imports，声称的 repo 本轮 404；这些都是来源身份限制，不应推断维护者动机。
- context-mode 的 ELv2、Hypa 的 FSL-1.1-ALv2 与 MIT 不同；某些包只有 manifest 许可声明而没有找到 LICENSE。清单保留证据层级，不据此宣布代码可随意复制。

## 发布回执

已发布并逐条回读确认：**2 个新 Issue、5 篇 Ideas Discussion、9 条已有 Issue 评论、1 条已有 Discussion 评论**。已有关闭项保留关闭状态，只补充研究或回归证据。

| 类型 | 主题 / 回执 |
| --- | --- |
| 新 Issue | [#472 bug(worktree): 自动回收会删除被 index flags 隐藏的未提交修改 [P1]](https://github.com/openpi-dev/openpi/issues/472) |
| 新 Issue | [#473 feat(web): 支持从回答选区生成带来源和内容版本的反馈草稿](https://github.com/openpi-dev/openpi/issues/473) |
| 新 Discussion | [#474 可恢复的工具结果折叠：怎样验证它比原生 compaction 更有价值？](https://github.com/openpi-dev/openpi/discussions/474) |
| 新 Discussion | [#475 社区包风险收据：只读评估应由独立插件、Skill 还是 OpenPI 承担？](https://github.com/openpi-dev/openpi/discussions/475) |
| 新 Discussion | [#476 长任务离开屏幕后：通知与保持唤醒应绑定哪个执行事实？](https://github.com/openpi-dev/openpi/discussions/476) |
| 新 Discussion | [#477 Web 侧问：怎样呈现已有 Pi-native /btw 而不污染主上下文？](https://github.com/openpi-dev/openpi/discussions/477) |
| 新 Discussion | [#478 外部检索的来源展示：何时值得增加可回查原文的证据入口？](https://github.com/openpi-dev/openpi/discussions/478) |
| Issue 补充 | [#343 原生 Web 交互适配](https://github.com/openpi-dev/openpi/issues/343#issuecomment-5577485330) |
| Issue 补充 | [#345 产物授权与版本预览](https://github.com/openpi-dev/openpi/issues/345#issuecomment-5577485973) |
| Issue 补充 | [#169 MCP 逐调用权限与兼容试点](https://github.com/openpi-dev/openpi/issues/169#issuecomment-5577486546) |
| Issue 补充 | [#163 LSP 单请求与共享池](https://github.com/openpi-dev/openpi/issues/163#issuecomment-5577486898) |
| Issue 补充 | [#168 Pi 原生 DAP 候选](https://github.com/openpi-dev/openpi/issues/168#issuecomment-5577487575) |
| Issue 补充 | [#349 会话检索源锚点与增量失效](https://github.com/openpi-dev/openpi/issues/349#issuecomment-5577488155) |
| Issue 补充 | [#156 Cache / usage 统计口径](https://github.com/openpi-dev/openpi/issues/156#issuecomment-5577488531) |
| Issue 补充 | [#167 可恢复删除与快照失效](https://github.com/openpi-dev/openpi/issues/167#issuecomment-5577488981) |
| Issue 补充 | [#160 后台终态、投递与消费收据](https://github.com/openpi-dev/openpi/issues/160#issuecomment-5577489557) |
| Discussion 补充 | [#381 ACP / Agent provider / 草稿 prefill](https://github.com/openpi-dev/openpi/discussions/381#discussioncomment-18339579) |

文档变更：[Draft PR #479](https://github.com/openpi-dev/openpi/pull/479)。仓库验证：`bun run check` 通过；`bun run test` 通过（Node 1461 passed / 1 skipped / 0 failed，Web Vitest 113 passed）；JSON 可解析、相对链接和 diff whitespace 检查通过。以上检查只验证仓库文档变更的交付，不证明社区方案运行兼容或采用收益。

<!-- publication-receipts -->

<!-- candidate-index -->

## 候选索引

字段、版本、许可证据、兼容限制和取舍详情见 JSON 清单；本表只提供可浏览入口。

| 候选 | 方向 | 已读证据 |
| --- | --- | --- |
| [@aliou/pi-guardrails](https://github.com/aliou/pi-guardrails/blob/e27e4bf96e18497436c2580fd9d0548bc7e2608d/package.json) | 安全/体验 | 实现源码（未运行） |
| [@aliou/pi-processes](https://github.com/aliou/pi-processes/blob/f155117d6a0cb644b316dbf99676956400527754/extensions/processes/notifications/service.ts) | 执行 | 实现源码（未运行） |
| [@code-yeongyu/pi-ast-grep](https://github.com/code-yeongyu/pi-ast-grep/blob/4a7d1beee684d96a6890e5fc55710bb63fecca85/src/ast-grep/tools.ts) | 外部工具 | 实现源码（未运行） |
| [@code-yeongyu/pi-webfetch](https://github.com/code-yeongyu/pi-webfetch/blob/ee045140cbaa784eec420bc0a7bc7d7eec0b7043/README.md) | 外部工具 | README/manifest |
| [@code-yeongyu/pi-websearch](https://github.com/code-yeongyu/pi-websearch/blob/ddf5f5d21de57ee3e80f1a6f96aff21a9dd34662/README.md) | 外部工具 | README/manifest |
| [@czottmann/pi-automode](https://github.com/czottmann/pi-automode/blob/d556f006bd705d4eddc5c49ce4fcc8d9b82c1657/package.json) | 安全/体验 | README/manifest |
| [@gintasz/pi-neuralyzer](https://github.com/gintasz/neuralyzer/blob/5d5cf3ea206307f31c8592d1e79f4037c00a94d0/README.md) | 上下文、执行 | 实现源码（未运行） |
| [@gotgenes/pi-permission-model-judge](https://github.com/gotgenes/pi-packages/blob/6ee70e9f4571c2ae96b50e6105ad887c20d8d0a2/packages/pi-permission-model-judge/package.json) | 安全/体验 | README/manifest |
| [@gotgenes/pi-permission-system](https://github.com/gotgenes/pi-packages/blob/6ee70e9f4571c2ae96b50e6105ad887c20d8d0a2/packages/pi-permission-system/package.json) | 安全/体验 | 实现源码（未运行） |
| [@gotgenes/pi-subagents](https://github.com/gotgenes/pi-packages/blob/6ee70e9f4571c2ae96b50e6105ad887c20d8d0a2/packages/pi-subagents/README.md) | 执行 | README/manifest |
| [@hypabolic/pi-hypa](https://github.com/Hypabolic/Hypa/blob/2678616e62f1f2a8d2ae0904f88859c3f19df860/packages/pi-hypa/README.md) | 上下文 | README/manifest |
| [@jmfederico/pi-web](https://github.com/jmfederico/pi-web/tree/182c5ade390fc4c31189f44f0daf518817c74e71) | Web/IDE | 实现源码（未运行） |
| [@juicesharp/rpiv-web-tools](https://github.com/juicesharp/rpiv-mono/blob/338b264c1ca4fd8828cc849b632f4f7ad88d2e78/packages/rpiv-web-tools/README.md) | 外部工具 | README/manifest |
| [@juvio15/pi-ast-grep](https://registry.npmjs.org/@juvio15/pi-ast-grep/-/pi-ast-grep-0.4.2.tgz) | 外部工具 | 实现源码（未运行） |
| [@narumitw/pi-caffeinate](https://github.com/narumiruna/pi-extensions/blob/09d0f4d4d8d31f506e6f2478a0060be5f5c31c09/packages/pi-caffeinate/package.json) | 安全/体验 | 实现源码（未运行） |
| [@narumitw/pi-chrome-devtools](https://github.com/narumiruna/pi-extensions/blob/09d0f4d4d8d31f506e6f2478a0060be5f5c31c09/packages/pi-chrome-devtools/README.md) | 外部工具 | README/manifest |
| [@narumitw/pi-firecrawl](https://github.com/narumiruna/pi-extensions/blob/09d0f4d4d8d31f506e6f2478a0060be5f5c31c09/packages/pi-firecrawl/README.md) | 外部工具 | README/manifest |
| [@narumitw/pi-lsp](https://github.com/narumiruna/pi-extensions/blob/09d0f4d4d8d31f506e6f2478a0060be5f5c31c09/packages/pi-lsp/src/pi-lsp.ts) | 外部工具 | 实现源码（未运行） |
| [@narumitw/pi-retry](https://github.com/narumiruna/pi-extensions/blob/09d0f4d4d8d31f506e6f2478a0060be5f5c31c09/deprecated/pi-retry/README.md) | 安全/体验 | README/manifest |
| [@narumitw/pi-worktree](https://github.com/narumiruna/pi-extensions/blob/09d0f4d4d8d31f506e6f2478a0060be5f5c31c09/packages/pi-worktree/src/git.ts) | 执行 | 实现源码（未运行） |
| [@ollama/pi-web-search](https://pi.dev/packages/@ollama/pi-web-search) | 外部工具 | 实现源码（未运行） |
| [@plannotator/pi-extension](https://github.com/backnotprop/plannotator/tree/9c85310151feb335cb8a8e74beae79349873382d) | Web/IDE | 实现源码（未运行） |
| [@quintinshaw/pi-dynamic-workflows](https://github.com/QuintinShaw/pi-dynamic-workflows/blob/1c0f7462aa8a007afb8112f073887590a57ea82d/src/worktree.ts) | 执行 | 实现源码（未运行） |
| [@samfp/pi-memory](https://github.com/samfoy/pi-memory/blob/da1f96d55706db07f39c3767b84890e89298d5f2/README.md) | 上下文 | README/manifest |
| [@tintinweb/pi-subagents](https://github.com/tintinweb/pi-subagents/blob/e955e29c51b7a6cce37e1108cd2d6c57a77e151c/src/agent-manager.ts) | 执行 | 实现源码（未运行） |
| [@tintinweb/vscode-pi-model-chat-provider](https://github.com/tintinweb/vscode-pi-model-chat-provider/tree/95d8de3f272a1a491e36a76bba04095d0e927563) | Web/IDE | 实现源码（未运行） |
| [@trim21/personal-pi-extensions](https://github.com/trim21/pi-extensions/blob/79d7f01c4b4c42a6125e368eefcee66c21992058/package.json) | 安全/体验 | README/manifest |
| [betterwright](https://github.com/BetterWright/betterwright/blob/b9f73fc8672750b7e2d67c6dc1c988a5ab2213ba/README.md) | 外部工具 | 实现源码（未运行） |
| [cc-safety-net](https://github.com/kenryu42/cc-safety-net/blob/10326fac666de7ca515e3492820242eadc316916/package.json) | 安全/体验 | README/manifest |
| [context-mode](https://github.com/mksglu/context-mode/blob/33f7eb90f17bbe1b7c39aa126b989b6fa73850c8/README.md) | 上下文 | README/manifest |
| [filter-output](https://github.com/michalvavra/agents/blob/c355e3c358fbef4122141ee51d8887fe273ff8b6/agents/pi/extensions/filter-output.ts) | 安全/体验 | 实现源码（未运行） |
| [gentle-engram](https://github.com/Gentleman-Programming/engram/blob/869a3fb3aecc8353d95d2a47b108075e9398ecc1/plugin/pi/README.md) | 上下文 | README/manifest |
| [lsp-pi](https://github.com/trotsky1997/pi-lsp-extension/blob/39d56f0cdaf4b5e77ee038f0670de14cd19e228d/debug.ts) | 外部工具 | 实现源码（未运行） |
| [mitsupi](https://github.com/mitsuhiko/agent-stuff/tree/122e2994adddb113c04764c5697217dae120fcc6) | Web/IDE、安全/体验、执行 | 实现源码（未运行） |
| [permission-pi / pi-hooks permission](https://github.com/prateekmedia/pi-hooks/blob/5590a3bacbbdd055fb49d2ca031abe2c9f3e6c25/permission/README.md) | 安全/体验 | 实现源码（未运行） |
| [pi-acp](https://github.com/svkozak/pi-acp/tree/d1cffc047ab37a096ee70ca39cfc1de463db8d12) | Web/IDE | 实现源码（未运行） |
| [pi-agent](https://github.com/Zetaphor/pi-vscode-extension/tree/526df5ead8e0104ea5d176bb5e6fa25e6d75844a) | Web/IDE | 实现源码（未运行） |
| [pi-agent-browser-native](https://github.com/fitchmultz/pi-agent-browser-native/blob/3d4f36904ff0bc6baa24cb1116b3fe42bbc2f443/README.md) | 外部工具 | 实现源码（未运行） |
| [pi-agent-bus](https://github.com/kylebrodeur/pi-agent-bus/blob/135706d797247efeca377c4637d8f94f8857d80b/packages/pi-agent-bus-node/src/LLMProvider.ts) | 执行 | 实现源码（未运行） |
| [pi-background-tasks](https://github.com/ismailsaleekh/pi-background-tasks/blob/14aa4ef382952f073bd4d540f57d6e8e3c2789a2/src/core/delegate/result-package.ts) | 执行 | 实现源码（未运行） |
| [pi-btw](https://github.com/dbachelder/pi-btw/tree/4f858102706910ee9d520a9666832f3103631b61) | Web/IDE | 实现源码（未运行） |
| [pi-cache-graph](https://github.com/championswimmer/pi-cache-graph/blob/40c5ae469c3956f7aba7fadc40f64391c1c74706/src/session-data.ts) | 上下文 | 实现源码（未运行） |
| [pi-chrome](https://github.com/tianrendong/pi-chrome/blob/017ff4b9a639f0b8b213e58a3f30613fc38edcc8/README.md) | 外部工具 | 实现源码（未运行） |
| [pi-context-prune](https://github.com/championswimmer/pi-context-prune/blob/92c80e6e26e3dbfcecbe16675c9e192d4dcd85af/src/pruner.ts) | 上下文 | 实现源码（未运行） |
| [pi-crew](https://github.com/baphuongna/pi-crew/blob/627f59c9c6891eb9c78307ca17d24907bd5dae79/src/workflows/topology-analyzer.ts) | 执行 | 实现源码（未运行） |
| [pi-ext](https://github.com/tomsej/pi-ext/tree/e132c44b3b06f88f7fcfb67b80c91698d8c1814f) | Web/IDE、执行 | 实现源码（未运行） |
| [pi-fold](https://github.com/shaneconner/fold/blob/7eb2ab47e291f4616ba4850e3648724fa5600a16/extensions/active-context.ts#L3327-L3331) | 上下文 | 实现源码（未运行） |
| [pi-hermes-memory](https://github.com/chandra447/pi-hermes-memory/blob/34c6fe49f832e6a0957ce517586158a8bdde71a4/src/prompt-context.ts) | 上下文 | 实现源码（未运行） |
| [pi-interactive-shell](https://github.com/nicobailon/pi-interactive-shell/tree/eedb89a9e4618d7416326d9387085a756a2125ee) | Web/IDE | README/manifest |
| [pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/activity.ts) | 执行 | 实现源码（未运行） |
| [pi-lean-ctx](https://github.com/yvgude/lean-ctx/blob/e710e85a2f4782f3d8732fcda38ae9ee7a772e05/packages/pi-lean-ctx/README.md) | 上下文 | README/manifest |
| [pi-lens](https://github.com/apmantza/pi-lens/blob/d0d853218f01be917c4f2608820584a8c167253b/docs/settings.md) | 外部工具 | 实现源码（未运行） |
| [pi-lsp-client](https://github.com/code-yeongyu/pi-lsp-client/blob/1c981dfcacc456fe4ce9f4120a2f0250b54d6844/src/lsp/manager.ts) | 外部工具 | 实现源码（未运行） |
| [pi-markdown-preview](https://github.com/omaclaren/pi-markdown-preview/tree/273bc5af58095a76c9a02f42ab642aa2e5d5f9f9) | Web/IDE | 实现源码（未运行） |
| [pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter/blob/8243eba3421e301c88c047444f34ab7d5d57163e/README.md) | 外部工具 | 实现源码（未运行） |
| [pi-memory](https://github.com/jayzeng/pi-memory/blob/39e6b998a2279c8fad4a2c6c64e26828c1d6023e/index.ts#L1385-L1419) | 上下文 | 实现源码（未运行） |
| [pi-memory-honcho](https://github.com/acsezen/pi-memory-honcho/blob/9439404513e7650fc215bfeb30bd03bad72bd33a/README.md) | 上下文 | README/manifest |
| [pi-nvim-context](https://github.com/omaclaren/pi-nvim-context/tree/b3d5bc991dbe125a1173850a6a5927eb632e3e73) | Web/IDE | 实现源码（未运行） |
| [pi-sandbox](https://github.com/carderne/pi-sandbox/blob/079be62e8de18665cdd9b810a879d419a00a8565/package.json) | 安全/体验 | 实现源码（未运行） |
| [pi-session-search](https://github.com/samfoy/pi-session-search/blob/30acb79abc225ac1907d67eeed1eeb1079890431/src/fts-index.ts#L89-L165) | 上下文 | 实现源码（未运行） |
| [pi-sessions](https://github.com/thurstonsand/pi-sessions/blob/7197e8a609a2f33dc8a3610a6cf3a4ba3823592d/README.md) | 上下文 | README/manifest |
| [pi-smart-fetch](https://github.com/Thinkscape/agent-smart-fetch/blob/b01116124971de44f16a4477e34c06ba2ab1d0bf/packages/pi-smart-fetch/README.md) | 外部工具 | README/manifest |
| [pi-studio](https://github.com/omaclaren/pi-studio/tree/e04fc7aa3275b0f3f69cbbc0cbc7393a58b9f4bd) | Web/IDE | 实现源码（未运行） |
| [pi-subagents](https://github.com/nicobailon/pi-subagents/blob/56f247ac86169cfffa1af9a4c07997c33804bf9a/src/runs/background/notify.ts) | 执行 | 实现源码（未运行） |
| [pi-usage-widget](https://github.com/cullendotdev/pi-usage-widget/blob/976d3dfc11bbb1a5a2cacd05d9a00963d5e15bc7/README.md) | 上下文 | README/manifest |
| [pi-verdict](https://github.com/jesset/pi-verdict/blob/1386a9521681b6f8e4ef1a445d6f13beb0212d57/package.json) | 安全/体验 | 实现源码（未运行） |
| [pi-vetter](https://github.com/jesset/pi-vetter/blob/7e620ca5c6a3d09dba3badaab5664d0bc5ba9568/package.json) | 安全/体验 | 实现源码（未运行） |
| [pi-web-access](https://github.com/nicobailon/pi-web-access/blob/811ef82a6dd04fe4abd73fa40b079aa39ee1870d/README.md) | 外部工具 | 实现源码（未运行） |
| [pi-worktree-extension](https://github.com/AjayPoshak/pi-worktree-extension/blob/50df0b2fb049e556758e6fb6b22d0f0016ff8b9b/src/worktrees.ts) | 执行 | 实现源码（未运行） |
| [security](https://github.com/michalvavra/agents/blob/c355e3c358fbef4122141ee51d8887fe273ff8b6/agents/pi/extensions/security.ts) | 安全/体验 | 实现源码（未运行） |
