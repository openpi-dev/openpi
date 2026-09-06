---
status: validated
created: 2026-09-07
last-verified: 2026-09-07
applies-to: OpenPI at a7455cd378ef7befa9c7cf099c1fa1e4ee5dc3e3 with Pi 0.85.1
source-boundary: OpenPI source, deterministic tests, and the installed Pi 0.85.1 package
related-issues: "#425, #424"
related-prs: "待创建"
supersedes: none
---

# Issue 425：Workflow 子会话进度 watchdog

## 问题与范围

Workflow 子会话用额外的进度 watchdog 保护 provider turn。修复前，
`extensions/workflows/runner.ts` 直接读取项目和全局设置对象里的原始
`httpIdleTimeoutMs` 字段。用户没有显式配置时，这两个可选字段都为空，
OpenPI 便使用 45 秒默认值；Pi 实际传输层仍使用自己的有效默认值 300 秒。
慢但健康的 provider turn 因此可能在 Pi 传输层超时之前被 OpenPI 错误中止。

本记录只覆盖超时来源和边界，不覆盖 #424 中的 Cursor 工具协议、跨目录权限、
allowlist 或真实 provider 接受测试。

## 已核验事实

- 当前依赖声明和安装包为 `@earendil-works/pi-coding-agent` `0.85.1`。
- Pi `dist/core/http-dispatcher.js` 定义 `DEFAULT_HTTP_IDLE_TIMEOUT_MS = 300_000`。
- Pi `SettingsManager.getHttpIdleTimeoutMs()` 读取合并后的有效设置；原始字段缺失
  时回退到上述默认值。因此直接读取 `getProjectSettings()` 和
  `getGlobalSettings()` 不能代表 Pi 的有效超时。
- OpenPI 仍需要一个有界的模型可见进度保护。修复保留 45 秒最低值：有效 Pi
  设置低于该值时（包括显式 `0`，表示关闭 Pi 传输空闲超时）仍使用 45 秒。
- 测试覆盖的 `override` 继续直接返回调用方提供的值，以保留确定性测试和既有
  `runHarnessAgent` 行为。

## 实施与取舍

`resolveModelProgressTimeoutMs()` 现在调用 Pi 原生
`SettingsManager.getHttpIdleTimeoutMs()`，再取不小于 `MODEL_PROGRESS_TIMEOUT_MS`
的整数值。这样未配置时跟随 Pi 的 300 秒有效默认值；显式较宽值继续生效；
低值和 `0` 仍不会移除 OpenPI 子会话的有界保护。watchdog 的 abort、progress
续期、completion 和 cleanup 路径没有改变。

## 验证

- `npx --yes bun@1.3.14 run test`：Node 测试 `1430 passed, 1 skipped, 0 failed`；
  Vitest `30 passed`。
- `npx --yes bun@1.3.14 run typecheck`：通过。
- 变更文件的 Biome lint/format 检查与 `git diff --check`：通过。
- 定向 Workflow 测试覆盖有效默认值 `300000`、显式宽值、测试 override、45 秒
  floor 和显式 `0`。
- 完整 `bun run check` 的唯一失败来自既有未跟踪 `.golutra/local.json` 和
  `.golutra/workspace.json` 与格式化器的差异；这些协作证据未被改写。其余源码
  lint、typecheck 和定向格式检查通过。

## 证据边界与未知项

本记录验证了 Pi accessor 的源码契约和 OpenPI 的确定性回归边界，没有调用真实
provider，也没有声称测量慢 provider 的端到端成功率。Pi 或 OpenPI 后续改变
超时语义时，需要重新核对 accessor、最低边界和相关测试。该切片不能单独关闭
#424 的综合可靠性目标。

## 追踪链接

- Issue：[#425](https://github.com/openpi-dev/openpi/issues/425)
- 上游综合 Issue：[#424](https://github.com/openpi-dev/openpi/issues/424)
- PR：待创建，创建后回填此处并在 Issue 留言互链。
