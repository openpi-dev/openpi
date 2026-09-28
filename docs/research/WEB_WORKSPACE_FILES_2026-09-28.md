# 工作区文件与原位预览

- 状态：validated（限下述源码、Host、组件、Chromium 与本地无模型调用的原生会话验证）。不是 Benchmark 或设计 Decision。
- 创建 / 验证日期：2026-09-28。
- 源码边界：起始于 [PR #598](https://github.com/openpi-dev/openpi/pull/598) head `e526d11d22b1c7eaa35656b1c369b53766102d09`，独立分支 `codex/workspace-files`；最终接到浏览器提交 `79a4f63e317cb1f138884dafedbd73cc322fde2d`，兼容其原生 iframe，并合并双方 CSP 要求。
- 关联讨论：[Issue #597](https://github.com/openpi-dev/openpi/issues/597)。
- Supersedes：none；替换本次工作区的“生成文件”入口，不改写此前研究结论。

## 参考事实

阅读 [DSH-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar/tree/9b5834f74ad197534c821c35b8357edac1ad3919) 的冻结版本 `9b5834f74ad197534c821c35b8357edac1ad3919`：

- `src/fs-tree.ts` 单目录最多 1000 项；`src/fs-search.ts` 最多 200 个匹配、扫描 100000 项。达到上限时截断，没有继续加载游标。
- 目录更新通过展开目录的 watcher 与约 150 ms debounce 合并，最多 64 个 watcher；Socket 生命周期清理。
- 插件自己实现 Markdown、Mermaid、HTML、代码编辑等界面；图片、PDF、表格和 Office 的部分预览交给 DSH 宿主，不能当成可直接复制进 OpenPI 的完整浏览器组件。
- HTML iframe 允许脚本及部分弹窗/下载能力。OpenPI 当前选择只读静态 HTML/SVG 沙箱，不提供同等脚本执行能力。

这些是参考源码观察，不是 OpenPI 的既有约束；本次没有复制 DSH 源码。

## 实现与所有权

“文件”使用活动 Pi Session 的 cwd 浏览磁盘，不再从 write/edit 结果拼出文件列表。文件编辑证据仍留在对话原有证据区。右侧文件树与左侧预览共处一个工作栏；切换文件不新增窗口或工具标签。窄面板选择文件后收起树，可通过按钮恢复。

生命周期沿用 Pi Session、WebHost 和已有 ArtifactReader：Session id 与原生 Session path 共同约束目录游标和文件授权。选择文件、搜索词、是否继续加载属于用户交互；作用域、版本一致性、并发、资源上限与清理由 Host 执行。不增加模型工具、模型路由、独立 Session 存储或用户配置项，也不替模型规定读哪些文件。

目录和搜索按最多 250 个匹配或 2000 个扫描项返回一页；不透明、单次使用的游标保留扫描位置，后续页追加，已有行不重新排序。游标最多 16 个、五分钟过期、关闭或切换时释放。搜索跳过 `.git` 与 `node_modules` 的递归，不自动跟随符号链接。目录身份或内容发生变化时明确要求刷新，不把混合结果当成完整列表。

长文本按最多 256 KiB / 5000 行续读；续读绑定首份内容 revision，并保留 UTF-8 字节边界。文件变更时保留正在阅读的文本，提示手动刷新。单文件读取/下载仍限 20 MiB。达到页尾、还有下一页、版本失效、读取失败是不同状态；取消后迟到结果不能进入新 Session。

文件树在打开、重新获得焦点、页面恢复可见及手动刷新时更新，没有常驻目录轮询。当前可见预览沿用有退避的轻量元数据检查，隐藏时停止；目录展开状态、搜索词和已加载页在同一面板内保留。未引入 watcher 服务或新的通用缓存层。

## 预览范围

| 格式 | 行为与边界 |
| --- | --- |
| Markdown | 表格、安全 HTML、相对路径栅格图、Mermaid；图表支持放大、缩放和拖动，Escape 只关闭图表。 |
| 代码 | 查看源代码、常用语言高亮；大文本跳过高亮以保留阅读响应。 |
| HTML / SVG | opaque-origin iframe 与限制性 CSP；不执行脚本、不加载远程资源、不提交表单。 |
| 图片 | PNG/JPEG/GIF/WebP，沿用类型嗅探与只读授权，适应宽度或原尺寸。 |
| CSV / TSV | 引号、转义与单元格换行，最多 500 行 / 50 列；公式作为文字。 |
| PDF | PDF.js 分页与缩放，渲染像素有界，不运行文档脚本。 |
| DOCX | Mammoth 内容转换；不保证 Word 分页或精确排版。 |
| XLSX | ExcelJS 工作表切换；最多 20 表、每表 500 行 / 50 列、总计 20000 单元格。 |
| PPTX | 有序幻灯片文字与内嵌图片；不保证主题、图表、动画或母版复现。 |

Office 在 Worker 内处理，解压声明总量 40 MiB、单项 10 MiB、2000 个条目，处理超时 15 秒后终止；切换或卸载释放 Worker。旧版 `.doc/.xls/.ppt`、加密或无法解码的文件提示下载后打开。所有资源限制都是当前实现边界，不声称覆盖所有生产文档。

## 验证与消融

使用独立 worktree、Node 24.20.0、Bun 1.3.14、锁定依赖。本地原生实例的隔离 `PI_CODING_AGENT_DIR` 经 `scripts/provenance.mjs` 验证：checkout revision 与唯一 `pi list` OpenPI 来源相符。没有修改另一个浏览器任务的 checkout 或用户全局配置。原生 Session 使用无模型调用的本地夹具，实际打开 `AGENTS.md`，验证文件树与正文并排。

新增 Host 测试覆盖真正跨页的目录/搜索、Session path 与游标绑定、游标重放、目录变更、符号链接边界、UTF-8 完整续读和版本变更；组件测试覆盖同面板导航、加载次序、搜索取消、隐藏后恢复、目录消失与续读滚动。Chromium 使用真实生产静态文件和 WebHost，覆盖新增格式、Mermaid 标签与 Escape、HTML 隔离、暗/亮色、390px 布局与 axe。

消融实验：删除已被静态共享组件导入的 DocumentPreview 外层 lazy/Suspense，保留格式库在实际使用时的动态导入；五条文件组件测试仍通过，因此保留更小实现。移除旧 generated-files 派生列表、返回路由、组件、样式和对应旧测试；现有文件变更证据继续通过独立回归。

- 最终 `bun run check`：通过（构建仍提示部分格式库 chunk 超过 500 kB；重型格式库按需加载）。
- 最终 `bun run test`：Node 1956 passed / 5 平台或条件 skip / 0 failed；Vitest 823 / 823 passed。
- 文件专项 Chromium：3 / 3 passed，含真实文件证据、图片、全部新增格式、两页 PDF 与实际缩放、多图 Markdown、暗/亮色、移动布局和 axe。
- 初次完整 Chromium：57 / 68 passed。11 条既有用例在未改动的 `e526d11` 源码和重建产物上全部重现相同失败，涉及旧英文工作区按钮名、归档夹具/行数、设置标题、模型选项焦点和 prompt recovery；不归因于文件实现，也没有将完整 E2E 宣称为通过。
- 接入 `79a4f63` 后，显式排除上述 11 条已证实的基线失败，其余 Chromium 56 / 56 passed，包含最新原生 iframe 浏览器交互及文件预览。排除仅存在于本地验证命令，仓库没有禁用这些测试。
- 修复过程中真实浏览器发现并修正了带点号的动态 chunk 静态路由、Mermaid 12 标签配置、图表 Escape 传播和 PDF 缩放被 CSS 压缩的问题。常规聊天 Markdown 的复制状态回归亦已修复。

日志凭据：`check-integrated.log`、`test-integrated.log`、`e2e-full.log`、`e2e-baseline2.log`、`e2e-integrated.log`、`e2e-verified.log`、`ablation3.log`；截图见 `browser-results-final/`。这些不是模型执行或正式性能测量。

本地证据身份：`openpi-workspace-files-20260928`。日志与截图保存在仓库外 `~/.local/state/openpi-workspace-files-20260928/`；公开可复现证据为本分支的测试与源代码。无模型推理能力、性能 Benchmark、Safari、真实读屏器或大型复杂 Office 文档验收声明。

## 2026-09-28 界面修订：分栏、编辑与章节目录

本节补充上述初版验证，不将初版的窄屏验收视为最终交互达标。用户截图指出正文被文件树遮挡、顶部按钮重叠；并要求参考 DSH 的预览/编辑切换与 Markdown 目录。修订接续本分支 `19b9593`，发布于 [文件 PR #2](https://github.com/testikun/openpi/pull/2)，仍关联 [Issue #597](https://github.com/openpi-dev/openpi/issues/597)。

- 删除窄屏覆盖树、选中文件自动收起树、操作按钮绝对定位规则。共享顶栏横跨两个真实网格列；正文与树各自滚动，路径空间不足时顶栏换行。320、390、456、560、720 px 均保持树与正文分离，只有显式点击才收起树。此行为替代上文初版的“窄面板选择文件后收起树”。恢复 Markdown 列表标记与长标题换行。
- 顶栏提供预览/编辑、保存勾选、未保存标记、放弃草稿与 Cmd/Ctrl+S。最多 16 份内存草稿按 Session id、Session path、文件路径隔离；重新打开文件可恢复，浏览器页面重载不持久化。预览模式可以检查草稿的渲染结果。
- 右端的打开/关闭文件夹图标切换文件树，选中状态与提示文案对应当前树状态；预览/编辑按钮包含悬停、按下和键盘焦点反馈。切换预览时保留编辑器 DOM，返回编辑可恢复光标和草稿，回到预览保留正文滚动位置。HTML 用例实际核对未保存草稿预览、回到编辑、预览态保存及磁盘内容，不只是检查按钮存在。
- 复用 WebHost 的认证、来源校验和 ArtifactReader 的文件授权，新增显式版本化保存请求；未增加模型工具、独立运行时或配置项。只写当前工作区的普通 UTF-8 文本，原文件与新内容均限制 1 MiB；外部只读授权不升级为写权限。保留文件权限，使用同目录临时文件与原子替换，保存前复核内容 revision、文件/目录身份、授权与 Session。并发保存或版本变化明确失败，草稿不丢弃。操作者可刷新检查磁盘文本，手动核对后继续编辑。
- 原子替换防止半份文件成为结果；版本检查是乐观并发控制，不宣称锁住所有外部编辑器或恶意文件系统进程。文件保存属于操作者修改，不伪造 Pi 工具 write/edit 证据。
- 同一冻结 DSH 版本的 `src/client/md-toc.tsx` 从渲染 DOM 的 h1–h6 收集目录、弹出后滚动定位。OpenPI 独立实现相同交互，补充当前章节、键盘焦点、Escape 关闭、点击外部关闭及展开折叠章节祖先。React 文本更新即可重取标题，因此没有复制其常驻 MutationObserver。

消融：移除上述窄屏覆盖/自动收起规则及重复目录标题，不增加浮层布局控制器；保留公共顶栏与两列网格后，所有宽度的实际几何断言、预览格式和编辑测试仍通过，故保留删除。目录也不需要额外 DOM 观察服务。

本轮 `bun run check` 通过；`bun run test` 为 Node 1959 passed / 5 skip / 0 failed，Vitest 823 / 823 passed。首次并行运行出现一条既有终端焦点测试超时，完整重跑通过，未修改该测试。新增 Host 用例覆盖保存内容/权限、版本冲突、重叠保存、二进制/超限/外部授权拒绝、符号链接与保存期间撤销；HTTP 用例验证保存的认证和来源校验。文件专项 Chromium 3 / 3 通过，覆盖真实磁盘保存、快捷键、草稿返回、外部修改冲突及核对恢复、目录跳转/Escape、展开目录的 axe、暗亮色及五个窄宽度。

本轮不重新声明完整 Chromium 为通过；上文 11 项基线失败仍按原证据保留。证据目录追加 `iteration/`，含本轮 check、test、浏览器日志和截图，不包含凭据或原生会话私有数据。
