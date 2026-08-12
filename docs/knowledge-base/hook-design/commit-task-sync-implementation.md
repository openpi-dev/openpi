# commit-task-sync extension 实现

> openpi tasks 残留根治尝试。2026-08-11。

## 问题
openpi tasks（session 级跟踪）无自动同步——commit/reviewer/授权后 tasks_update 靠 agent 手动记忆 → 遗忘必然（4 次复发：批次一 T3 + 批次二 T1/T4/T6）。

## 方案
仿 post-edit extension（`pi.on("tool_result")` + `pi.on("agent_settled")`），检测 bash `git commit` 成功 → `agent_settled` 时 `ctx.ui.notify` 提示 agent 同步 tasks。

## 实现
- 文件：`extensions/commit-task-sync/index.ts`（3957B）
- 核心：
  - `pi.on("tool_result")`：检测 `event.toolName === "bash"` + `!event.isError` + command 含 `git commit` → 翻标志 `committedThisTurn`（hot path，不阻塞 pipeline）
  - `pi.on("agent_settled")`：标志为 true → `ctx.ui.notify("⚠️ git commit 检测到 — 请检查 tasks 状态同步")`（fire-and-forget，TUI only）
  - `pi.on("session_start/shutdown")`：重置标志
- 设计原则：
  - **不自动改 tasks**（agent 决策哪个 task 对应哪个 commit）
  - **不阻塞 pipeline**（tool_result 只翻标志，agent_settled fire-and-forget）
  - **最小信任面**（检测 `git commit` 字符串 + exit 0，不执行命令）
  - **TUI only**（仿 post-edit，headless RPC 不触发）

## 验证
- tsc：`npx tsc -p tsconfig.json --noEmit` → exit 0（类型通过，含 commit-task-sync）
- 注册：自动（tsconfig `include: ["extensions/**/*.ts"]` + package.json `extensions: ["./extensions"]`）

## 测试计划（下一步）
1. **pi install local**：`pi install /home/umax/work/openpi-dev`（加载 commit-task-sync extension）
2. **模拟 commit**：在 pi session 中执行 `git commit`（bash 工具）→ 验证 `agent_settled` 时 `ui.notify` 触发「⚠️ git commit 检测到」
3. **单元测试**（可选）：`extensions/commit-task-sync/index.test.ts`，仿 `post-edit/index.test.ts`（mock pi.on + 模拟 tool_result event + 验证 notify 调用）

## 局限 + 未来增强
- **ui.notify 是建议性**（agent 可能忽略）：更强版本用 context injection（injectTaskProjection 或 system prompt 注入「⚠️ commit 检测到，有 in_progress tasks 未同步」）
- **command 提取**（extractCommand）：尝试 event.input/params 多字段（pi event 结构版本差异），可能需适配
- **不检测 push**（只 commit）：push 是远端操作（无 tool_result 钩子，或 bash push 检测）
- **不区分仓**（任何 git commit 触发）：可配置只检测特定仓（cwd 匹配）

## openpi hook 机制发现（本次调查）
- openpi **有 `pi.on("tool_result")` 事件**（PostToolUse 等价）——之前 rg `PostToolUse` 没命中是因为事件名是 `tool_result`
- pi.on 可用事件：`tool_result` / `agent_settled` / `session_start/shutdown` / `model_select` / `agent_start` / `message_start/update/end` / `turn_end` / `session_compact` / `session_tree`
- post-edit extension 是最佳 hook 范本（tool_result 翻标志 + agent_settled 执行 + fire-and-forget）
