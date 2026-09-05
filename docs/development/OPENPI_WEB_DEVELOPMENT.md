# OpenPI Web 开发规范

本文描述当前独立 Web 工作台的开发入口、验证层级和热更新边界。它不改变 Web 的产品行为，也不把 Web 改造成终端 Pi Session extension。

## 结构边界

```text
浏览器
  └─ React + Zustand 浏览器投影
       └─ Vite dev server（仅 UI HMR）
            └─ 代理 /api、/events
            └─ WebHost（HTTP、SSE、鉴权、协议游标）
                 └─ PiWebAdapter
                      └─ PiWebRuntime（Session、Provider、模型、工具）
```

- `web/ui/` 只负责 React 浏览器状态、渲染和交互，不读取 Session 文件或本地文件系统。
- `web/dist/` 是正式 `openpi web` 由 WebHost 白名单提供的自包含构建产物；不依赖 Vite、CDN 或远程字体。该目录属于可发布源码并纳入 Git，保证 npm 与 GitHub 安装都不需要开发依赖即可启动 Web。
- `web/protocol/` 定义浏览器与 Host 之间的投影类型和协议版本。
- `web/runtime/` 与 `web/adapter/` 共同构成 Pi 到 Web 投影的边界；Host 只负责协议排序、连接和命令分派。
- `web/host/` 负责 loopback HTTP、SSE、token、请求边界和静态资源白名单。
- `web/runtime/` 独占 Web 进程的 Pi Session 生命周期。
- `bin/openpi.js` 是正式运行入口；`scripts/dev-web.mjs` 只用于本地开发编排。

不要在 UI 中解析 JSONL，不要在 Host 中复制 Provider/Session 存储，也不要把展示文案当作运行时完成事实。

## 日常开发

先确认当前 checkout 和 Pi 加载来源：

```bash
git status --short --branch
git rev-parse --short HEAD
pi list
```

然后安装锁定依赖并启动开发环境：

```bash
bun install --frozen-lockfile
bun run dev:web
```

可选地指定初始工作区：

```bash
bun run dev:web -- /absolute/path/to/workspace
```

脚本会启动一个真实的 `PiWebRuntime`/`WebHost` 和一个 Vite UI 服务，自动打开带 token 的浏览器地址。开发 Host 仍然只监听 `127.0.0.1`，Vite 代理不会改变鉴权或 SSE 协议。

组合入口把 `5173`（UI）和 `57107`（后端）视为默认首选端口。未设置对应环境变量时，如果首选端口被其他程序占用，脚本会在最多 100 个连续端口中选择第一个可用值，明确打印避让结果，并把实际端口统一用于 Vite、代理、allowed origin、健康检查和浏览器 URL。设置 `OPENPI_WEB_UI_PORT` 或 `OPENPI_WEB_BACKEND_PORT` 表示要求精确端口；该端口被占用时会立即失败并提示替代命令，不会静默避让：

```bash
OPENPI_WEB_UI_PORT=5174 OPENPI_WEB_BACKEND_PORT=57108 \
  bun run dev:web -- /absolute/path/to/workspace
```

端口避让不绕过 WebHost 所有权。已有 `/web`、`openpi web`、`dev:web` 或 `dev:web:backend` 持有 Web Session 目录时，新的开发入口会保留原始租约错误并立即退出，不再等待健康检查超时。先正常停止已有 Host；不要为了双开而删除租约或只换端口。TUI `/web` 失败后也会在恢复的界面中投影有界、已清洗的子进程错误，而不只显示退出码。

正式 CLI 与开发后端共享同一个 Web Host owner lease。同一 `PI_CODING_AGENT_DIR` 下已有 Host 时，第二个进程会拒绝启动；先正常停止现有 Host，不要手工删除仍由匹配 PID 和进程启动身份持有的租约文件。

异常进程恢复会在 Web Session 目录的 `.openpi-web-host.artifacts/` 中保留安全围栏。只有确认没有存活或暂停的 Web Host 仍依赖这些记录后，才可人工删除其中过期的 `candidate-*`、`released-*` 或 `stale-*` 目录。OpenPI 不会自动删除围栏；达到 128 个租约产物或 64 个 stale 围栏时会 fail closed，并在错误信息中给出该目录。普通 Session 文件不占用这个预算。

`dev:web` 和 `dev:web:backend` 默认会在启动它们的终端输出 Web 诊断日志；设置 `OPENPI_WEB_DEBUG=0` 可关闭。正式运行 `openpi web` 默认关闭日志，排查时设置 `OPENPI_WEB_DEBUG=1`。

