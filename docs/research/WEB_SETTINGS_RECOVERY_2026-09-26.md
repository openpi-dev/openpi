# Web 设置入口、草稿与失败恢复

- Status: validated
- Created: 2026-09-26
- Verified: 2026-09-26（冻结参考源码、完整检查/测试及本机隔离预览；不代表生产部署）
- Source boundary: OpenPI PR #598，基于 `736ab52` 的设置 follow-up；Pi SDK 0.85.1；下列冻结参考
- Issue: [#597](https://github.com/openpi-dev/openpi/issues/597)
- PR: [#598](https://github.com/openpi-dev/openpi/pull/598)
- Supersedes: none；补充既有 Web 交互记录，不改写先前版本的验证结果

## 已核对的参考

| 来源 | 已核实的观察 | 采用范围及限制 |
| --- | --- | --- |
| Maka `5b9db1c` 的 [settings-surface.ts](https://github.com/apache/maka/blob/5b9db1ce8fdb83f0841cfd058084abe143847348/apps/desktop/src/renderer/features/overlays/model/settings-surface.ts) | 服务商相关 intent 落到 Models；普通入口可以保留分类 | 入口应对应用户任务；不复制其状态结构 |
| 同版本 [provider-panel-shared.ts](https://github.com/apache/maka/blob/5b9db1ce8fdb83f0841cfd058084abe143847348/apps/desktop/src/renderer/features/connection-settings/provider-panel-shared.ts) | 动作异常先脱敏，再提供操作相关反馈 | 不透传服务商异常；不搬入字符串错误分类器 |
| Pi Web `a345b2a` 的 [SettingsDialog.ts](https://github.com/jmfederico/pi-web/blob/a345b2ac363b644d5ef43b1da75b9bc53cd055c4/src/client/src/components/SettingsDialog.ts) | 外部传入 section；分类面板接收加载、保存、错误、保存反馈及对应回调 | 入口和操作状态应明确；没有证明参考产品已经解决此处草稿冲突 |
| 本机 Codex 窗口 | 自动化工具访问 `com.openai.codex` 时明确返回拒绝，没有给出具体规则 | 本批没有 Codex 窗口交互实测，不声称产品对等；已有截图及队列源码证据见[先前记录](WEB_QUEUED_COMPOSER_2026-09-26.md) |

Maka、Pi Web 均只读检查本地冻结 checkout，没有在本批启动参考应用。以下交互选择是 OpenPI 的实现推断与验证，不是声称参考产品逐项采用相同机制。

## 设计与实现

1. **入口对应任务。** Composer、运行状态中的凭据入口打开 Models，并在数据到达后一次性聚焦凭据控件或服务商选择器；普通 Settings 打开 General。用户已导航时不抢焦点，切换设置标签后不重复聚焦；兼容开发 StrictMode。
2. **离开之前保护草稿。** 模型表单按原始定义或原生预填值判断是否真的修改，聚合所有模型草稿。关闭或转到运行状态前确认；跨服务商检查会丢失未提交凭据时也确认。取消保留草稿，保存进行中不能关闭或切换正在提交的凭据服务商。
3. **失败属于对应动作。** 模型和凭据分别区分加载/保存失败，加载重试不删除草稿。确认放弃模型草稿后，只有权威配置读取成功才替换；失败仍保留草稿。密钥提交仍立即清空输入，失败显示固定安全说明，不冒充认证状态加载失败，不透传异常文本。
4. **冲突有确切证据。** 原有 models.json revision 校验投射 `MODEL_CONFIGURATION_CONFLICT` / 409；普通失败不是版本冲突。刷新一个模型时保留其他草稿，但若其他草稿原始基线已被外部改变或删除，阻止直接覆盖，要求对应草稿显式恢复。HTTP 仅信任 runtime typed error，不信任伪造的 code/status 对象。
5. **刷新不是导航授权。** 模型保存后的认证刷新不再 remount 凭据组件，保留同服务商未提交输入。保存后检查新模型不被仍待结束的偏好刷新拦截，并携带已保存定义的服务商身份，避免新目录状态尚未提交时误判。外部模型删除也不能自动换服务商、清掉凭据；保留单个当前检查对象直到用户确认或另作选择。

这些均为现有 Pi 原生 models.json/login 生命周期的 UI 投影与保护。没有新增模型工具、provider stack、package 配置入口、数据库或浏览器持久化草稿；OAuth 与多字段认证仍交给 Pi 原生登录。会话权威身份变化仍可撤销整个设置界面，不为草稿延长旧 Session 的权限。

## 验证

- `bun run check` 通过；原有 bundle-size 警告保留。
- 设置表单和页面 Vitest 52/52；真实 App 文件 73/73，包括凭据/普通设置入口路由。
- 模型配置与 HTTP 专项 Node 51/51，包含初始过期、写前竞争、外部内容保留、临时文件清理、typed/普通/伪造错误码。
- 本机隔离 `57162` 预览：凭据入口进入 Models，数据到达后焦点和滚动定位正确；测试模型地址草稿关闭确认、取消保留、确认后返回原触发控件。未保存模型、输入真实密钥或发起模型请求。
- `390x844`、`1280x900` 截图及 DOM 几何检查：无页面横向溢出，目标控件在视口内；检查后恢复默认视口。不是 Safari、全 IME 或真实认证流程验收。
- 完整 `bun run test` 通过：Node 1956 通过、5 跳过；Vitest 536/536。首轮 Vitest 在文件引用的焦点断言失败：现有 Dialog 先还焦点给触发按钮，Composer 下一 timer 才恢复输入框和光标。测试此前只等输入内容和 artifact release；改为等待实际焦点/光标恢复，未改变实现或加固定延时，专项和全套重跑通过。本机回归日志为 `openpi-pr598-settings-tests-20260926.log`，保留在 `/private/tmp/`，不提交 Git。
- 按用户要求没有重跑 E2E。本机常驻 `57161` 未更新或重启。

预览来源已先核对 README 开发运行时规则：checkout 基线 `736ab52`，独立 agent 目录的 `pi list` 唯一 OpenPI 来源是当前 PR worktree。本机 UI 观察留在当前任务工具结果，不发表为正式 Benchmark，也不提交私有配置、Session 或截图。

## 消融

仅在需要确认时挂载现有 Astryx AlertDialog，去掉常驻确认组件；移除冗余本地 conflict 清理，回归仍通过。草稿状态文字复用同一现有样式，不加另一套提示组件。

临时移除当前检查对象保留逻辑，外部模型删除回归失败，页面在用户接受导航前变成 Add Model；恢复后通过。因此保留这个单对象引用，但没有把整个模型目录复制成第二份状态或新增导航框架。

## 后续调查建议

这些是尚未实现的下一批候选，不是已经采用的项目约束：

- Files / Git Review / Terminal 的“检查后返回”：内部 Escape 不应关闭整个工作栏，预览退出应在原列表可见后恢复焦点；成功状态也需要可靠刷新，旧 diff 失败不能泄漏到新选择。
- Session 的“回到工作位置”：精确 `(id, path)` 作用域内的未发送文本/图片草稿、阅读锚点；已选中会话不应重复全量重载，读者选中标记不应绑定输入控制权；归档目录使用已有分页接口。

这些方向需继续用源码与真实界面核实，再按完整操作流程分别实现；本批没有声称 Web 体验迭代已经整体完成。
