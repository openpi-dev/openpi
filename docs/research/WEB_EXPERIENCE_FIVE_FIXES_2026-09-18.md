# Web 深度体验：第一批 5 个交互修复

- 状态：validated（限下述组件、正式静态页面与本地真实模型体验；不是性能 Benchmark）。
- 创建 / 验证日期：2026-09-18。
- 源码边界：上游 main `f6b49ae59605b1276b8267f2886d22c03f01533c`，修复分支 `codex/web-experience-five-fixes`。
- 跟踪：[Issue #559](https://github.com/openpi-dev/openpi/issues/559)；[PR #561](https://github.com/openpi-dev/openpi/pull/561)。
- Supersedes：none。

## 运行来源与体验范围

fork 的 `origin/main` 为 `8a39b1d`，尚无 Web；本次独立 worktree 从该提交快进到最新 `upstream/main`，没有复制或改写主工作目录中的未提交修改。

按 README 的开发运行时证据链，先确认 HEAD 和 `pi list`。本次使用独立 `PI_CODING_AGENT_DIR`，其中 `pi list` 唯一 OpenPI 来源为这个 worktree 的绝对路径；使用 Node 24、Bun 1.3.14 和 frozen lockfile。默认 PATH 中的 Node 20 无法加载当前 Pi，此环境问题不计入产品的 5 个 bug。

真实体验通过 `node bin/openpi.js web <worktree> --port 57218 --no-open` 提供的正式 `web/dist/` 页面完成。隔离设置复用用户已配置的本地 provider endpoint / 认证，选择 `codex-local/gpt-5.6-luna`、`medium`；原配置未列出 Luna，所以仅在隔离模型配置中按现有同系列模型增加其 ID。后续按用户要求在隔离配置中更换凭据并重启，真实模型回复成功。原用户 settings、模型文件和既有 Session 没有改写。初期未启动子 agent；后续用户把授权上限从 2 提高到 6，新增两子代理只读体验。源码普通子代理池硬上限仍为 4，另有 2 个用户旁路槽；本批未修改资源上限。

已体验：中文多轮对话、真实 `read` 工具调用、流式回复、代码块与表格、长列表、新建与切回会话、执行轨迹切换、模型菜单、刷新恢复、编辑取消和真实轮次 Stop。Stop 后运行态结束、发送控件恢复；本次私有 Session 的 assistant 终态依次为 `toolUse`、`stop`、`stop`、`aborted`，model 均为 `gpt-5.6-luna`。不能据此推断所有 provider 的取消行为。

## 五个问题与修复

| ID | 复现步骤与修复前事实 | 修复与验收边界 |
| --- | --- | --- |
| WEB-01 | 编辑最后一条用户消息，改字后取消，再打开编辑；出现被取消的草稿。真实页面复现。 | 每次打开编辑器从消息原文初始化；取消后恢复原文，提交失败则保留本次草稿供重试。组件与真实页面验证。 |
| WEB-02 | 用户消息行使用横向 flex，消息气泡、时间/操作和编辑器争夺横向空间；编辑时原气泡仍显示，编辑器变窄。真实截图复现。 | 用户消息行改为纵向右对齐；编辑时隐藏原气泡，编辑器使用可用宽度。增加可见键盘焦点及禁用状态。正式构建 1280px / 390px 布局用例验证编辑宽度、无右侧溢出与原气泡隐藏。 |
| WEB-03 | 输入 14 行草稿后新建会话，再切回原会话；草稿清空，textarea 仍为 220px。真实 DOM 测得 `value=''`、`height=220px`。 | prompt 状态变化统一触发 layout effect 尺寸计算，覆盖输入、程序清空和恢复。组件测试从 220px 回到模拟单行 52px；实际页面回到单行最小高度。 |
| WEB-04 | 将对话滚到底部，再输入多行草稿。对话视口从 516px 缩至 348px，scrollTop 仍为 82px、scrollHeight 为 598px，底部落后 168px。 | ResizeObserver 跟踪对话视口尺寸，仅在原本贴底时保持贴底；用户阅读历史时不移动位置。组件验证 observer 清理；正式浏览器在输入框增长/缩小时验证底部误差小于 2px，历史阅读位置保持 120px。 |
| WEB-05 | 消息编辑的 admission 尚未返回时，输入和确认仍可操作；旧 `onResend` 成功后直接关闭编辑器，之后输入的新文字没有提交机会。异步边界由延迟 Promise 组件测试固定，非真实网络重复执行结论。 | 提交期间编辑器只读，确认/取消禁用，并防止重复提交；空白编辑不提交，拒绝后恢复可编辑状态、保留草稿。沿用原有 WebStore admission 和 Pi 执行事实，不新增后端队列。 |

## 设计边界与消融

这些改动属于 React 展示和输入控件生命周期。Pi Session、model / thinking、权限、取消身份与 admission 事实仍由现有层拥有。没有新增模型工具、用户配置项、存储层、任务编排或固定推理流程；更强模型可继续直接使用原有 Pi 能力。

尝试移除新增编辑提交逻辑中的独立 pending ref，保留 React submitting 状态及控件锁定，48 个组件用例仍通过，因此删除该重复状态。输入框原来分布在 onChange、普通发送成功、恢复收据中的尺寸操作也全部删除，只保留由 prompt 驱动的一处更新；专项和浏览器回归通过。没有为此次修复建立通用编辑框或滚动管理框架。

## 验证记录

- 修复前：新增的 4 个组件用例全部失败，既有 44 个通过；布局问题另有真实页面观察。
- 修复后组件：`vitest run tests/web/app-render.spec.ts`，48 / 48 通过。
- `bun run check`：通过（配置 / 文档 / discipline / Web 类型与构建 / 格式 / lint / 仓库类型）。
- `bun run test`：Node 测试 1658 通过、1 个已有 skip、0 失败；Vitest 224 / 224 通过。
- 正式浏览器：最终完整运行 36 / 36 通过；新增桌面 / 手机用例还各重复 3 次，共 6 / 6 通过。`test:web:e2e:provider` 1 / 1 通过（独立 fake provider，验证 thinking 请求链路，不能代替真实模型验证）。
- 验证过程中修正了两处原有测试同步：移动菜单在 requestAnimationFrame 中接收焦点，测试须等到 focused 后再按 Escape；取消用例须等待 in-flight route handler 完成再销毁 request context。修正前分别发生侧栏误关闭和 `Response has been disposed`。新增阅读位置测试也改用显式 instant 滚动，避免把 CSS 平滑动画途中误当成稳定阅读位置；这些是测试生命周期修正，不计入五个产品 bug。
- 正式静态产物由 `build:web` 生成，不手工修改 `web/dist/`。

本地证据身份为 `openpi-web-experience-20260918`，日志保存在运行机器的 `~/.cache/openpi-web-experience-20260918/`（`baseline-tests.log`、`ablation.log`、`check-final.log`、`test-final.log`、`e2e-verified.log`、`layout-repeat.log`、`provider-final.log`；早期失败日志也保留）。隔离 Session、认证和模型配置属于私有原始证据，不进入 Git / Issue。此路径是本地复核入口，不宣称第三方可以取得私有日志；公共可复现证据是本次回归测试与源码。

## 开源参考与后续方向

阅读了 [jmfederico/pi-web](https://github.com/jmfederico/pi-web) 和 [kkkiio/pi-web-ui](https://github.com/kkkiio/pi-web-ui) 的项目说明。前者明确强调离开浏览器后继续工作的会话与跨设备监督，后者强调浏览器对 Pi Session 的呈现和控制。这些是参考项目自身的能力描述，不是本项目已经实现同等可靠性的证据。

本次采用的建议是优先打磨已有会话的输入、编辑、阅读位置与准确执行反馈；不照搬另一个 daemon 或 provider 栈。尚未进行长时间掉线恢复、Safari 真机输入法或实际手机软键盘测试，也没有测量帧率、首 token 延迟或与 Claude/Codex 的量化差距。本批 5 个修复完成不代表整体体验已经达到这些产品。
