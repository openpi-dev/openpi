# Git review：重命名详情与比较身份

- Status: validated
- Created: 2026-09-23
- Verified: 2026-09-23
- Source boundary: OpenPI `0bc3470` + 本记录所在 PR #598 的 Git review 修复
- Issue: [#597](https://github.com/openpi-dev/openpi/issues/597)
- PR: [#598](https://github.com/openpi-dev/openpi/pull/598)
- Supersedes: none；补充[原生交互调查](WEB_NATIVE_INTERACTIONS_2026-09-20.md)

## 复现与根因

评审指出的两项问题在 `0bc3470` 仍可复现。真实临时仓库执行 `git mv` 后，暂存摘要正确显示 renamed，旧详情查询却在识别重命名前把 pathspec 限定为新路径，导致旧路径被排除，退化成新增文件。新回归包括纯重命名、重命名后编辑、分支比较，以及含方括号的字面文件名。

另用 `git hash-object` 与 `git update-index --cacheinfo` 只替换 index blob，保留工作文件的内容、size、mtime、ctime 不变；新旧暂存文本均为 +1/-1。旧摘要 revision 相同，但详情已经改变。未暂存视图也存在此问题，因为 index 是它的左端。只移动 HEAD、保持 index/工作文件不变，同样可能出现统计相同而比较内容不同。

## 修复

使用 [Git 官方 raw diff 格式](https://git-scm.com/docs/git-diff#_raw_output_format)中的完整前后对象 ID、文件模式、状态与路径生成比较身份，不读取 index 的 mtime，也不写入临时 tree 到用户仓库。工作树参与比较时继续保留有界文件元数据；纯暂存视图由 Git 比较身份决定，不受无关工作文件时间戳影响。

逐文件详情先在完整 raw 元数据中找出重命名两端，再用字面 pathspec 查询。详情的 raw 元数据和 patch 来自同一次 Git 调用，随后只返回请求的文件。摘要继续只读取元数据和 numstat，不加载整个工作区的 patch。保留已有超时、字节/文件数限额，以及禁用 external diff/textconv 的边界。

## 验证与限制

六项真实 Git 回归在旧实现上失败，修复后 Git review 的 15 项测试通过。分别移除旧路径和对象身份保护，两组回归重新失败；恢复后通过。没有引入第二份 Git 状态存储或新的配置选项。

真实 Chromium + WebHost + Git 用例确认：面板显示 `rename from` / `rename to`；外部只改变暂存 blob 后，经现有窗口 focus 刷新路径，仍打开的 diff 从 staged-a 更新为 staged-b，草稿及输入焦点保留。该用例不调用模型。

评审提到的滚轮失败属于较早提交 `4480b8d`。后续 `13465ad` 让测试夹具等待 React 被动效果，保留滚动合并与调用次数断言；`0bc3470` 的 Node 24 与全部 CI 已通过。本轮仍重跑完整门禁，以新提交的检查为准，不用历史绿色代替当前验收。

Git 命令之间不是仓库事务快照；并发编辑时仍依赖下一次刷新收敛。本轮不声称对 PR 全部文件完成手工浏览器验收，也不把局部响应时间当作性能 Benchmark。原始红绿、消融、浏览器截图和最终验证日志保存在私有 `openpi-pr561-usage-20260920/git-review-20260923`，不包含用户会话或凭据。
