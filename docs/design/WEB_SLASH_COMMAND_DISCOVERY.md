# Web 斜杠命令发现设计

- Status: `draft`
- Created: 2026-09-09
- Verified: 2026-09-10
- Source boundary: `5bf2fe29e52801d79826c2eb573be403f53285e5`
- Related Issue: [#489](https://github.com/openpi-dev/openpi/issues/489)
- Related Issue: [#470](https://github.com/openpi-dev/openpi/issues/470)
- Related Decision: [0001 - documentation and evidence governance](../decisions/0001-documentation-and-evidence-governance.md)
- Supersedes: none

## Problem

Web Composer 没有 Pi 原生斜杠命令的发现入口。浏览器既不能展示当前 Session 中动态注册的 Extension Command、Prompt Template 和 Skill，也无法说明命令来源及其在 Web Runtime 中的支持状态。浏览器不能通过硬编码命令表或扫描本机资源来弥补这个缺口，否则会复制 Pi 的命令注册逻辑并泄露内部路径。

本设计只解决命令发现、选择和支持状态展示。命令执行仍由 Pi 的 `AgentSession.prompt()` 负责；Plan Ready 后的命令回执和交互交接由 #470 负责。

## Pi ownership

Pi 是命令注册与展开语义的唯一事实来源。Web Runtime 注入一个隐藏、只读的扩展桥，并在当前 Session 完成扩展绑定后通过 `pi.getCommands()` 获取命令。该接口已经合并 Extension Command、Prompt Template 和 Skill，并处理扩展命令的实际调用名称。

不采用以下方案：

- 不分别读取 `extensionRunner`、`promptTemplates` 和 `resourceLoader` 后自行合并；这会复制 Pi 的 `get_commands` 实现。
- 不把 Web Runtime 改为 RPC 模式；RPC 会改变 `ctx.hasUI` 和命令生命周期，Web 不等同于 RPC。
- 不扫描磁盘、不引入第三方 command palette，也不新增 OpenPI 自己的 `/commands` 或 `/palette`。
- 不投影 Pi 的 TUI 内建命令。`pi.getCommands()` 不包含 `/model`、`/settings` 等内建交互命令，本设计不建立第二张内建命令表。

桥接引用必须跟随 Runtime 和 Session 替换更新。工作区切换、Session 切换或资源重载后，只读取当前已绑定 Session 的命令；旧 Session 的结果不得跨越新的 Session 身份继续展示。

## Protocol and bounds

Host 新增经过现有 Bearer token 验证的 `GET /api/commands`。请求必须携带预期的活动 Session id；无活动 Web Session 时拒绝请求，Session 已切换时返回稳定的 `409 SESSION_CHANGED`。

响应只包含浏览器需要的有界投影：

```ts
interface WebCommandSummary {
  name: string;
  description?: string;
  source: "extension" | "prompt" | "skill";
  availability: "available" | "unsupported";
  argumentHint?: string;
}
```

响应不包含 `sourceInfo.path`、`sourceInfo.source`、工作区路径或其他本机资源身份。名称和描述需移除控制字符并分别限制长度。投影同时受最大命令数量和 JSON 字节数限制，并返回准确的省略证据；Runtime 对读取和投影设置扫描上限，不能因恶意或异常扩展注册无限工作。

当前支持状态采用保守规则：

- Prompt Template 和 Skill 为 `available`。选择后仍通过 Pi 的 prompt template / skill 原生展开语义执行。
- Extension Command 为 `unsupported`。Pi 当前没有公开 Web/headless 能力元数据；不能根据命令名称或 handler 实现猜测可用性。
- Prompt Template 和 Skill 可显示通用参数提示“可在命令后输入参数”。不虚构具体参数格式，也不访问扩展内部的 `getArgumentCompletions`。

未来 Pi 若公开正式的命令能力或参数元数据，Web 可以直接投影该事实并替换保守规则，而无需改变菜单协议形态。

## Composer interaction

命令面板紧贴 Composer 输入框，仅在满足以下条件时打开：输入内容以 `/` 开头、光标仍在首行命令名阶段、命令名后尚未出现空格。多行文本和已进入参数阶段的输入不触发菜单。

首次打开时按当前活动 Session 请求一次命令投影，随后输入字符只在浏览器本地按名称、描述和来源过滤，不为每次按键发送请求。面板提供明确的加载、空结果和错误状态。

键盘与指针行为：

- `ArrowUp` / `ArrowDown` 移动活动项；
- `Enter` / `Tab` 将可用项补全为 `/name `，保留输入焦点，不立即提交；
- `Escape` 关闭面板且不修改输入；
- 鼠标或触摸点击可用项执行相同的补全；
- Extension Command 仍显示在结果中，但采用灰色样式并标记“当前 Web 不支持”。它使用 `aria-disabled="true"`，点击或确认不会修改输入，也不会提交命令。

可用的 Prompt Template 和 Skill 保持 Pi 投影中的相对顺序并排在前面，不可用的 Extension Command 保持相对顺序统一排在末尾。新会话 landing 状态下，面板采用约四行的紧凑高度并默认在 Composer 下方展开；下方可视空间不足时翻转到上方，并按所选方向的实际空间限制高度，始终与 Composer 保持间距。已有历史会话仍保留底部 Composer 上方的标准面板高度。键盘活动项变化时只把该项滚动到面板内最近的可见边缘，不滚动无关页面区域。

工作区仍是 draft、尚未创建真实 Web Session 时不请求命令，也不为了只读发现创建 Session。界面显示需要先创建会话的状态。工作区或 Session 改变时取消请求并清除旧投影；任何带旧请求世代或旧 Session id 的响应都会被丢弃。

## Error and lifecycle behavior

- 未授权请求沿用 Host 的 `401` 行为。
- 请求方法、查询参数和 Session id 非法时返回客户端错误，不调用 Runtime。
- Runtime 不可用、响应超出边界或来源数据异常时失败关闭，不回退到硬编码命令。
- 浏览器将网络错误与空命令列表分开显示，并允许关闭后重新打开菜单重试。
- 命令发现不改变 Session、模型、工具、配置或持久化数据。
- 本设计不改变用户手工输入 Extension Command 的现有行为，也不把 HTTP admission 或 Pi `handled` 解释为命令执行成功。

## Validation

Runtime 测试覆盖 Pi 桥读取的三种来源、调用名称、支持状态、控制字符清洗、路径剔除、数量与字节裁剪，以及 Session 替换后的投影更新。

Host 和协议测试覆盖鉴权、方法限制、活动 Session 绑定、过期 Session 的 `409`、无 Session、响应裁剪与无本机路径泄露。

Store 和组件测试覆盖加载、错误、空状态、本地过滤、键盘导航、不可用项、补全但不提交、移动端点击、工作区及 Session 变化后的取消和过期结果隔离。

生产 Web Host 的 Playwright 场景验证输入 `/` 后能够发现并补全 Prompt Template 或 Skill，Extension Command 可见但置灰，补全不会立即发出 prompt，并且响应和页面不暴露 fixture 中的本机路径。

实现完成后串行运行 `bun run check`、`bun run test` 和 `bun run test:web:e2e`。手工 smoke 必须先记录 checkout revision，并确认 `pi list` 只有当前 checkout 这一条 OpenPI 来源；切换分支后重启 Pi 或执行 `/reload` 再验证。

### Local implementation evidence

2026-09-10 在 `codex/web-slash-command-discovery` 工作树、相对 Source boundary 所列基线完成自动验证：

- `bun run check`：配置契约、纪律账本、生产 Web 构建、格式、lint 和 TypeScript 检查通过；
- `bun run test`：Node 1529 passed、0 failed、1 个 Windows 专属测试 skipped；Vitest 143 passed、0 failed；
- `bun run test:web:e2e`：生产 Web Host 下 12 passed、0 failed，包含命令发现、Session 参数、Extension 置灰、Prompt/Skill 补全、不触发 `/api/prompt`、键盘滚动跟随以及 landing 面板碰撞翻转；
- `git diff --check`：通过。

这些结果验证的是当前本地工作树，不表示 Issue 已关闭、PR 已合并或本设计已成为独立的项目 Decision。真实 Pi/Web smoke 仍由贡献者按下述流程验收。

## Out of scope

- `/model`、`/settings`、`/fork`、`/compact`、`/openpi-setup` 等命令的专用 Web 交互；
- Extension Command 的 Web 执行与完成回执；
- 参数自动补全或扩展私有 completion handler；
- 新的配置入口、命令面板设置中心或浏览器侧命令解析器；
- TUI 与 Web Session 的合并或共享控制权。
