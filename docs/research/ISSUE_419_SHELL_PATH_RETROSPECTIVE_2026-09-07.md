# Issue #419：headless Session 的 shellPath 继承复盘

- 状态：在源码与回归测试边界验证
- 创建 / 验证：2026-09-07
- 基线：`c8f2c13`（OpenPI 0.6.0，Pi 0.85.1）
- 修复边界：`1bbd243` 与 PR [#423](https://github.com/openpi-dev/openpi/pull/423)
- Issue：[#419](https://github.com/openpi-dev/openpi/issues/419)
- Supersedes：无

## 已验证事实

Pi 的 `AgentSession` 会从 `SettingsManager.getShellPath()` 构造内置
`bash` 工具。OpenPI 的 `file-mutation-display` 扩展在 `session_start` 中
重新注册 `createBashToolDefinition(ctx.cwd)`，但没有传入 `shellPath`。
这个处理在 TUI 中用于替换展示器，却也在 `print` 模式执行；Direct
Subagent 和 Workflow 子 Session 通过该模式绑定扩展，因此会丢失 Pi 的
shell 设置。Windows 没有 WSL 时，裸 `bash` 可能被系统目录中的 WSL
launcher stub 截获。

在修复前的最小替身中，子 Session 的设置将 `shellPath` 指向不存在的文件，
绑定扩展后调用 `bash` 仍成功执行 `printf`，证明调用的是裸 shell。修复后，
同一调用返回 Pi 的 `Custom shell path not found` 错误，说明配置仍由原生
工具读取。

## 实施与证据

修复让 `file-mutation-display` 只在 `ctx.mode === "tui"` 时修改工具注册和
TUI 展开状态；`print`、RPC、JSON Session 保留 Pi 原生定义。TUI 测试改为
显式使用 `tui` 模式，新增子 Session 测试覆盖扩展启动后的 shellPath 边界。

本地验证结果：

- `npx --yes bun@1.3.14 run test`：1428 通过、1 跳过、0 失败；Vitest 30 通过；
- `npx --yes bun@1.3.14 run lint`：通过；
- `npx --yes bun@1.3.14 run typecheck`：通过；
- 子 Session 与展示扩展定向测试：20 通过；
- 变更文件格式检查与 `git diff --check`：通过。

## 影响与限制

该改动不改变 TUI 的可见展示、模型工具 schema、Session 文件或设置持久化。
Headless Session 重新使用 Pi 的 shell 解析和生命周期。当前环境不是 Windows，
因此没有宣称真实 Windows WSL stub 的手工验收；回归测试使用跨平台的“不存在
shell 路径”证据验证覆盖边界。Windows 原生命令编码和 Git Bash 安装发现仍由
Pi 0.85.1 负责。
