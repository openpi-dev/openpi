# Web 原生能力与交互修复

- Status: validated
- Created: 2026-09-20
- Verified: 2026-09-21（来源核对、完整检查、回归与独立实例 smoke；不代表生产部署）
- Source boundary: OpenPI `1d9607b` 后的 PR #598；Pi SDK 0.85.1；下列冻结的开源参考与当日官方文档
- Issue: [#597](https://github.com/openpi-dev/openpi/issues/597)
- PR: [#598](https://github.com/openpi-dev/openpi/pull/598)
- Supersedes: none；补充前两轮 PR #561 使用测试记录，不改写其结论

## 已核对的参考

| 项目 | 来源与观察 | 本次采用范围 |
| --- | --- | --- |
| Codex | [官方 Review 文档](https://learn.chatgpt.com/docs/code-review?surface=app)区分未暂存、暂存、提交、分支、Last turn，并支持多仓库选择 | 区分 Git 状态和会话编辑证据；不推断闭源应用的基线实现 |
| Maka | [`git-review.ts`](https://github.com/apache/maka/blob/0dc1142aa90000e45627017e846b6d57d1e165e0/packages/core/src/git-review.ts) 提供 branch/unstaged/staged；[browser-host.ts](https://github.com/apache/maka/blob/0dc1142aa90000e45627017e846b6d57d1e165e0/apps/desktop/src/main/browser/browser-host.ts) 使用 Electron WebContentsView | Git 原生比较范围；桌面浏览器组件不能直接搬到纯 Web |
| Claude Code | [Checkpointing](https://code.claude.com/docs/en/checkpointing) 记录原生文件编辑；Bash 编辑和多数子代理编辑不在回退保证内，也不替代 Git | 不把会话记录冒充完整 Git 差异或所有文件的回退能力 |
| agegr/pi-web | [`git-status.ts`](https://github.com/agegr/pi-web/blob/1eb5e66a37c468aca7f0d338edb23de4fd84433e/lib/git-status.ts)、[`file-access.ts`](https://github.com/agegr/pi-web/blob/1eb5e66a37c468aca7f0d338edb23de4fd84433e/lib/file-access.ts)；原生凭据、models.json、技能 API | 列表与逐文件 diff 分离；文件读取权限单独处理；Web 表单连接 Pi 原生配置 |
| jmfederico/pi-web | [`git-backend.ts`](https://github.com/jmfederico/pi-web/blob/60a29acbfc710908e73b0df9857cb63b53b672d3/pi-web-plugins/git/git-backend.ts) 使用 Git porcelain 状态与按路径 diff | 复用 Git 机制，不要求先快照所有未跟踪文件 |
| Chromium DevTools | [ScreencastView.ts](https://github.com/ChromeDevTools/devtools-frontend/blob/main/front_end/panels/screencast/ScreencastView.ts) 考虑像素密度与显示尺寸 | DPR 感知的 CDP screencast；OpenPI 自己维护认证、背压与会话生命周期 |

## 浏览器方案比较与选择

当前基础是本机独立 Chromium + CDP + Web 图像视口，不是嵌入目标 URL 的 iframe。旧实现轮询 JPEG，每次输入还重新读取页面状态；固定 1x 绘制又在高 DPI 面板中放大。用户提供的模糊、卡顿和裁切截图与这些实现问题相符，但截图不能单独证明所有卡顿都来自这一层。

现成系统需要连同宿主考虑：[Browserless LiveURL](https://docs.browserless.io/baas/monitor-sessions/embedding-live-url) 是浏览器后端及交互视图；[noVNC](https://github.com/novnc/noVNC) 需要 VNC/WebSocket 服务；[KasmVNC](https://docs.kasmvnc.com/docs/install/) 面向桌面服务器环境；[Electron WebContentsView](https://www.electronjs.org/docs/latest/api/web-contents-view) 需要桌面壳。它们可作为独立产品方案，但不是无成本嵌入一段前端即可替换。

本次保留现有 Chromium 生命周期，改用 PNG screencast 推送、最多 4MP 的 DPR 视口、单个解码任务与最新待显示帧、滚轮合并及取消清理。页面状态低频刷新；指针输入不重复读取整页状态。没有新增 VNC 服务、云浏览器账户或桌面壳。PNG 仍有编码/带宽成本，这不是通用视频远程桌面性能保证。

## Git、文件证据与读取

只读现场调查发现：用户选中的目录含约 1.25 万个未跟踪文件，首个检查文件约 8 MiB，超过会话基线 4 MiB 配额。旧实现未保存基线，却只显示通用 Git 读取错误。编辑证据还包含其他 worktree 的绝对路径，旧文件预览只允许当前工作区。

修复默认读取 Git 未暂存状态，提供暂存与分支比较，先返回有界列表，再加载选中文件 diff。会话基线是独立选项；缺失时明确说明不能恢复，并指向可用的 Git 范围或会话记录，不提高配额掩盖问题。会话文件列表显示原生工具返回的编辑 diff；Bash 等未提供对应证据的操作不被伪造为完整编辑记录。

工作区外的文件必须由用户显式点击只读打开。授权绑定当前 Session、单个文件及文件身份，不扩大到父目录或相邻链接；刷新保留该显式选择，Session 变化仍会撤销。百分号路径只解码一次。所有这些是浏览器文件访问边界，不限制模型原本被授予的原生工具权限。

## 设置与 setup 的关系

此前的 `1d9607b` 已修复设置/思考菜单在尚无 Session 时被禁用的问题：按需准备真实 Pi Session，不发送虚构 Prompt；草稿通过精确创建回执交接。设置与思考两种先后顺序分别有浏览器回归。

会话初始化还发现 headless `session_start` 为未使用的 fd 搜索工具提前查找/下载二进制。它可能等待约 30 秒，而 Web 请求窗口为 15 秒。改为工具被调用时加载，TUI 保留原行为。独立 agent 的冷启动样本从约 4.2 秒降到约 0.39 秒，旁路启动回执约 0.03 秒；这些不是模型回答延迟，也不能证明用户截图中每次超时只有这一种原因。消融移除 headless guard 后，阻塞查找的专项回归失败，恢复后通过。

设置页不应只有“由 Pi 管理”的说明。模型表单写入同一份原生 models.json，保留未编辑的字段与服务商，使用修订校验避免覆盖已观察到的外部修改。API Key 通过 ModelRuntime.login 保存，GET 只返回无密钥字段，失败消息也不透传服务商异常中的凭据。写入要求当前 Session 空闲。支持 Responses、Chat Completions、Anthropic Messages 的自定义模型表单；OAuth 和多字段认证仍保留 Pi 原生登录，未伪装成已经支持 Web OAuth。

OpenPI 自有设置仍通过 `/openpi-setup` 的原有 episode 与 typed writer；技能/插件需求及角色模型/并发表单提交到该入口，不增设 package 配置写入接口。表单区分请求被接受、执行中和实际保存的会话回执；需要原生确认的安装仍沿用确认流程。密钥不进入这条模型对话路径。更改运行中扩展的加载仍由原生生命周期负责，不自动热加载任意插件。

## 验证与限制

- 独立 agent 目录的 `pi list` 唯一 OpenPI 来源为开发 worktree，HEAD `1d9607b` + 本 PR 变更；用户常驻 57161 实例未更新、未重启。
- 浏览器专项使用本机 Chrome 与临时 HTTP 页面：720×900 CSS 视口获得 1440×1800 PNG；800×1100 获得 1600×2200 PNG；高 DPI 输入坐标成功写入字段。没有用静态 mock 声称端到端性能已达标。
- 原生 Pi 集成测试验证模型保存后重新加载、凭据持久化、读接口脱敏和忙碌/过期 Session 拒绝；HTTP 测试验证未认证写入拒绝与异常脱敏；组件测试分开验证表单和 setup 提交语义。
- Git 测试覆盖大未跟踪文件、摘要/详情分离和比较范围；文件测试覆盖单文件授权、Session/路径边界、百分号路径与刷新。
- 完整 `bun run check` 通过；`bun run test`：Node 1711 通过、1 项 Windows 专属测试跳过，Vitest 317 通过；Playwright 54/54 通过，包括跨工作区文件显式授权后预览/刷新、桌面与移动端、无障碍和旧服务商状态兼容性。
- 独立 57361 实例手工验证模型表单保存并更新列表、测试密钥保存后清空输入、子代理表单仍走 setup。只使用临时配置和不可用的测试服务商端点，没有向模型发起请求；测试页与服务已关闭。
- 私有原始证据归档：本机 `openpi-pr561-usage-20260920`，包含浏览器 smoke、临时 agent 配置与测试日志，不提交凭据或用户 Session。这些是工程 smoke/回归证据，不是具有冻结模型任务与用量统计的正式 Benchmark。

消融目标：保留原生 Git、Pi 配置与 CDP seam，避免另外增加快照框架、配置控制平面或屏幕共享服务。移除等待显示帧队列，仅保留最新帧；移除全仓文件内容预读，仅在选中后读取。相关回归验证仍覆盖输入、显示和文件访问行为。

2026-09-21 的消融移除了配置写入中重复的 runtime 通知，只保留 Host 保存回执后的通知，相关回归仍通过，因此保留简化。另一次临时移除当前 Session 的模型重新绑定后，原生模型测试明确失败：会话仍使用旧端点；恢复这一步后通过，因此保留。写入期间复用现有 Prompt admission 队列，避免新增一套锁或配置状态机。
