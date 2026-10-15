# Workflow fullscreen 图片遮挡的 Pi owner 候选修复

- Status: draft proposal; installed source and isolated native-renderer protocol behavior verified; terminal pixels unverified
- Created: 2026-10-04
- Last verified: 2026-10-04
- Applies to: OpenPI `origin/main` `1d36e00d`; locked SDK Pi TUI `0.99.1`; installed Pi coding-agent / TUI `1.0.2`
- Issue: [#657](https://github.com/openpi-dev/openpi/issues/657)
- Related record: [Workflow TUI projections](WORKFLOW_TUI_PROJECTIONS_2026-10-04.md)
- Supersedes: none; this extends the earlier unresolved fullscreen boundary without changing its pixel-acceptance status

## 已证实的边界

本轮遵循 README 的 runtime provenance 流程。`pi list` 仅报告一个 OpenPI 来源 `~/work/openpi-main-runtime`，该 checkout HEAD 为 `d36b58b67f87d24b4926521b965bdccfff7719e4`。这与候选 worktree 不同；未安装、reload 或修改正在运行的 Session。安装宿主 package 为 Pi coding-agent / TUI `1.0.2`；源码调查针对磁盘 package，不证明当前内存实例已加载同一字节。

安装宿主与锁定 SDK 的公开 `compositeTuiLine` 都在 image base line 上直接返回原行。因此纯文字 fullscreen overlay 仍保留图片 anchor。安装 `TuiAltScreen.doRender` 已拥有 Kitty placement/cache 生命周期：最终帧中 image anchor 消失时，renderer 删除旧 placement；关闭后同一 image ID 可以用缓存的 placement-only `a=p` 恢复。OpenPI 不需要增加独立 graphics 删除系统。

对 `ctx.ui.custom(..., { overlay: false })` 做了实际锁定 SDK 挂载消融：暂时去掉 OpenPI fullscreen overlay 分支，沿用 regular 的 native editor replacement 和 `dashboardPageRows`。regular 两个协议 fixture 通过；fullscreen 两个 fixture 在管理页 `close` 提示可见性断言失败。宿主 `createChatViewport` 给 transcript 保留 `minSize: 1`，dock 可 shrink；编辑器替换既不能保证遮挡全部聊天行，也会裁掉 Dashboard 的导航。实验后已恢复临时源码，没有保留该实现。

公开 `setLayoutRoot` 没有对应的读取/恢复 lease。仅调用 setter 无法可靠恢复原宿主 root。公开 `stop/start` 会退出/重进 alternate screen，并清理 search、selection、鼠标手势和 terminal 输入生命周期；它不是本次 modal 的局部替换机制。本轮没有采用这些替代路径。

## 可审查的上游最小修改

候选修改属于 Pi `packages/tui/src/tui.ts` 的 `TuiBase.compositeOverlays`，不是 OpenPI 的 image-paste 或 Session 层。它不新增设置、工具或全局图片开关。

在每个已解析 overlay rectangle 的合成循环内计算：

```ts
const coversViewport =
  this.mode === "fullscreen" &&
  row === 0 && col === 0 &&
  w >= termWidth && overlayLines.length >= termHeight;
```

仅在这项事实成立时，将 `compositeLineAt` 的 base 输入从 `result[idx]` 改为 `""`。overlay 自己的图片仍作为 overlayLine 合成；其下方的图片 anchor 不再进入最终帧。整屏覆盖证明整个 placement 都在遮挡区域内，避免只处理 anchor row 而遗漏延伸到其他行的像素。所有部分覆盖、regular 模式和默认非整屏行为保留原路径。部分 overlay 的 placement clipping 仍需另一项 Pi owner 设计，不在这份候选中猜测。

随后由既有 `TuiAltScreen` 完成 final-frame 比较、placement 删除、缓存保留和关闭恢复。候选没有直接输出图片删除 escape，没有读取私有宿主状态，也没有改变底层 transcript、图片附件或消息。

本地 review patch：`/tmp/openpi-657-upstream-candidate/opaque-fullscreen-overlay.patch`。其源自安装 Pi `1.0.2` `tui.js.map` 的 `sourcesContent`，没有修改安装 package。隔离副本只为验证同一最小源码逻辑生成对应 JS 改动。

OpenPI 当前 Dashboard 默认高度为 terminal rows 减一，因此还需要上游修复后的局部 adoption：在 fullscreen `showOverlay` 边界用转发组件将 Dashboard/child page 的输出裁到 viewport 并补齐空行，保证真实 rectangle 完整覆盖 viewport。焦点、按键、normalized mouse、invalidate、key-release preference 和关闭仍由原 Dashboard 与既有 overlay handle 管理。独立候选审查发现初版 padding wrapper 漏掉 `handleMouse`（P2），会中断 fullscreen transcript wheel；已在本地 candidate 补齐 `Component` 的事件转发，外层保持唯一 dispose owner，避免 double disposal。此 candidate 位于 `openpi-adoption-after-pi-fix.patch`；它尚未应用或验证为生产实现。

## 实际验证与消融

验证程序 `/tmp/openpi-657-upstream-candidate/fullscreen-overlay.test.mjs` 直接使用隔离的安装版 native `TuiAltScreen`，录制 `Terminal.write`。图片由本地可重建的 16×48 PNG fixture 和 SDK `renderImage` 产生；不是用户截图或 Session 数据。

| 对象 | 结果 | 证明范围 |
| --- | --- | --- |
| 原仓库 native Dashboard fixture | 4/4，通过，18.84s | 现有 regular 排除/恢复与 fullscreen 导航/handle cleanup；未断言 fullscreen 图片已解决 |
| native editor replacement 消融 | regular 2/2；fullscreen 0/2，28.40s | fullscreen 管理入口被宿主布局裁掉；候选不可直接复用 regular 路径 |
| 原装 Pi TUI 1.0.2，同一 owner fixture | 2/5，通过，0.16s；3 项预期失败 | 整屏进入未触发旧 placement 删除；stacked 恢复和 overlay 自己的图片断言失败；partial 和鼠标转发对照通过 |
| 隔离的 Pi owner candidate | 5/5，通过，0.19s | 整屏隐藏/恢复、partial、真实 native wheel dispatch、stacked 和 overlay 自己的图片均通过协议断言 |

owner fixture 覆盖三次重复开关、两张图片、打开时多次刷新、44×14/100×24/80×18 resize、关闭后滚动再返回，以及 partial overlay 保持旧行为。新增 native `Terminal.start` 输入回调接收真实 SGR wheel，确认 padding wrapper 把 normalized wheelDelta 传给 source 并保留键盘、焦点、invalidate 和 key-release preference。两层 full-viewport overlays 的上层关闭不会恢复聊天 placement，最后一层关闭才恢复；overlay 自己的第 3 张图片仍可绘制，关闭后恢复底层两图。候选没有通过重新上传来冒充恢复；断言关闭帧包含 SDK 针对两张原图生成的 placement-only sequence。transcript render 数据前后保持相同。

冻结本地 evidence identity：

| Artifact | SHA-256 |
| --- | --- |
| `tui.ts.original` | `92dcb7f5f9a3a9575421d8de366be5cc78890be8df38d86c4ed3c0d77c7f88a4` |
| `tui.ts.candidate` | `e5425b29255ebc02674aa894408f664e8e0b6c5b43630863c085ae60585af486` |
| `opaque-fullscreen-overlay.patch` | `717445eab499cd24a30f871794a088d5e2997c43d6d53b9ccb7958222e440b2b` |
| `openpi-adoption-after-pi-fix.patch` | `8d0269fc59fc19c0995bf35cb0775d15f4eb1c9c9231b8b163d358ce8c690085` |
| `fullscreen-overlay.test.mjs` | `cc63ee4121caa27e9f94e86d4d068040a4d302ff2c41fc9ce7b7529496c3ea34` |
| `fixture.png` | `a539cd72867e775cd1b0220f3d972f161d133c2c9255fef8612d7fda84fe06da` |

这些小型本地 artifact 在该目录可检索；没有公开归档第三方完整源码，也不能把 hash 当作公开可获取证据。上游提交时应将最小源码 diff 与可移植 fixture 一并纳入 Pi 仓库测试。

## 未完成的验收与兼容风险

用户本轮明确选择提交 Pi 上游修复、暂缓 OpenPI adoption。候选不进入当前 OpenPI runtime 或本地安装；上游贡献门禁、完整验证和发布接入分别追踪。

这不是 shipped fix。Pi owner candidate 已接受局部独立审查并修正上述鼠标转发缺陷，但未在上游 source tree 编译或执行完整上游测试，也没有上游维护者的接收审核。OpenPI adoption 未完成实际 native-custom 管理路径验证；更没有真实终端 pixels 验收。原先 Ghostty computer-use 的安全拒绝没有被绕过。#657 应继续保持打开。

fullscreen 的 SDK 自身会暂时禁用 iTerm image capability；本轮 Kitty protocol fixture 不能证明 fullscreen iTerm 像素兼容。需要在支持图片的真实终端固定版本/capability，验收 regular/fullscreen、两图、滚动、resize、取消和关闭后的原聊天图片位置，观察是否有闪烁或残留。

上游必须审核其他全屏 overlays 是否有依赖底层图片保留的行为，以及 cache eviction 的恢复。stacked full-viewport 与 overlay 自己的图片已有本地协议对照，但不能据此排除其他 overlay 组合或真实终端差异。不能仅将 OpenPI SDK 依赖从 0.99.1 升到 1.0.2：安装 1.0.2 仍有原缺陷，升级还涉及其余宿主 API 合同。应等待含该修复的 Pi release，再独立 review SDK 升级和 OpenPI adoption。若上游选择明确 opaque option 而非全覆盖自动推导，OpenPI 必须遵循发布的 public contract，不能 monkey-patch host methods 或依赖不存在的 option。
