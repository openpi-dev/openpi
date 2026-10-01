# PR #598 OpenPI Web 交互问题与竞品 Web/App 对照

- Status: draft
- Created: 2026-09-30
- Verified: 2026-10-01（分批隔离 Chromium 操作及源码；不是跨产品性能 Benchmark，各批验证边界另列）
- Source boundary: OpenPI PR #598 `563d6808ebbfee27c6bb6aeb02e7b593a656ee0c`；Pi SDK 0.85.1；Node 24.19.0
- Implementation boundary: 同一隔离 worktree 的后续修改，由 [#639](https://github.com/openpi-dev/openpi/issues/639) 跟踪并整合到已合并 #598 之后的 main。下文未提交阶段的原始观测保留，发布整合与复测另记。
- Issue: [#639](https://github.com/openpi-dev/openpi/issues/639)；持续任务 [#597](https://github.com/openpi-dev/openpi/issues/597)
- PR: [#640](https://github.com/openpi-dev/openpi/pull/640)；研究基线 [#598](https://github.com/openpi-dev/openpi/pull/598)
- Supersedes: 无；补充现有交互记录，不改写已修复问题的历史结论
- Publication: 随 #639 的后续 PR 发布供审查；研究状态仍为 draft，不是已接受 Decision。Issue 保留记录与 PR 的反向链接。

## 范围与证据

优化对象是 OpenPI Web；其他产品的 Web/App 是交互参考，不构成此次新增 OpenPI 原生 App 的范围。用户要求以交互体验和使用细节为主，展示实际问题。比较对象由用户明确为 agegr/pi-web、Maka、DeepSeek 的 DSH-better-sidebar 插件、指定 Claude 源码和 Codex App/Remote。功能清单不能替代操作结果。

新 worktree 是独立的 `pr-598-web-audit/openpi` checkout（私人绝对路径不发布）。隔离 `PI_CODING_AGENT_DIR` 下的 `pi list` 只报告该 checkout；`scripts/provenance.mjs` 输出上述完整 HEAD 和 `Provenance match: yes`。原 checkout、57161 常驻服务和已有用户 Session 均未修改。审计 Host 使用 57179；模型烟测经用户提供的本地端点使用 `gpt-6-luna`，只生成合成文字，未要求模型改文件。模型窗口/输出上限为本次隔离配置值，不作为服务商能力证据。

稳定私有证据归档身份：`openpi-web-audit-598-2026-09-30`，由该次审计操作者保留；本文件不提供公开可访问的原始证据，因此外部审阅者不能仅凭归档名或 SHA 独立复核本地人工观察。入口 `report.html`；OpenPI 复现脚本 `audit-openpi.mjs`、观测 `openpi-observations.json`；各比较对象有独立报告和截图。截图、原始 Session、配置与凭据不进 Git。公开可执行的回归在 `tests/web/`。本次 OpenPI 静态截图使用独立 Chromium context；截图停止有限动画以捕获稳定状态，不用于证明切换延迟或动画手感。

| 对象 | 边界 | 可以据此判断什么 |
| --- | --- | --- |
| OpenPI #598 | 上述完整 HEAD；真实 Pi SDK、Host、Chromium、合成会话、真实本地模型 | 本次操作结果、状态和界面；不证明真实手机键盘或其他浏览器 |
| [agegr/pi-web](https://github.com/agegr/pi-web) | 源码 `4a5081a3d9a993fa77553c62196cc0a2b48ed810`；[公开 demo](https://agegr.github.io/pi-web/) 实际操作，部署未提供可核验 build SHA | demo 的导航、布局、草稿/滚动保留；不证明真实模型、终端与认证 |
| [Maka](https://github.com/apache/maka) | 用户旧组织链接现迁至 Apache；源码 `5ac266b1e67972f3781907583b0b089beedce947`；官方 2026-09-20 Electron 实机验收图 | 该次文件/浏览器 focus、composer 和布局；不是本次启动实测 |
| [DSH-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) | 实测插件 0.22.1 `9b5834f74ad197534c821c35b8357edac1ad3919` + DSH 0.1.7-rc.1；当前 0.24.1 `492661a3ea304ad151611de70e7412494be234da` 仅源码核对 | 本地旧版模式/页签/文件引用行为；不把旧版缺陷推为新版实测结果 |
| [指定 Claude 仓库](https://github.com/bug-superman/claude-code) | `0753dafcccf433abc40a3de6abaa24ddce7d86f3`；claude-code-best 2.8.1 | 第三方 CCB Remote UI 源码参考；不是 Anthropic 官方 Claude Web/App 源码 |
| [Codex](https://developers.openai.com/blog/mastering-codex-remote-for-engineering) | 当前官方文档、公开官方界面图片 | 产品公布的流程；本机 CUA 访问被工具拒绝，未实测本机或 Remote |

## 可复现问题

下面的优先级是本次建议，不是已接受 Decision。将实现缺陷、状态保存边界和布局取舍分开。

| 优先级与性质 | 操作 | 实际结果 | 用户影响与建议 | 图片 |
| --- | --- | --- | --- | --- |
| 高：状态保护不足 | A 写未发草稿，B，再回 A；随后刷新 | 会话切换保留同一文字；刷新后为空，没有离页提醒 | 网络恢复、刷新或误关页面可能丢工作。先做有界文本草稿恢复/提醒，附件与引用另定安全保存边界 | `openpi-02-draft-before.png`、`openpi-02b-draft-after-session-return.png`、`openpi-03-draft-after-refresh.png` |
| 高：实现缺陷 | 本地模型 502，Pi 自动重试后成功回答 | 同一用户轮次保留失败卡及可用“重试消息”，没有恢复成功说明 | 已完成工作看起来仍失败；按钮会重新追加请求。成功恢复后收起尝试证据、移除失败操作；自动重试耗尽才提供手动重试 | `openpi-01-answer.png`、`recovery-finding.md` |
| 高：工作位置不连续 | A 打开 Files/README，B，再回 A，等待切换完成 | Files 面板和预览不存在，需要重新打开工具与文件 | 检查多个任务反复找位置。按精确 Session 保存已开工具、活动页签、选中文件、阅读位置 | `openpi-04-file-before-switch.png`、`openpi-05-file-after-return.png` |
| 中：操作语义不清 | 第一条旧消息点击“编辑消息”，改内容，点“确定” | 原消息保留，新用户消息追加尾部；用户消息 1→2，仍为同一 Session | 用户可能以为修改该轮或分支重算。明确“编辑后重新发送”；真正分支需 Pi 原生能力和明确后果 | `openpi-14-edit-history-dialog.png`、`openpi-15-edit-appended.png` |
| 中：布局取舍 | 打开 Files，同一文件，1101px→1099px | 1101px 可见聊天与输入框；1099px 两者和侧栏全部隐藏 | 普通桌面窗口宽度下查看文件不能立即追问。文件 focus 可保留同一 composer，或持续显示明确的返回/恢复入口 | `openpi-09-file-1101.png`、`openpi-10-file-1099.png`、`openpi-11-mobile-file.png` |
| 中：检索范围不足 | 正文确有 `EVIDENCE-742`，侧栏搜索该词 | “没有匹配的会话”，匹配 0；它实际只搜标题/cwd | 找旧答案失败。明确搜索范围，接入现有有界全文搜索；命中应定位原消息，保留返回位置 | `openpi-08-search-content.png` |
| 较低：偏好恢复不一致 | 将侧栏调到 420px，再刷新 | 回到 280px | 每次重调布局；聊天宽度/字号已持久化，面板宽度规则却不同。使用现有偏好路径并限制合法范围 | `openpi-06-sidebar-resized.png`、`openpi-07-sidebar-after-refresh.png` |

草稿、切换、尺寸检查均等待真实切换/布局完成后取值；不能用过渡帧或立即读到的空值证明稳态丢失。具体观测：A→B→A 草稿与原文一致；刷新后 `""`；工作栏数量 1→0；面板宽度 420→280；正文存在而搜索匹配 0；1101px 输入可见而 1099px 不可见。

## 自动恢复为何仍呈现失败

合成 Session 原始历史是一条用户消息→三次 assistant error→成功 assistant stop，无中途新用户消息。Pi 0.85.1 保存失败尝试，并在恢复时发 `auto_retry_end`、`success=true`。这份尝试证据应保留，最终展示需要区分恢复后的结果。

`web/runtime/pi-runtime.ts:1841` 只 trace 自动重试结束，后续投影 switch 未处理恢复结果。`Transcript.tsx:1973` 为每个 error 建 failed outcome，retry 条件没有判断同轮后续成功；`:1303` 的轮次状态又将 failed 优先于 answered。`:255` 的按钮调用 `onRetry(retryPrompt)`，`App.tsx:483` 转到 `actions.sendPrompt`；它是新请求入口。本次没有点击残留按钮，不声称已经复现重复执行或文件副作用。

建议优先覆盖 error→retrying→success、retry exhausted、取消、切会话、历史重载。成功证据与尝试历史分开投影；不能用“出现过 error”推出该轮最终失败，也不能靠改文案伪造恢复结果。现有 `provider-error.spec.ts` 覆盖最终 error/partial/aborted/重发，没有该自动恢复成功路径。

## 对照方好在哪里

1. **Maka：放大阅读仍能继续对话。** 官方文件 focus 保留同一 composer、草稿、模型与运行状态；Escape 恢复视图，Stop 才停止工作。[原验收](https://github.com/apache/maka/blob/5ac266b1e67972f3781907583b0b089beedce947/docs/images/pr/desktop-focused-preview/live-review/README.md)。这比先复制其 Workbar 框架更直接地解决 OpenPI 的阅读/追问断点。
2. **Pi Web：切视图不丢当前工作。** demo 草稿及 README `scrollTop=760` 在文件全宽/恢复、开设置/切深色/退出后保持。Source/Preview/Diff 在同一文件面板，恢复路径明确。全宽时它也隐藏 composer，因此不是所有布局都应照搬。[官方 demo 边界](https://github.com/agegr/pi-web/blob/4a5081a3d9a993fa77553c62196cc0a2b48ed810/demo/README.md)。
3. **DSH：引用与模式切换的反馈清楚。** 实测 `@文件` 成为 chip；标准→PTC 保留文字、引用、三个页签和当前 diff，焦点回输入框。旧版刷新仅部分恢复：文字/模式/页签在，chip 退为文本、diff 选中项丢失。因此验收不能只检查“页签仍在”。
4. **Codex：审阅直接变成准确反馈。** 官方 Remote 将文件/行评论带回当前聊天；发首条前可以核对 host/repo/worktree/environment。它的 fork、Queue/Steer 与 side chat 后果明确。[Remote 流程](https://developers.openai.com/blog/mastering-codex-remote-for-engineering)、[审阅](https://learn.chatgpt.com/docs/code-review?surface=app)、[远程边界](https://learn.chatgpt.com/docs/remote-connections)。本次不声称测得它的切换速度。
5. **指定 CCB：从源码借鉴信息层次。** 连续工具按名称/次数聚合、权限操作就近、长消息折叠、图片撤销/放大。但输入提交即清空，本组件没有回执恢复；也有 hover-only 控件风险。不能把它当官方 Claude 体验完成度标杆。

OpenPI #598 已有多 Session 并行、置顶/归档、图片输入、文件/Office 预览和文本编辑、模型/思考菜单、六种主题、直接保存显示偏好、队列/压缩/失败恢复、每轮 diff/用时、键盘与 ARIA。不是缺这些入口；差距主要是相邻动作之间的连续性和结果语义。

## 下一轮验收与简化

- 草稿：切会话、刷新、断线、误关闭分别检查；不把“同页保留”当刷新恢复。验证文字、光标、附件/引用身份及有界清理。
- 工作位置：Files/Diff/Browser/Terminal→另一会话→回来，检查工具、页签、对象、滚动与焦点；关闭 UI 不等于终止执行。
- 结果：自动重试成功仅一个明确最终结果；失败、取消、等待输入、已恢复、历史尝试可区分，断线不意味着完成。
- 历史操作：编辑后重发、重试、分支、复制/导出后果分别明示；引用路径/行号直接生成反馈草稿。
- 布局：390/720/1099/1101/1440px 测同一任务，放大/恢复不会清草稿，不把输入框挤出屏幕；真实手机键盘、中文 IME、Safari 后续验收。
- 主题/模型：当场生效且当前值可辨；关闭/再开/刷新仍正确；不丢工作位置、不改执行身份，减少动态效果可用。

设计消融：移除“另建会话控制面、重做模型/provider 栈、复制整套竞品框架、增加大量主题、优先做远程 fleet”后，上述目标和验收仍成立，因此这些方案不进入首轮。保留现有 Pi Session/事件/配置路径，先补恢复结果和视图状态。长会话检索、原生分支、Diff 行引用为小型可组合入口；语音、桌面壳、远程接入需要独立范围，不作为本次已授权实现。

Unknown: 本机 Codex/Remote 真正手感；当前 DSH 0.24.1 和本机 Maka 的运行；Safari/真实触屏/软键盘/长会话性能；竞品显示但未操作的功能。Maka open Issues 也报告表单切换丢进度、换行 caret、状态难辨、特定长会话延迟，均未在本次复现，不把竞品视为无缺陷模板。

## 仓库验证

本次只添加研究草稿及索引，不修改实现。`bun run check` 通过（含文档/配置合同、Web 构建、格式、lint 和 TypeScript）；`bun run test` 通过：Node 2045 passed、8 skipped，Vitest 855 passed。Web 构建仍有既有大 bundle 提示，jsdom 的 canvas/scrollTo 未实现提示没有导致失败。

另执行上述真实 Host 的定向浏览器脚本，复核草稿、工作栏、宽度、搜索、布局边界、编辑后重发及浅/深色和移动模型菜单。没有运行完整 `test:web:e2e`、真实 Safari 或手机软键盘。UI 问题是烟测观察，不因单元测试已有绿色结果而消失；比较方的演示/官方素材与 OpenPI 的真实模型测试仍按前述边界分别记录。

静态报告在 1440×1000 与 390×844 验证通过：27 张图片可加载，无横向溢出或页面异常；问题/对比/验收页签、键盘导航、原图前后切换、Escape、关闭后焦点恢复及本地验收勾选保存可用。记录为证据目录中的 `report-verification.json`，不是 OpenPI 实现的功能验收通过声明。

## 后续实现与复测

用户后续明确要求发现问题后解决，以接近 Codex App 的基础交互为主。下列修改只在上述隔离 worktree，未提交或推送；保留之前的 PR 基线结果。源码和实际 Host 都来自这个 checkout，重启后 `pi list` 的唯一 OpenPI 来源与完整 HEAD 再次匹配。凭据只由隔离 Host 环境继承，不写入报告或仓库。

| 已实现的行为 | 验证证据 | 实际结果 |
| --- | --- | --- |
| 会话草稿刷新恢复 | `implementation-ui-receipt.json`、`draft-indexeddb-receipt.json`、`fixed-02/03` 截图 | 同一 origin 下恢复文字、图片和光标；A→B→A 不串草稿。发送确认、写入失败和迟到恢复分别受保护 |
| 自动重试的最终结果 | 同一真实模型产生的原始历史、`fixed-01/01b` 截图、provider outcome 回归 | 三次失败尝试随后成功，显示“请求已恢复”；尝试证据默认收起，恢复后不再提供失败重试按钮 |
| 切聊天后回到工作位置 | 工作栏位置回归与 `fixed-04` 截图 | Files、Review、Browser、Terminal 的有界视图位置按精确 Session 缓存；资源生命周期仍由活动工具和 Pi runtime 管理 |
| 阅读文件仍可输入 | `fixed-05-file-{1101,1099,720,390}.png`、浏览器布局断点检查 | 四种宽度保留同一个 composer，无横向溢出；“返回聊天”恢复输入焦点。已填写草稿不因 focus 布局重建 |
| 面板宽度恢复 | `fixed-06/07` 截图、配置合同测试 | 侧栏 420px 刷新后仍为 420px；宽度经过既有 setup/preferences 路径，合法范围和默认值同步 |
| 旧正文检索与准确定位 | 620 条原生消息合成夹具、`fixed-08/09` 截图、导航 race/Dialog 焦点回归 | 命中最近 250 条之外的指定原生消息，定位并聚焦；关闭搜索 Dialog 后交接焦点，不受 modal inert 阻挡。标题/cwd 筛选与正文搜索各有明确名称 |
| 修改后重发与 Diff 行反馈 | `fixed-10/11` 截图、Diff 引用回归 | 旧消息操作改为明确的“修改并重发”；引用保留旧草稿，加入准确路径、旧/新侧、行号和代码，焦点回输入框，不自动发送 |
| 当前回合纠偏与下一轮排队 | `queue-steer-receipt.json`、原生历史及 `turn_settled` | 真实 `gpt-6-luna` 执行 `bash sleep 15` 期间，两种投递分别进入原生队列；当前回复按纠偏 marker 改变，后续独立 marker 完成。相同命令重放不重复，过期目标返回 `TURN_CONFLICT` |
| 从指定历史消息分叉 | `fork-ui-receipt.json`、`fixed-12/13/14` 截图、8 个原生与 5 个 UI/store 测试 | 源聊天 8 条消息保留，新聊天仅复制选定消息为止的 5 条；原始文件字节不变，原生 `parentSession` 正确。继承模型与 thinking，原草稿保留、新草稿为空、无 `/api/prompt` 请求；同命令重放不再创建聊天 |

Queue/Steer 验收依据是队列事实、原生历史和终态事件，不以“已接受”按钮状态推断执行完成。第二张队列截图在一次 160ms 投影刷新前拍摄；两种队列同时存在由 canonical snapshot 证明。Fork 的 thinking revision 会随会话生命周期变化，继承检查比较 level、可用级别和支持状态，不要求 revision 相等。

实现消融保留最小必要机制：移除多余的组件 active 属性、永久草稿变更跟踪和重复的投递门禁后，原验收仍成立；移除异步 admission 后的回合复核会让迟到纠偏进入错误回合，移除旧消息请求序号/弹窗关闭后焦点交接会破坏已有 race 与真实浏览器验收，因此保留。历史分叉复用当前 Pi runtime 的 native fork，只有一个有界回执表和一个 pending 门禁，没有另建历史存储或模型栈。

全量 `bun run check` 通过；`bun run test` 通过：Node 2062 passed、8 skipped，Vitest 918 passed；完整 Chromium E2E 78 passed。完整 E2E 在最后一次成功提示样式调整前运行；调整后重新通过全量检查/测试，并用真实 Host 浏览器验证绿色 `role=status` 提示，定向 App 测试确认后续错误仍为红色 alert。日志保存在证据目录的 `final-check.log`、`final-test.log`、`final-e2e.log` 和 `implementation-validation-receipt.json` 中。原始研究阶段的 `report-verification.json` 不覆盖；实现截图报告复测记录为 `implementation-report-verification.json`。

仍有边界：草稿与工作位置是有界缓存，不承诺无限历史、多设备同步或不同 origin 恢复；浏览器跨 Session 仅恢复 URL/导航位置，不保存网页表单。当前聊天运行中不能分叉，其他聊天的后台执行可以继续。Codex side chat、远程 fleet、语音和桌面壳没有进入本轮基础交互范围。Safari、真实手机键盘、中文 IME 和端到端切换延迟尚未验证；不以静态截图宣称动画或性能已经追平 Codex。原有大 bundle 提示仍在。

## 五小时继续迭代：批次 1 / 2

以下追加记录于 2026-10-01 JST（运行时间为 2026-09-30 UTC），不改写前述研究与第一轮验收。任务继续覆盖基础流程、第三栏和截图对照；此段不是完整行业功能已追平或五小时已结束的声明。批次 1 / 2 的源码冻结分别为证据目录 `followup-20260930/batch-01-source/manifest.json` 和 `batch-02-source-final/manifest.json`。原 checkout、其他常驻 Host 和已有证据保留；隔离 Host 的升级记录单列精确原生 Session 恢复，不把前后静态资产和内存中的 Host 版本混作同一版本。

| 用户问题 / 实际发现 | 已验证变更 | 验证与边界 |
| --- | --- | --- |
| 粘贴图片已有缩略图却报 metadata invalid | 请求只带 Pi 原生 data、MIME 和 name；大 base64 用 canonical Buffer roundtrip，Host body 上限由共享协议派生 | 真 Host / Pi + 假 provider 一次原生用户消息；32 MiB 边界使用合成图片头，不宣称全部字节是可解码图片 |
| 正式图片投影漏掉 name，临时消息未合并 | 保留有界原生 name，界面不再重复用户图片消息及等待条 | 原生 JSONL 只有一条用户消息，旧 UI 显示两条；增强生产 provider 用例确认一条用户消息、原始顺序、等待数 0 |
| 左分隔线在 file focus / 中宽窗口不能拖 | 保留手柄并修正宽度边界，同一 composer 不重建 | 实际 Chrome 指针 / 键盘 280→360→300；1000px 刷新恢复 300；原图与 receipt 单列 |
| 结果未读靠计时，与实际阅读脱节 | 依据 exact native resultEntryId，在结果可见、窗口可见且无阻挡时确认阅读 | visibility、viewport、modal、轨迹页、焦点 / 控制边界分别验证；蓝色文件夹本身表示活动工作区，不等于结果未读 |
| 三个子代理完成，父文字仍说第三个运行；展开思考为空 | 专用 display subagent-result 与 child outcome 投影；空白 / signature-only thinking 省略 | 原生时间线证明父模型先写 1/2/3，第三个晚到后另发 3。保留真实历史，不由 UI 改写父模型判断或强制等待所有子代理 |
| Browser→Files→Browser 丢网页表单与滚动 | 同一 exact Session 已开 iframe 隐藏并 inert，显式 close / 控制失效 / Session 改变释放 | 实际 iframe 身份相同，表单保留，scrollTop 450；明确关闭后重新创建。跨 Session 不保存任意 DOM |
| 普通附件只能按图片处理 | 通用 picker / paste / drop，Worker 有界读取、原字节和可选文本 sidecar，按精确 Session 上传与准入 | TXT / code / PDF / DOCX / XLSX / PPTX / opaque binary 的真实生产 Chrome；上传失败 / Session 改变保留原草稿。无 OCR 或任意二进制可理解保证 |
| 中文 / 空格 / 百分号文件名，encoded Markdown href 不能直接用于 Pi read | href 保持合法编码，label 带原始绝对路径；用户消息只投影短名与展开路径，复制仍为原文 | native read 实际成功；代码块 / 普通文字 / 远程链接不被替换。首次 optimistic→native 只保留 display key，未改 native entryId 或历史 |
| 中文 PDF 提取人为插入字间空格 | 只拼原始 PDF.js item.str 和原始 hasEOL | Chrome 实际生成两页中文 / 🙂 PDF，ToUnicode、raw items、sidecar 和原字节分别核对；个别字体原 PDF 的康熙部首映射不被误记为 Web Unicode bug |
| Files 缺创建 / 导入 / 复制路径，保存未进入 Pi queue 与 Host drain | 新建文件 / 目录、原文件导入、相对 / 绝对路径复制，逐项部分失败与仅失败重试；复用 withFileMutationQueue、scope/revision/symlink/revoke 与 drain | 真 HTTP 32 MiB 原字节一致，同名不覆盖；桌面 / 390px Chrome、迟到请求、同 ID 不同 path 和 shutdown 分别验证。批次 2 不包含 rename/delete |
| 原生命令已处理，刷新仍显示等待模型回复 | 复用 handler 返回事实的 Pi custom entry，精确关联 input entryId 与 commandId | 五个真实 native handler 经刷新等待数 0，模型调用 0；反馈本身不代表处理完成，原生 agent 后续执行仍遵循其生命周期 |

普通附件的竞品结论依据冻结源码：Pi Web 支持图片与普通文件（普通文件 25 MiB 单项 / 100 MiB 一批）；Maka 的有效 picker/paste/drop 接受 image/PDF/document/code/other，8 项、50 MiB；DSH 原生上传和 DSH-better-sidebar 工作区导入是不同入口。Maka 未接入 UI 的文本导入辅助函数不被当作现有产品能力。OpenPI 本批普通附件为 8 项、单项和总量 50 MiB，提取文本单项 1 MiB，保留原文件；图片继续采用原生支持的 PNG/JPEG/GIF/WebP 及独立有界限额。支持原文件上传不意味着底层模型能直接读懂任意格式。Codex 官方素材与 DeepSeek API 文件能力也不用于推断其消费端未实测的精确文件类型 / 大小上限。

真实 `gpt-6-luna` 另用合成图片 / 中文文件验收：图片中的红方形、蓝圆形、绿三角和 598 均正确识别，原生 `read` 读到随机验收码及数量 37，原文件字节不变；一条 native user message、两条 assistant message、一条工具结果。累计使用为 input 7017、output 209、cacheRead 5632、cacheWrite 0、total 12858。该次调用使用原生 PiWebRuntime 与 prompt-file persistence，未操作用户活动 Session；它不是同一 Chrome 回合或模型正确率 Benchmark。独立 receipt 保留模型 / 源文件 / 图片 / Session / usage 身份。

批次 2 最终 `bun run check` 全通过；`bun run test` 为 Node 2088 passed / 8 skipped、UI 990 passed。完整默认真实 Chrome E2E 89 passed，真实 Pi + 假 provider suite 16 passed，附件生产专项原 8 项全部通过。初次 default 84 passed / 4 failed 的记录保留：两个旧 selector、一个完成分类文案期望更新，以及真实未翻译 Retry 文案修复。一次生产附件测试期间并发 build 清空 dist 的 harness race 被单列并重新跑原断言，不记产品通过或缺陷。

消融保留必要边界：原生 handler receipt / 精确身份、文件 mutation queue / no-clobber / revoke、浏览器已开 DOM 保留、附件 AST 真实 link 边界与首次 native 消息 key 连续性。可删除的 React memo / 多余机制已去掉；移除上述必要边界的独立复制实验出现对应失败。报告追加七组问题 / 结果原图，1440 / 390px 的全部 71 个图片实例加载、原图 dialog / Escape / 焦点 / 键盘 tab / 防横向溢出与 private URL 404 均通过；原研究和第一轮验收 receipt 保持不变。

仍在下一批实际验证：历史图片 inline / 大图 Source API 限额一致性、非原生图片格式作为普通文件、可选提取失败保留原件、整个 Files 画布 drop、Review 显式真实 branch ref 与缺基准诚实反馈，以及 lazy detail 与旧 summary 的 revision 对齐。文件 rename / 可恢复删除、folder import、多选、Review viewed marker、多个终端等继续作为明确差距，不以完成批次 2 声称已具备。

## 五小时继续迭代：批次 3 / 4 / 5 验收

本段于 2026-10-01 JST 追加，保留上述旧批次的原始意义。研究状态仍为 draft；下表是在 PR #598 隔离 worktree 的已验证观察，不是发布、架构 Decision 或跨产品 Benchmark。源码 HEAD 仍为 `563d6808ebbfee27c6bb6aeb02e7b593a656ee0c`；未提交或推送。私有证据根仍为上述稳定目录，最新生产实现冻结为 `followup-20260930/batch-05-source/manifest.json`，146 个修改 / 新增 / 删除文件，tracked patch SHA `2129fc408a7c391301757f0201e9441defb4c2605db1a57e674fa900d9ebb4e8`。最终文档追加后的身份另存，不覆盖该冻结记录。

| 已验证行为 | 证据与实际边界 |
| --- | --- |
| 原始三子代理结果的显示顺序 | 逐字节复制用户原生 Session 到隔离当前源码 Host；先到 2 个、后到 1 个，0 运行中 / 3 已完成。空思考省略，父模型“第三个仍在运行”与后续 3 原文保留；原件 / 副本 SHA 不变，原 controller 未改变，0 POST / 0 模型调用 |
| 持久化图片 inline / 原图 / 焦点 | 用原始 native content part index，不由过滤后的下标猜来源；历史图片在可视区域才读取。9724833 字节合法 PNG 的实际 inline / dialog Blob SHA 与原件一致，1800px 解码、原尺寸、关闭焦点、隐藏零读取和迟到切 Session 分别通过 |
| 图片 Source API 的返回预算 | 合法 10 MiB 原图与 base64 JSON 预算从共享协议派生；其他 snapshot 保持原预算。非 canonical / 超限与精确 Session id / path / entry / part 边界分别验证；未降低原 CSP |
| 图片模式文字按钮 | 文字模式按钮 72×32 单行，关闭图标仍为 32×32；页面内临时删除 scoped rule 会恢复 32×32 两行，恢复后 fit / original / Escape 焦点仍通过 |
| 提取失败保留原文件 | SVG / BMP 按普通文件保留；未知编码、坏 PDF / Office 标注“未提取文本 · 原文件保留”，允许继续发送。取消 / 读取失败与可选解析失败保持区别；不猜编码，不添加 OCR。生产 Worker 与原件落盘 SHA、草稿状态分别验收 |
| Files 全画布拖入 | 树、空预览、打开文件预览和隐藏树四个位置复用导入，每项 1 个 POST / 201，原字节一致。DragEvent / DataTransfer 为自动化分派，isTrusted=false；不冒充真实 OS 文件管理器拖入 |
| Review 基准与 detail 版本 | 显式搜索真实 heads / remotes ref；缺 main 能选 release，缺基准诚实反馈。detail 前后复核 source / base / summary revision，变化走“显示最新”。这是有界 Git 观察，不声称跨进程原子快照 |
| Review 显式阅读进度 | 文件行与当前 Diff 顶部可标记 / 撤销；打开文件不自动勾。按 exact Session id / path 与 source / base / 当前显示 revision 在本页内缓存，200 路径 / 32 Session；整页刷新不保留，同 ID 不同 path 不串状态。旧 pinned Diff 标记保留到显示最新，新 revision 清零。390px 当前文件目标为 70×44px，不代表模型完成或审查批准 |
| 实际面板切换录像 | 17 秒 Browser→Files→Browser、媒体主题和窄屏录像：同 iframe / 表单 / scrollTop450，聊天草稿可继续。system 主题由媒体模拟，不冒充用户设置持久化或切换速度 Benchmark |
| Terminal 连续性与错误恢复 | 真 PTY 的环境变量跨 Files 返回保留，offline 期间输出重放，退出码 7、重启确认 / Escape 焦点、新 shell 环境为空与 390px 无溢出分别通过。snapshot 恢复只清除其所属读取错误；同文案的保存失败 / 新业务提示保留 |

另一次真实 `gpt-6-luna` 从实际 Chrome picker、生产 Worker 和 Host 上传发出图片加普通文件。模型调用原生 `read` 读原件，正确返回红方形 / 蓝圆形 / 绿三角、598、随机中文验收码与数量 37。一条 native user、两条 assistant、一条真实 read，usage input 7536 / output 253 / cacheRead 5632 / cacheWrite 0 / total 13421。首个脚本在 native 断言通过后用了旧 `data-role` UI selector 而失败；原记录保留。随后仅恢复同一个原生 Session 做只读 UI / 刷新核验，原文件和 Session SHA 未变，没有追加模型调用。前述独立 runtime 验收的 12858 usage 不并入此回合或伪称同一次 Chrome 验收。

批次 5 `bun run check` 全通过，`bun run test` 为 Node 2094 passed / 8 skipped、UI 1028 passed。完整真实 Chrome 默认 94 passed，Pi + 假 provider 16 passed。批次 3 的 93 / 1 记录保留：执行期间加入了下一批 viewed 断言，而静态资产尚属前一批，单列版本不匹配。批次 4 的 91 / 3 记录也保留：单栏 Diff 标记入口确实缺失并已补；thinking Axe 在外层 Layer 的 165ms 进入动画中混色，10 轮即时检查有 6 次失败，而真实动画结束后 10 / 10 全部通过，最终测试等待有限动画结束并保留完整 Axe 断言，没有改颜色掩盖。分隔线单次键盘 End 失败尚无确证根因；原场景后续六轮及最终完整 94 项通过，不能把重测通过记作已解释其原因。

诊断过程有一次隔离疏漏：偏好探针未设置独立 Agent dir，写到个人配置。首次按键前可见栏宽 280 / 720 与写后 raw 值一致，无可证实的值变化；没有原始 raw-before，未猜测回滚，也不声称文件字节完全未变。写后配置原字节以 0600 保留在私有证据中，后续探针在进程启动前设置隔离目录。此项属于测试过程失误，不是 Web 产品缺陷。

消融保留必要的原生索引 / Source scope / canonical bytes / 返回预算、图片可见性与关闭焦点、可选提取兜底、Files 单入口与最新目录回调、Review revision / 显式进度 / 跨会话缓存 / 当前 Diff 入口、读取错误的归属保护；对应删除实验出现明确失败。动画前置等待来自实际 Layer 生命周期，未放宽功能或可访问性断言。报告追加原生会话 AFTER、普通文件兜底、Review / Files / Terminal 原图与切换视频；每项区分真模型、假 provider、原生记录副本与合成事件。

剩余差距明确保留：目录导入、多选、文件 rename / 可恢复删除、多终端与整页刷新后的阅读进度持久化尚未实现；附件能保留原件不等于模型能理解所有二进制格式。普通 parser 错误可保留原件，但 15 秒超时或 Worker 启动 / 运行故障会明确拒绝该单个文件，其他有效附件保留，不声称全部失败类型都可继续上传。Codex 原生 App 局部界面、Safari / 实机手机键盘 / OS 中文 IME 和跨产品切换延迟没有完整实测。当前代码和截图不构成已全面追平竞品或没有偶发交互问题的声明。

## 现场演示与历史自动分页跟进

2026-10-01 JST 追加；研究仍为 draft，沿用 #597 / PR #598、同一 HEAD 与隔离 Agent 来源。用户要求在其可见的现有 Web 中操作，并追加三个问题：会话概览中子代理应位于来源之前、已勾选工具应能再次打开、旧消息应自动分页并预取。证据保留在稳定根目录的 `live-demo-20261001/`，不覆盖此前 Chromium 验收。

现场已验证：IAB 的实际文件选择器上传合成图片、中文 TXT 与两页中文 PDF；当前真实 Luna 读取 TXT 原件及 PDF 提取文本，正确回答颜色 / 形状 / 598、验收码 / 数量 37 和 PDF 页数 / 中文句子。文件、Diff、浏览器、终端切换保留演示草稿，PDF 下一页实际打开。终端逐字符输入最初失焦，只执行了一个 `p` 并失败；单次粘贴后实际打印 `OPENPI_LIVE_DEMO_OK`，失败没有删去。IAB 内嵌报告可读取 URL / 滚动，但自动化点击内页报目标失效，因此本次现场不声称验证内页表单；前批独立 Chromium 的表单验证仍按原边界保留。演示期间用户同时操作页面，未将其新草稿当作授权发送。

来源核对与实现选择分开记录：

- **Maka 工具菜单源码事实。** 冻结源码 `5ac266b1e67972f3781907583b0b089beedce947` 的 `workbar-surface.tsx` 将 checked（已开页签）与 enabled（能力可用）分开；`workbar-tabs.ts` 的 singleton 打开复用并激活原页签。浏览器 / Review / Files 为 singleton，终端 / 侧边对话支持多实例，不能概括为所有工具都只复用。Pi Web 同文件 / 同 cwd 终端也复用并激活，但没有据此推断它具有相同的勾选菜单。
- **Codex 分页源码事实。** 本地副本的 `thread_history/read.rs` 与 `segment_paging.rs` 逐字节对应官方仓库 `a7ab2d66d781b903cb060288a89e26e8d2b9a05f`；cursor 绑定请求 thread 与查询 scope，底层查询剩余 `page_size + 1` 预算，溢出才返回 next cursor。协议的 Turns 查询默认 descending / summary，并提供反向 cursor。这证明后端分页边界，不证明 Codex Desktop React 前端的具体预取策略。[分页实现](https://github.com/openai/codex/blob/a7ab2d66d781b903cb060288a89e26e8d2b9a05f/codex-rs/thread-store/src/local/thread_history/segment_paging.rs)、[cursor 绑定](https://github.com/openai/codex/blob/a7ab2d66d781b903cb060288a89e26e8d2b9a05f/codex-rs/thread-store/src/local/thread_history/read.rs)。
- **Maka #5712 来源事实。** 读取 PR 说明及 `8bf70dace65bb099319a4cc3779a804f0abbe0df` 的实现：较小初始窗口、相邻历史自动加载、有界保留、阅读窗口与 live 高水位分开；保留可访问的手动入口 / 失败重试。其性能数字归属于原 PR 的冻结实验，不作为 OpenPI 性能结论。[PR #5712](https://github.com/apache/maka/pull/5712)。

本次实现沿用 Pi 原生历史 API：只缓冲一页，不安装未显示页、不因预取更新阅读 anchor；向上接近边界才消费，追加前保存 DOM 阅读锚点，再预取一页。Session id / path、原生 anchor / before、分支验证与 AbortController 仍负责隔离；失败不由滚动事件无限重试，键盘 / 手动重试入口保留。会话概览只移动已有区块。工具菜单只补选择后的焦点交接，勾仍表示已打开；点击激活原工具、关闭菜单并聚焦标签，关闭仍由独立 × 完成。这是本次实现选择，不是新增 runtime 编排或已接受架构约束。

源码专项验证已通过：历史与 Transcript 三文件 134 项、工具菜单 8 项；UI 类型 / 格式检查通过。开发入口的 StrictMode effect 重放会取消首次预取，清理时同步重置尝试身份后可重取；相关回归已覆盖。消融分别移除未显示页保护、只预取一次、隐藏时取消、向上自动触发、StrictMode 清理均出现对应失败；冗余的消费后标记重置已经删除。工具菜单消融证明菜单关闭后的焦点交接和取消必要，同步聚焦仍会输给 Review 首次阅读焦点；保留提交后一帧交接。完整仓库门禁、生产浏览器和最终现场操作的命令 / 时间 / exit code / 源码前后 SHA 保留在 `live-demo-20261001/gates-receipt.json` 及同目录日志；本段专项结果不替代该最终 receipt。

首次整合检查通过，Node 2094 passed / 8 skipped、UI 1047 passed，但生产浏览器为 3 passed / 2 failed，未当作最终验收。向上追加的锚点偏移检查通过，随后 live 增长的旧绝对 scrollTop 断言差 63px；另一项把未显示预取分支失效也期待为“历史已变更”提示，虽然旧分支未进入 DOM。可见 IAB 另实际发现旧页数量 581→541→501，而顶部仍第 291 轮，DOM 的更早轮次插在其后。原合成 Session 的 620 个 native 消息 ID 全部唯一，却只有 58 个 role / timestamp 组合、55 组碰撞；`buildEntries` 原先优先用该组合当 React key，无法识别 native 消息。修复方向为 native persisted key 使用 entry id，live 对齐 / thinking timing key 与显式 optimistic receipt 分开，补多轮同 timestamp 的真实分页顺序与阅读锚点验证。该缺陷和首次失败证据保留，不能用第一轮绿色组件测试替代真实阅读验收。

用户随后明确要求移除常态“加载更早的消息”按钮，覆盖前述保留手动入口的实现选择。最终常态只保留向上自动读取 / 预取提示，加载时显示 status；失败才给出重试按钮，键盘向上阅读仍自动触发。同 timestamp 修复的专项检查还实际发现 live 思考落盘后详情重挂载，用户手动展开会关闭。最小交接映射只对当前 displayed native IDs 保留，按精确 Session id / path 隔离；仅完整 projected payload 在 native / live 两侧各唯一时沿用原 live.key，离开窗口即删除。历史默认使用 native ID，重复内容 / 非完整投影不按 timestamp 猜身份；没有改 Pi 的 message_end 通知早于 appendMessage 的生命周期。

最终源码专项为 140 项 / 3 文件通过，覆盖无常态按钮、可聚焦 log、PageUp 单请求、加载 status、error-only Retry、多轮同 timestamp 的 native ID 唯一 / 顺序 / 原节点、thinking / tool 交接节点保留、精确 scope 重置、重复 payload 不猜匹配与同 timestamp 不同内容仍可见。新增四项 key / alias 消融分别移除 native key、匹配唯一性、内容等同性和 Session scope 保护，均出现相应失败并恢复；证据与源码 / verifier SHA 保存在 `followup-20260930/history-preload-20261001/key-alias-receipt.json`。另用 60 个同 timestamp 原生轮次验证 41→21→1 与 40→80→121 个唯一原生行，最终一页包含共享 fixture 根记录，不能误删这条真实历史。

63px 的进一步实际测量为：live 更新前 scrollTop / scrollHeight / clientHeight 为 14681 / 15308 / 627，更新后为 14744 / 15371 / 627，前后都精确位于底部。原断言错误地把底部跟随当成旧消息阅读；生产代码无需为此修改。浏览器用例现分别验证底部随新回复滚动，以及真实向上滚轮后仍保持同一个首个可见 native ID、相对视口位置与 scrollTop 偏移均 ≤2px；原分页接入的 DOM 锚点 ≤2px 断言保留。独立历史生产用例 3 / 3 通过，完整门禁的最终实际结果仍以 receipt 为准。可见 IAB 已核对常态按钮为 0、40→80→160 个唯一原生行、首轮 291→271→231；最后一次大幅上滚包含多个 wheel 事件，不据此声称单手势只消费一页。

本轮最终门禁于 2026-10-01 03:38:30 UTC 完成：`bun run check` 通过，`bun run test` 为 Node 2094 passed / 8 skipped、UI 1053 passed；历史 / 会话阅读 / observer / sources 相关生产 Chrome 6 passed。receipt 的十个实现与验证文件 before / after SHA 一致；没有与生产验收并发 build。源码根及个人配置保持既有隔离边界。报告追加本次三个前后图卡片，未把旧批次 94 项当成本轮重新验证结果，未提交或推送。

## 消息刻度导航的进一步对照

2026-10-01 JST 追加，仍为 draft 观察。用户指出整个消息标题目录展开过大，并追问 Maka 的 64 个刻度为何没有覆盖 120 组示例中的每一轮。本节不改写上一轮自动分页的结果；新证据位于同一稳定根的 `turn-navigation-20261001/`。

**旧 OpenPI 的源码与实测事实。** 导航以本地递增 turn 数字作 React key 和 document 全局定位；分页 prepend 会重新编号，配置请求还没有相应 `turn-N` 目标。列表没有当前阅读位置属性，高亮只由 hover 产生。CSS 将整列在 hover / focus-within 时扩到 240px，包含 composer 的 shell 被当成居中基准。实际 IAB 1135×792，键盘聚焦第 279 轮、正文可见第 304 / 305 轮时，展开列表宽 240、高 554.4，与跳至最新按钮重叠 3822px²；当前阅读属性数为 0。原用户图及折叠 / 聚焦原图、几何 receipt 分别保留，不把 hover 文本当成已验证的阅读位置。

**Maka 的冻结来源与实际组件夹具。** `5ac266b1e67972f3781907583b0b089beedce947` 的 `packages/ui/src/prompt-anchor-rail.tsx` 和 `apps/desktop/src/renderer/styles/prompt-rail.css` 使用 Core HoverCard：紧凑刻度始终保持宽度，仅当前悬停 / 聚焦项显示提问和答复各两行的小卡，120ms 延迟、最多 280px 内容宽；按真实聊天视口 / composer 安全区定位。源码对超过 64 个提问均匀采样导航位置，消息内容没有因此删除。实际打开本地现成 Storybook 的 `prompt-rail-stays-inside-the-scrollport`，真实 ComposedShell 使用 120 组合成提问 / 答复：64 刻度、列宽 34px；聚焦第 111 项只出现一个 280×62 内容预览，当前阅读属性仍指向第 120 项，Escape 关闭预览。模型没有运行。对应三个源码文件及五个 story export 与冻结来源字节一致，关键静态资源 SHA / HTTP 校验保留；整个旧静态构建来源没有完全证明，不能称为实际 Maka 原生 Session 或跨产品尺寸 / 性能 Benchmark。官方历史 PR #4924 的预览图单独作为历史素材。

**本次实现选择。** 学习单条预览和真实阅读位置，复用 Core HoverCard 和 Pi 已显示的原生消息；不照搬 64 点采样。用户希望逐轮可达，且 OpenPI 已加载窗口本来受 entries / bytes 预算限制，因此显示全部已加载提问刻度，过长时仅刻度列内部滚动；更早的提问随既有自动分页接入。这不代表一次全量读取整个 Session，也不新增全库索引或导航存储。正文分组保留现有数字，导航按精确 Session scope 和 native entry identity 定位；布局必须满足 OpenPI 自身正文 gutter，不能直接复制 Maka 的 825px / Workbar 48px 参数。实施与最终验收结果以本轮 receipt 为准。

### 后续方向：对照本机 Codex 的导航与历史接口

用户随后明确要求按 Codex 的实际设计实现，覆盖上一段仅展示已加载窗口的选择。本段仍为 draft 源码观察与实施记录，不将竞品机制提升为 OpenPI 的长期架构约束。

**来源身份和证据边界。** 只读提取本机 `/Applications/ChatGPT.app/Contents/Resources/app.asar` 的前端源码；版本 26.928.20755、build 12246，ASAR SHA-256 为 `2301fba40bd8fa237ccdb1369363e1deefaf27953da2d767d428225d5e9eedee`。逐个原始 asset 与格式化衍生文件的身份、行号和函数偏移分别保留于私有证据根的 `turn-navigation-20261001/codex-local/`、`codex-history-local/`。没有执行厂商 bundle、读取个人会话或凭据。Computer Use 明确不允许操作该 Codex 桌面应用，因此本轮不能提供实际桌面操作或截图；下面是安装版本的静态实现事实，不证明某个实际会话启用了相应功能分支。原始厂商资源不进入仓库或报告媒体服务。

**导航的源码事实。** 本机 Codex 的 64 是稳定渲染分组的目标大小；每组仍逐项映射全部对应记录，配合 `content-visibility:auto`，没有 64 个导航项上限。Web 左侧 12px、Electron 左侧 16px，列宽 36px、项高 10px；少于四项不展示。列表独立滚动，最大高度为 `min(70vh, 40rem)`。显示条件来自正文相对于真实滚动视口的左侧空隙，按 scale 归一后至少 48px，而非固定窗口宽度。悬停 150ms 后显示一条提问与最多三行答复，内容宽最多 320px；当前位置来自实际可见 turn 的连续范围，可以有多个刻度同时标记。单击使用原生内容身份定位；未加载目标先 reveal，再滚动；Alt+上 / 下和按住指针纵向拖动可跨提问导航。

**历史索引和接口的源码事实。** 索引读取器以 `itemsView:'notLoaded'` 按每页 100、最多十页查询 turn 身份，全部读完才标记 complete；达到预算仍有 continuation 时为 incomplete。完整轻索引导航有明确门控（history timeline、支持分页或满足服务端版本的 legacy、非 shared / aeon / 子代理、正文尚不完整、索引 complete），不能据此宣称任意长度对话都开启全历史导航。悬停预览按需读取对应 turn，验证原生 turn ID 与游标，提问 / 答复分别截至 240 个 Unicode code point；失败可再次读取。安装版本的普通分页分支实际调用 `thread/turns/list`，保留 thread ID、cursor、limit、sortDirection 和 itemsView。[官方 app-server 接口文档](https://learn.chatgpt.com/docs/app-server) 同样说明该实验接口的游标和三种 itemsView；文档示例的 50 不等于桌面加载预算。初始 tail、canonical gap、legacy scroll 和 shared prefetch 是不同路径，不将某个 800px、64px 或缓存期限混为统一策略。

**迁移到 Pi 的实施边界。** 复用 `SessionManager.getBranch()`、精确 Session id / path / anchor、既有有界历史与 message-window。新增只读的人类提问 ID 分页和单条文本预览，不引入 Codex turn / island 存储；索引不包含正文、不持久化、不确认结果已读。普通 user、有效的原生 Web 命令输入和正文确实投影为 user 的 setup 请求共享识别规则；仅显式原生父命令身份、command ID 和完全一致的显示文本抑制同一 episode 的 setup echo，独立同文请求仍各自可达。未加载点击沿用已有 store 导航；窗口保留被点击的原生提问并尽量包含同轮答复，超预算仍保留目标。请求 anchor 的校验和正文阅读 anchor 分开，后者使用窗口最后 included 原生项以避免后续拼接重复答复。没有请求模型作判断或修改 Pi 原始消息。

这里的分页是原生 branch 的有界响应分页；Pi JSONL 的读取仍由 SessionManager 负责，没有建立数据库游标或第二份历史存储，不据此宣称磁盘层只读取一页。指针拖动仅跳转已经加载的目标，普通单击才 reveal 未加载项。实施、消融、完整仓库门禁和实际 Web 结果尚需以下最终验证记录；静态竞品事实不替代本产品运行证据。

**消融与独立复核。** 后端最终 111 项、客户端 2 项专项通过；七项必要机制（精确身份、anchor / cursor、Unicode 上限、精确 echo、有效 setup 投影、同轮窗口、超预算目标保留）在外部副本中分别移除，都触发相应失败。撤掉了并非目标所需的 metadata-only 特殊投影，保留既有 canonical projectEntry。前端删除了本地导航数字游标和固定正文挤压设计，沿用原有 store / reading window；完整索引、末 included 阅读 anchor、loaded 点击取消旧 reveal、preview 与几何依赖分离、拖动期间保持刻度位置、交互项优先可达的六项移除都检出失败并恢复。独立只读复核还纠正了少于四个已加载提问时无法启动轻索引的循环，以及同 Session / leaf 的外部搜索 receipt 接管后旧 rail 请求误报错误。Alt 导航按真实 prompt 矩形选择，当前位置 Set 只负责阅读高亮。

**失败阶段保留。** `validation-2026-10-01T05-27-03-084Z/` 的 check 成功、Node 2104 passed / 8 skipped，但 UI 为 1073 passed / 1 failed：旧 spy 期待一个实参，新的可选 signal 是第二实参 undefined，已明确修正该验证。`05-35-43-782Z` 的全套单元均通过，生产浏览器六项通过、导航项超时；trace 显示鼠标点击只有 preview，没有 message-window。实际 IAB 同样单击第 130 项后仍停在第 125 项。根因是整列 nav 捕获指针，后续 click 被 retarget 到容器；本机 Codex 在具体 button 捕获。最小改为在现有 scrub ref 保存真实 button，捕获、释放、取消、隐藏清理都使用同一对象；恢复旧容器捕获的消融检出失败。没有把生产鼠标点击改成键盘或放宽超时来绕过此问题。

`05-47-28-525Z` 的 check、Node 2104 passed / 8 skipped、UI 1078 passed 均成功，生产六项通过；导航用例继续到键盘阶段才失败。其旧断言从 focus 第 5 项直接期待第 4 项，但真实 viewport 顶部是第 3 项的答复，第 4 / 5 项在下方。Codex 的 Alt+上按 viewport 顶部阅读位置处理，会先返回第 3 项顶部；此阶段属于验证几何假设错误，不修改已匹配安装源码的产品选择算法。原失败截图和 trace 保留，最终生产结果另记。

**实际 Web 现场。** 最终指针修正版 rail SHA-256 为 `83c3a322e77c0b8f6ed2d5e3f0d5b5db6b348a1bdda25bfb3a6d710aaf234d7c`。真实 IAB 1135×792，同一个 310 组合成原生会话：310 个唯一导航身份，初始正文仅最近 20 轮；左列 36px、正文左空隙 129.5px。聚焦未加载的第 125 项显示一张 320px 预览，提问一行 / 答复三行截断，正文仍第 309 / 310 轮；Escape 关闭并保留原刻度焦点。真实鼠标单击后原生目标身份匹配，同轮答复恰好一次，窗口正文仍有界 20 轮，刻度仍为 310，与跳至最新重叠面积 0。实际拖动第 125 → 124 项，焦点及预览均为第 124 项，未回弹到初始按钮；返回最新，再 Alt+上 / 下分别定位到第 308 / 309 项的准确原生身份。没有发送 prompt。`accepted-native-ui-receipt.json` 与 13–16 号原图保存具体观测；这些是 OpenPI 实测，不能标成 Codex 截图。本轮小卡使用纯文本，Markdown 表格 / 代码等在正文阅读，不把此细节宣称为与 Codex 预览完全一致。

**用户纠正导航方向。** 在最终门禁前，用户明确指出导航应位于另外一侧。本产品因此改为正文右侧 12px、36px 列宽；留白检测同步镜像为实际右 gutter，预览向正文左侧打开，刻度右对齐并从右端缩放，错误提示也位于列左方。Codex 的静态左侧事实仍按上文保留，不能将其解释为覆盖用户方向要求的产品约束。右侧版 `TurnNavigation.tsx` SHA-256 为 `8e4304c961c74c8660fb51cd104e7b97870a92b3dd9b9f5990095104657b4536`，CSS 为 `e406253889d0e03444e5e34cc7fae4e476553753a2c0e2ad98c476e989509a8f`；独立只读复核确认工作栏是相邻 grid 列，preview 为同 document 的 Core top-layer，跳至最新安全区和具体 tick 的指针捕获清理仍保留。13–16 号左侧图只代表先前阶段，右侧实际结果和最终门禁另记。

**右侧最终验证。** 2026-10-01 06:14:24 UTC 完成 `validation-2026-10-01T06-12-42-587Z`：check 通过，Node 2104 passed / 8 skipped、UI 1078 passed，生产 Chrome 阅读 / 导航相关 7 passed、布局 1 passed；25 个指定实现和测试文件 before / after SHA 一致。右 gutter 47 隐藏 / 48 可见使用非对称夹具，误恢复左侧条件会失败；预览 start 改为 end 也失败，两项消融已逐字恢复。宽屏分支实际 IAB 1135×792，rail right 1123、root right 1135、width 36，310 个入口与 20 轮正文。第 125 项显示向左的单条预览，提问一行 / 答复三行；Escape 返回刻度。真实鼠标定位同一 native `d4102bc5`，答复恰好一次；真实拖动到第 124 项 `5fa7f23d`，rail scrollTop 993.5 不回弹，与 Jump 重叠为 0。键盘和工作栏右边界另由上述生产用例证明，不冒充这次现场也重新操作过。原图 17–19 为右侧阶段，本轮没有发送 prompt。

报告在原有 renderer 中追加右侧对照卡，HTTP 字节校验 4 张引用导航图片一致、3 个私有证据路径均 404，脚本语法通过。该校验只证明报告语法与媒体，不代替报告控件现场验收。用户在 06:12:13 UTC 继续授权两小时体验迭代；后续修复单独冻结、消融并验证，当前导航通过不是其余体验问题全部完成的声明。

### 两小时跟进：连续交互与文档阅读

本段仍为 PR #598 的本地 draft 实施观察。复用既有精确 Session 阅读状态、原生 message-window、草稿归属和 Core Dialog 生命周期，没有新增历史存储、执行判断或用户配置选项。

- 搜索词、归档范围、刷新或弹窗关闭时取消旧的定位请求。旧回包不能关闭新查询，新结果仍可操作。真实 Chrome 使用持久 Pi Session，验证 A 请求取消后 B 查询保留，点击 B 聚焦准确的原生消息；0 真实模型调用。
- 已观察的正文读取完整轻量索引，不再由刻度 gutter 可见性决定。窄窗口仍可通过键盘定位未加载邻项；真正关闭正文观察时保持失效。Composer 已消费的 Alt 键和输入法事件不再泄漏到正文导航。删除无消费者的 `onVisibilityChange` 回调，未增加索引缓存框架。
- 关闭拥有焦点的工具页签后，将焦点交给保留的页签或现有工具入口；不会跨会话或抢走新焦点。新 Diff 文件从顶部开始，同文件往返保留滚动位置。
- 在既有会话阅读记录中保存当前文档的路径、版本、页码及 PDF 缩放；PDF/Office 资源仍按原生命周期销毁并重新获取。版本、路径或会话不同不会继承旧控件。去掉不必要的 callback memo，控制测试仍通过；独立复核和五项机制删除均验证了必要性。
- 文件预览失去当前附件或草稿归属时清理旧选择；正常关闭才安全回到原按钮。普通侧边栏在 native modal 打开时不可点击，不把组件 A→B→A 推断为普通侧边栏现场缺陷。生产浏览器另用延迟上传的自然入口验证成功接收后关闭预览，切会话返回不重开；该夹具记录 1 次合成发送，没有真实模型调用。
- 图片字节读取失败明确提示重新添加并保留消息；有效签名检查失败仍提示格式不支持。OS 读取异常用真实 Composer 组件注入 `NotReadableError` 验证，未宣称真实浏览器文件系统故障现场已复现。

**现场与验证。** 同一 IAB、同一中文 PDF，旧构建第 2 页/125% 经 Files→Browser→Files 后变成第 1 页/100%；新构建保持第 2 页/125%。关闭浏览器工具后焦点为“文件”，草稿为空，现场没有发送 prompt。真实 Chrome 文档用例使用实际 PDF 和 XLSX 解析器，确认第二工作表、未发送草稿、工具页签、原文件字节与 native 历史保持。Session/path/revision 隔离和 Review 滚动边界另由组件测试证明。临时 viewport 操作未改变隐藏 IAB tab 的 1280px 宽度，已恢复默认，不计作窄窗口现场验收。

最终 `iteration-2h-20261001/validation-2026-10-01T08-00-25-237Z`：`bun run check` 与 `bun run test` 通过，Node 2104 passed / 8 skipped、UI 1116 passed；47 个指定实现/测试文件前后 SHA 一致。生产 Chrome **98 passed / 1 failed**，不能宣称全部通过。新搜索、文件预览、文档阅读与历史导航用例通过。先前搜索超时来自 macOS 临时目录 `/var` 与 `/private/var` 的身份不一致，夹具统一真实路径后保留原超时并成功；先前耗时测试混算新索引后台 timer，改为验证其已有唯一 interval 创建、持续运行和准确清理，保留所有单调时间断言，未撤回产品索引。

**仍未解决。** 原有增强浏览器连续打开第六个网页时只有五个页签，在两次完整套件中复现；原用例单独运行通过。两份失败 trace 保留，点击前当前页已报告绑定后的原生标题，因此不能归因“未就绪”。尝试添加标题等待后据证据删除，没有增加延时或修改扩展来掩盖异常。需要进一步记录可信点击、扩展 open/lost 消息与 UI add 的边界才能确定原因。

报告复用现有 renderer，新增 PDF 前后、XLSX、附件生命周期、搜索成功和未解决浏览器失败原图。引用媒体逐字节 HTTP 校验、脚本语法及三处私证 404 单独验证；实际报告原图加载为 1280×720，Escape 返回对应查看按钮且无横向溢出。原始 Session、厂商源码与证据 JSON 仍留在私有证据根，没有公开发布、模型调用或跨产品性能结论。

## 发布整合与复测（2026-10-01）

用户授权先建 Issue、认领并推送 PR。已建立 [#639](https://github.com/openpi-dev/openpi/issues/639)，由 `testikun` 认领。#598 已以 `657eff9cf8d58e9cc0a19a86f0d14ca9b2811974` 合并，本次只将后续修改整合到该 main 基线，没有重复带入原分支的 55 个提交。实现提交为 `dfc392675959fdd41f380aa3576283d69e0d6029`，后续文档链接提交不修改已验证的产品代码。

Diff 读取保留 main 的固定比较版本检查与回归，叠加本轮分支基线选择、读取前后校验和独立 `summaryRevision`；文件详情不冒充整份比较的原生身份。上游“切文件前外部修改应拒绝，采用最新后才显示”的组件用例保留并通过。整合时移除重复类型 import，没有引入新抽象。

发布批次 `publication-20261001/` 复测：`bun run check` 通过；独立重跑 `bun run test` 为 Node **2105 passed / 8 skipped**、UI **1117 passed / 79 files**；生产 Google Chrome 全套 **99 passed**（约 3 分钟）。构建后源码与 Web 制品保持一致；隔离 `pi list` 只报告本次 checkout，provenance 匹配。私有归档、截图、原始 Session、凭据与第三方源码不进 Git，公开回归可从 `tests/web/` 重跑。

失败记录不覆盖：首次 check 检出整合后的重复类型 import，已移除；首次与构建重叠的 Node 测试为 2104 passed / 1 failed / 8 skipped，原有 Antigravity 5ms SSE 用例期待后续事件超时，实际首事件超时。未改动该实现或断言，构建和浏览器结束后的完整重跑通过；这支持负载相关的推断，不能证明原因。前一阶段两次完整浏览器套件中的第六页签失败仍是未定位风险；本批同一用例通过，没有扩展产品修复，不把它重新归类为已解决。PR 因此保留 draft 状态供审查。

## 第六页签风险定位与跨平台复测（2026-10-01）

本段继续 [#639](https://github.com/openpi-dev/openpi/issues/639) / [PR #640](https://github.com/openpi-dev/openpi/pull/640)，保留上文尚未定位阶段的原始结论。诊断基线为 `01111cf182222fec4b4bc65d363121fe4f6ed7a7`，隔离 `pi list` 的唯一 OpenPI 来源仍为该 checkout，provenance 匹配。使用 Google Chrome `154.0.8037.58`、Node `24.19.0`；没有真实 provider 调用或用户活动 Session 操作。诊断扩展只在私有副本中加入事件记录，原始产品扩展未修改。

**已观察到的失败边界。** 可信鼠标按下、抬起和点击有时落在父页面的 iframe 元素，而非子文档链接；另一次按下落在父文档、抬起才进入子链接，没有形成子文档的完整点击。失败前子页已有 bound 和原生标题，但没有随后产生 child click、extension open 或目标 HTTP 请求。因此，DOM、标题和绑定可读不能证明原生鼠标已送入该文档；本次没有观察到已经发出的 open 消息被 Web 丢弃。诊断失败也出现在第四、第七个页签和八页签后的上限操作，不能把“第六个”当成固定产品上限。

**消融与最小修正。** 取消新增页签后的自动聚焦，仍在 11 次通过后失败；移除外部空弹窗步骤，仍在两次通过后失败。单次 hover 再等待 `:hover` 的尝试在三次通过后失败；扩展为全部 iframe 控件后，原生按钮已收到可信 pointermove，但 `:hover` 仍为 false，因此删除该判据。可信 pointermove 回执版原始扩展流程连续 **20/20** 通过；进一步移除事件监听和轮询，仅在这条用例的各 iframe 原生点击前执行一次 `Locator.hover()`，同样 **20/20** 通过，最终保留这一较小实现。没有重试点击、合成 JS click、固定 sleep、增加超时或删除原断言。第六/第八页签、八项上限、单个外部浏览器页面、跨域导航、CSP/X-Frame-Options 与扩展清理仍逐项验证。

新增失败尝试也保留：原始生产用例单独重跑在空弹窗阶段超时；只给新链接加前提的中间版本为 10 passed / 1 failed，仍在空弹窗阶段失败。两个不带 OpenPI/扩展的简化跨域 iframe 夹具各为 20/20，未复现完整条件，不能据此证明 OpenPI 布局无关。Chromium 内部绘制/命中测试原因仍未确定；本段确定的是测试输入发生在扩展 open 之前的失败边界，不宣称修复了跨浏览器产品事件转发缺陷。

**发布期间发现的 Windows CI。** 原提交的 [Windows job](https://github.com/openpi-dev/openpi/actions/runs/36850455058/job/110330842924) 为 Node 2002 passed / 2 failed / 8 skipped。Git detail 的并发写入验证夹具依赖 `/bin/sh`、`/usr/bin/git` 和 POSIX PATH，未到达 barrier；改为隔离子进程内拦截同一次 `execFile("git", … "--patch")`，放行后仍执行真实 Git，并保留读取前后 revision 拒绝断言。

另一个失败为两次相同附件批次并发发布时返回 `PROMPT_FILES_DENIED`。Windows 的 rename 由 [libuv 的 MoveFileExW 路径](https://github.com/libuv/libuv/blob/v1.x/src/win/fs.c)实现，原日志未保留底层错误码，不能从该 403 单独认定具体系统错误。现在将 `EACCES` / `EPERM` 与已有目录冲突一起交给原有完整 batch 验证；仅在原始字节、目录/文件身份、Session 和权限边界全部有效时返回回执。没有目标、文件被篡改或 Session 已变仍拒绝，失败 pending 仍清理。定向 33 项通过；分别强制两种错误码的真实并发文件实验验证相同路径回放、无 pending 残留及缺失/损坏拒绝，撤掉新增错误处理的私有消融失败。真实 Windows 结果由后续 CI 记录，不能用 macOS 故障注入替代。

私有证据身份为 `openpi-web-audit-598-2026-09-30/popup-fix-20261001/`，包含原生事件链、诊断/原始扩展日志、失败 trace、各消融和 933 个 tracked 文件的门禁前冻结。原始证据仍由操作者保留，外部审查可通过公开的 `tests/web/openpi-web.e2e.ts`、`git-review.test.ts` 和 `prompt-files.test.ts` 重跑回归；归档名或 SHA 不构成公开可获取证据。

**完整套件追加发现。** 该次生产 Chrome 全套为 98 passed / 1 failed，增强浏览器用例通过，失败转为历史导航的工作栏几何验证。失败 trace 的真实 snapshot 为正文宽 930、侧栏 280、工作栏 720；2000px 窗口打开工作栏后正文宽 1000、右留白约 35，达不到既有 48px 显示条件。旧验证却仍期待导航可见。此前外观用例会保存 package-wide 偏好，这条几何用例现在显式使用 canonical 默认正文/栏宽的 snapshot 外观夹具；原生 Session、消息/索引、窗口查询与全部导航断言保持。没有扩大产品可见范围或把导航挤进正文。原失败日志/截图/trace 保留，最终复测另记。

固定几何后，连续验证又在 1 passed / 1 failed 阶段捕获了真实滚动问题；加记录的私有重复也复现。当前阅读窗口 scrollHeight 1530、clientHeight 627，向上平滑跳转刚从底部 903 到 900 时，旧 onScroll 仍按距底部不足 48px 将 pinned 设为 true；随后快照更新发出 instant scrollTo(1530)，取消向上跳转。最小产品修正复用已有 upward 判断，向上移动时保持不跟随，向下返回底部仍恢复跟随；没有取消平滑滚动或新增导航状态机。组件专项 23 项与原生历史浏览器连续 10 次通过，撤掉该判断的新回归失败，已逐字恢复。

**收窄滚动修正。** 上述方向判断的完整复测为 97 passed / 2 failed：历史自动分页多消费一页，readonly observer 的可见最终结果仍显示未读。这一版本把布局导致的向上位移也转为阅读窗口，范围过宽。最终改为保留既有 pinned 状态：已主动开始的历史跳转在未移动及向上首帧继续不跟随，明确向下回到底部才恢复；原本跟随中的底部布局位移仍可跟随。没有新增状态或改动已读判据。新组件回归实际点击已加载刻度、模拟平滑首帧与快照刷新，同时验证布局位移和向下返回；原逻辑与过宽逻辑两项消融分别失败，恢复后 23 项通过。原生分页与导航定向重复共 6 项通过，后续完整门禁另记。

其完整复测仍为 98 passed / 1 failed：上述导航与已读通过，普通历史分页补入后恰好被浏览器约束到底部，却未跟随下一段 streamed 内容。最终只对已有精确 Session/entry 的显式定位目标保留不跟随状态；普通分页在底部仍恢复原有跟随。复用现有定位目标，没有增加滚动状态机、改变分页请求或放宽结果已读判据。增加真实组件的预加载消费、prepend、底部约束和新内容跟随回归，专项共 24 项通过；删掉普通分页恢复条件会失败，已恢复。

**最终本地门禁。** `popup-fix-20261001` 的 `check-05`、`unit-05` 和 `final-browser-05` 均通过：Node **2106 passed / 8 skipped**、UI **1119 passed / 79 files**、生产 Google Chrome **99 passed**。门禁前后 933 个 tracked 文件 SHA 一致，构建制品匹配源码；本段结果文字在门禁完成后追加，另做文档合同与 diff 空白检查，Markdown 不在 Biome 格式处理范围。最终分页、阅读锚点、定位和 readonly observer 四项联合重复 **12/12**；简化后的 iframe 输入修正在最终历史修改前以原始扩展重复 **20/20**，这次完整套件同样通过该场景。所有中间失败、trace 和消融仍保留。发布后的真实 Windows 与 Node 矩阵结果通过 [PR #640 的检查](https://github.com/openpi-dev/openpi/pull/640/checks)记录，本地 fault injection 不替代该平台验证；Chromium 内部原因、Safari 和物理移动设备仍是未验证边界。