## 对话无响应排查

需要分析 Web 对话在哪个阶段变慢时，启动后端前设置：

```bash
OPENPI_WEB_DEBUG=1 bun run dev:web:backend -- /absolute/path/to/workspace
```

日志写到 stderr，每行一条 JSON，使用 `commandId` 和 `sessionId` 关联同一次请求。重点事件包括：

- `prompt_received`：Web 收到请求；
- `prompt_preflight_started`：开始执行 OpenPI prompt 预处理；
- `prompt_preflight_accepted` / `prompt_preflight_rejected`：OpenPI extensions、模板、鉴权等预处理完成；
- `provider_config`：记录 provider、模型、API、脱敏后的 endpoint、HTTP idle timeout、重试配置和代理是否启用；
- `agent_event`：Pi 原生 `agent_start`、消息流、工具调用和 `agent_settled`；
- `prompt_dispatch_failed`：扩展或模型调用失败。

日志只记录字符数、阶段、耗时和不含密钥的连接配置，不记录 prompt、API key 或模型正文。`OPENPI_WEB_LOG=1` 是同义开关。

## 热更新边界

| 改动 | 是否需要手动重启 | 说明 |
| --- | --- | --- |
| `web/ui/index.html`、`web/ui/src/` | 否 | React 与 Tailwind 变更通过 Vite HMR 或页面自动刷新；保持当前后端 Session。 |
| `web/vite.config.mjs` | 是 | Vite 配置变更需要重启 `dev:web`。 |
| `web/host/`、`web/adapter/`、`web/protocol/`、`web/runtime/`、`bin/openpi.js` | 自动重启 | 使用 `bun run dev:web:backend` 时由 Node watch 重启进程；Pi Runtime 会重建，正在运行的回合会终止。 |
| 依赖、`package.json`、锁文件 | 是 | 重新执行 `bun install --frozen-lockfile`，再重启开发环境。 |

后端当前没有安全的无状态模块热替换：Session、Provider、工具和扩展监听器属于进程生命周期。任何声称后端“无需重启”的方案都可能留下旧运行时或重复监听器，因此开发脚本明确采用自动重启并在文案中提示其边界。

如果只调整 UI，可以让 `dev:web` 持续运行；如果只调后端，可在另一个终端运行：

```bash
bun run dev:web:backend
```

该命令固定监听 `57107`（可用 `OPENPI_WEB_BACKEND_PORT` 覆盖），并在 TypeScript 变更后自动重启。`dev:web:ui` 适合已有后端时单独启动 UI。需要设置后端地址，默认是 `http://127.0.0.1:57107`：

```bash
OPENPI_WEB_BACKEND=http://127.0.0.1:57107 bun run dev:web:ui
```

## 验证流程

按改动风险逐层验证：

```bash
# UI/开发脚本快速检查
bun run check:web

# 只生成正式 WebHost 使用的静态资源
bun run build:web

# 正式 WebHost 的桌面、触屏、键盘与 axe 浏览器验收
bunx playwright install chromium
bun run test:web:e2e

# 仓库门禁
bun run check
bun run test
```

修改 `web/ui/` 或 Web 构建配置后，需要同时提交重新生成的 `web/dist/`。CI 会重新构建并检查该目录；如果源码和提交的产物不一致，门禁会失败。不要手工编辑 `web/dist/`。

CI 在 Node `22.19.0` 上运行一次 Chromium E2E，覆盖项目声明的最低 Node 版本；普通 `check` 和 `test` 继续同时覆盖 Node `22.19.0` 与 Node `24`。

涉及 Web Host/API/SSE 时，还要运行 Web 专项测试：

```bash
node --test --experimental-strip-types tests/web/*.test.ts
```

涉及运行时或 UI 的改动，必须在已启动的真实 Web 环境中手工验证目标路径：工作区切换、活动会话对话、非活动会话的 prompt 禁用、归档/重命名、模型选择、Markdown、流式运行状态和刷新恢复。记录 checkout HEAD、`pi list` 唯一 OpenPI 来源、专项测试、完整门禁和未执行的层级。

## 提交前检查

复查 `git diff --check` 和 `git status --short`，确认快照、Session、日志、凭据和本地模型配置没有进入提交。正式验收使用 `openpi web [workspace]` 的 Host 静态资源服务，不以 Vite 页面代替生产路径验证。
