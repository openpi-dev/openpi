# Pi Coding Agent 配置化生态研究

> 研究目标：找出 `my-pi-setup` 可学习但不应盲抄的配置机制。  
> 研究日期：2026-07-29。  
> 方法：只读审查 GitHub README、文档、源码与测试；未执行候选项目代码、未安装任何包。所有外部引用均固定到审查时 commit SHA。

## 1. 结论摘要

### 事实

1. **Pi 官方能力已经解决“资源级配置”的大部分问题。** Pi 原生区分全局 `~/.pi/agent/settings.json` 与项目 `.pi/settings.json`，项目配置需经过 trust；`pi config` 可在全局/项目 scope 间切换，并支持 package 内 extension/skill/prompt/theme 的 include、exclude、force include/exclude。`my-pi-setup` 不应再造第二套 package filter。[官方 settings `settings.md` L1-L22](https://github.com/earendil-works/pi/blob/027a5847901b5dde30270abaa1041046cd2b4b55/packages/coding-agent/docs/settings.md#L1-L22)；[官方 package filtering `packages.md` L190-L228](https://github.com/earendil-works/pi/blob/027a5847901b5dde30270abaa1041046cd2b4b55/packages/coding-agent/docs/packages.md#L190-L228)
2. **最值得学习的统一配置控制面是 SuPi。** 它让各扩展通过声明式 registry 注册字段，由单一 `/supi-settings` 搜索界面统一展示，并明确显示 `(project)/(global)/(default)` 来源、支持 `Inherit/Reset to default`。[SuPi README `packages/supi-settings/README.md` L23-L48](https://github.com/mrclrchtr/supi/blob/1b61ce13050271de514c5a43b14efef7159477d5/packages/supi-settings/README.md#L23-L48)；[registry `settings-registry.ts` L10-L76](https://github.com/mrclrchtr/supi/blob/1b61ce13050271de514c5a43b14efef7159477d5/packages/supi-core/src/settings/settings-registry.ts#L10-L76)
3. **最值得学习的安全保存、预览和回滚机制来自 narumiruna/pi-extensions。** `pi-statusline` 对未知字段给 warning、对非法已知字段阻止保存、使用临时文件+rename、live preview 只在 Enter 后落盘，运行时 apply 失败时恢复旧文件与旧状态。[statusline README L157-L192](https://github.com/narumiruna/pi-extensions/blob/5e34d9ac004d7785bb1285b876f31cb2238d6e0b/extensions/pi-statusline/README.md#L157-L192)；[保存逻辑 `settings.ts` L360-L434](https://github.com/narumiruna/pi-extensions/blob/5e34d9ac004d7785bb1285b876f31cb2238d6e0b/extensions/pi-statusline/src/settings.ts#L360-L434)；[回滚逻辑 `commands.ts` L795-L843](https://github.com/narumiruna/pi-extensions/blob/5e34d9ac004d7785bb1285b876f31cb2238d6e0b/extensions/pi-statusline/src/commands.ts#L795-L843)
4. **`my-pi-setup` 已经有一个很好的独有优势：单一自然语言入口 + 最小 typed mutation tool。** `/my-pi-setup` 负责解释和收集意图，`configure_my_pi_setup` 只暴露受限 typed state，并且校验 model registry；这比候选项目常见的子命令堆叠更符合本项目契约。[当前 `extensions/setup/index.ts` L25-L75](https://github.com/tt-a1i/my-pi-setup/blob/3139b4b80800edb44d665cd6575093a3049727d2/extensions/setup/index.ts#L25-L75)；[同文件 L171-L203](https://github.com/tt-a1i/my-pi-setup/blob/3139b4b80800edb44d665cd6575093a3049727d2/extensions/setup/index.ts#L171-L203)；[同文件 L260-L297](https://github.com/tt-a1i/my-pi-setup/blob/3139b4b80800edb44d665cd6575093a3049727d2/extensions/setup/index.ts#L260-L297)
5. **当前最大缺口不是“更多设置”，而是配置生命周期的可观察性和安全语义。** 当前 loader 对任何读取/JSON 错误都静默回退默认值，配置无文档版本号、无来源/诊断、无 project scope、无运行时 apply 失败回滚；保存虽为 `0600` 临时文件+rename，但测试主要覆盖 parser/prompt，而未覆盖 malformed file、写失败、权限、并发和 rollback。[当前 `setup-config.ts` L343-L427](https://github.com/tt-a1i/my-pi-setup/blob/3139b4b80800edb44d665cd6575093a3049727d2/extensions/shared/setup-config.ts#L343-L427)；[当前 setup tests L6-L61](https://github.com/tt-a1i/my-pi-setup/blob/3139b4b80800edb44d665cd6575093a3049727d2/extensions/setup/index.test.ts#L6-L61)

### 建议

保持 `/my-pi-setup` 为唯一用户入口；先补齐 **versioned document + diagnostics + fail-closed save + rollback + doctor/inventory + 测试**，再考虑 project scope、专用 TUI 和 profiles。资源启停直接委托 Pi 原生 `pi config`，不要把 `settings.json` package filter 复制进 `my-pi-setup.json`。

---

## 2. 当前 `my-pi-setup` 基线与差距

| 维度 | 当前事实 | 差距判断 |
|---|---|---|
| 统一配置入口 | `/my-pi-setup` 是唯一命令；无参数走模型引导，有参数走定向自然语言；最终最多调用一次 typed tool。[`index.ts` L25-L66](https://github.com/tt-a1i/my-pi-setup/blob/3139b4b80800edb44d665cd6575093a3049727d2/extensions/setup/index.ts#L25-L66) | **强项，保留。** 缺的是机器可读 status/doctor，不是更多子命令。 |
| 全局/项目 scope | 配置路径固定为 `getAgentDir()/my-pi-setup.json`。[`setup-config.ts` L129-L146](https://github.com/tt-a1i/my-pi-setup/blob/3139b4b80800edb44d665cd6575093a3049727d2/extensions/shared/setup-config.ts#L129-L146) | 只有 global；没有 source badge、inherit/reset、project trust。 |
| Schema / validation | TypeBox 约束 tool 入参；持久化读取使用手写 normalization，非法值回退默认。[`index.ts` L75-L169](https://github.com/tt-a1i/my-pi-setup/blob/3139b4b80800edb44d665cd6575093a3049727d2/extensions/setup/index.ts#L75-L169)；[`setup-config.ts` L294-L398](https://github.com/tt-a1i/my-pi-setup/blob/3139b4b80800edb44d665cd6575093a3049727d2/extensions/shared/setup-config.ts#L294-L398) | tool 边界强，disk 边界弱：没有结构化 diagnostics、unknown-field policy、document version。 |
| Migration | `footerItems` 可读并转换为 `footerLines`。[`setup-config.ts` L294-L325](https://github.com/tt-a1i/my-pi-setup/blob/3139b4b80800edb44d665cd6575093a3049727d2/extensions/shared/setup-config.ts#L294-L325) | 属于隐式兼容，不是可审计 migration；无版本、备份或迁移报告。 |
| Interactive TUI / preview | 依赖模型调用 `ask_user`；footer 保存后通过事件立即刷新。[`index.ts` L37-L65](https://github.com/tt-a1i/my-pi-setup/blob/3139b4b80800edb44d665cd6575093a3049727d2/extensions/setup/index.ts#L37-L65)；[`index.ts` L249-L255](https://github.com/tt-a1i/my-pi-setup/blob/3139b4b80800edb44d665cd6575093a3049727d2/extensions/setup/index.ts#L249-L255) | 没有 unsaved live preview、Escape cancel restore、来源展示；首次 setup 还需要模型 round trip。 |
| Presets / profiles | 有 3 个 footer preset，应用顺序为 current → preset → explicit overrides。[`setup-config.ts` L77-L93](https://github.com/tt-a1i/my-pi-setup/blob/3139b4b80800edb44d665cd6575093a3049727d2/extensions/shared/setup-config.ts#L77-L93)；[`setup-config.ts` L252-L291](https://github.com/tt-a1i/my-pi-setup/blob/3139b4b80800edb44d665cd6575093a3049727d2/extensions/shared/setup-config.ts#L252-L291) | 无跨功能 profile（如 minimal/full/research），也无 session/runtime-only profile。当前规模下不急。 |
| Feature discovery / doctor | 无参数输出当前五类状态；但由模型解释。[`SETUP.md` L26-L45](https://github.com/tt-a1i/my-pi-setup/blob/3139b4b80800edb44d665cd6575093a3049727d2/SETUP.md#L26-L45) | 不报告 config path/source、解析警告、registered/effective feature、依赖可用性、被 Pi filter 禁用原因。 |
| Package filtering / toggle | package manifest 加载整个 `./extensions`、`./skills`、`./themes`。[`package.json` L12-L21](https://github.com/tt-a1i/my-pi-setup/blob/3139b4b80800edb44d665cd6575093a3049727d2/package.json#L12-L21) | 无 package-owned feature inventory；但资源级 filter 应复用 Pi 原生能力，而不是复制一份。 |
| Secrets / model selection | 当前配置不存 API key；summary model 在保存前通过 `modelRegistry.find` 验证；文件写 mode `0600`。[`index.ts` L185-L203](https://github.com/tt-a1i/my-pi-setup/blob/3139b4b80800edb44d665cd6575093a3049727d2/extensions/setup/index.ts#L185-L203)；[`setup-config.ts` L414-L426](https://github.com/tt-a1i/my-pi-setup/blob/3139b4b80800edb44d665cd6575093a3049727d2/extensions/shared/setup-config.ts#L414-L426) | 基线正确。应继续把 auth 留给 Pi；doctor 只显示 provider/model 是否可解析，不显示 secret。 |
| Portability / sync | 无 export/import/sync。 | 对本项目不是立即缺陷；若做，先做去 secret 的可审查 export，不要直接引入远端同步。 |
| Safe defaults / rollback | recap 默认关闭；workflow 有上限；大 header 关闭；写入原子化。[`setup-config.ts` L101-L144](https://github.com/tt-a1i/my-pi-setup/blob/3139b4b80800edb44d665cd6575093a3049727d2/extensions/shared/setup-config.ts#L101-L144) | 默认值较安全；但 malformed file 会静默变成 defaults，且 save 后 runtime refresh 若失败没有回滚。 |
| Tests | parser、footer normalization、prompt/registration 均有测试。[`summaries/config.test.ts` L27-L96](https://github.com/tt-a1i/my-pi-setup/blob/3139b4b80800edb44d665cd6575093a3049727d2/extensions/summaries/config.test.ts#L27-L96)；[`setup/index.test.ts` L6-L61](https://github.com/tt-a1i/my-pi-setup/blob/3139b4b80800edb44d665cd6575093a3049727d2/extensions/setup/index.test.ts#L6-L61) | 缺 storage contract、migration、source precedence、permission、concurrency、rollback、doctor snapshot 测试。 |

---

## 3. 候选项目排名

评分只针对“可配置 setup 机制”，不是项目总体质量。

| 排名 | 候选 | 最强机制 | 不应盲抄之处 | 结论 |
|---:|---|---|---|---|
| 1 | `mrclrchtr/supi` | 声明式 settings contribution registry；单一 searchable TUI；scope/source/inherit 语义。[README L23-L37](https://github.com/mrclrchtr/supi/blob/1b61ce13050271de514c5a43b14efef7159477d5/packages/supi-settings/README.md#L23-L37) | 当前 shared config 直接 `writeFileSync`，无原子 publication；读取失败会忽略并 `console.warn`；所示 project config 代码没有 trust gate。[`config.ts` L48-L66](https://github.com/mrclrchtr/supi/blob/1b61ce13050271de514c5a43b14efef7159477d5/packages/supi-core/src/config/config.ts#L48-L66)；[`config.ts` L132-L149](https://github.com/mrclrchtr/supi/blob/1b61ce13050271de514c5a43b14efef7159477d5/packages/supi-core/src/config/config.ts#L132-L149) | **学控制面，不抄存储层。** |
| 2 | `narumiruna/pi-extensions` | `pi-statusline` 的 diagnostics/live preview/rollback；`pi-tui-kit` 的 serialized save + optimistic rollback；`pi-sync` 的安全迁移和恢复。[TUI kit L97-L148](https://github.com/narumiruna/pi-extensions/blob/5e34d9ac004d7785bb1285b876f31cb2238d6e0b/packages/pi-tui-kit/README.md#L97-L148) | `pi-sync` 的跨进程锁、远端 backend、journal 是高风险同步产品所需，不适合普通本地 setup 全量复制。[pi-sync README L214-L228](https://github.com/narumiruna/pi-extensions/blob/5e34d9ac004d7785bb1285b876f31cb2238d6e0b/extensions/pi-sync/README.md#L214-L228) | **学事务语义和 UX；按风险裁剪。** |
| 3 | Pi 官方 `settings` / `packages` / `preset.ts` | 原生 global/project trust、package filter、scope UI；preset 可组合 model/thinking/tools/instructions 并恢复原状态。[settings L1-L22](https://github.com/earendil-works/pi/blob/027a5847901b5dde30270abaa1041046cd2b4b55/packages/coding-agent/docs/settings.md#L1-L22)；[preset L101-L117](https://github.com/earendil-works/pi/blob/027a5847901b5dde30270abaa1041046cd2b4b55/packages/coding-agent/examples/extensions/preset.ts#L101-L117) | `preset.ts` 是 example，不是完整产品：JSON 仅 try/catch、无 schema/version；恢复 session 时只恢复 preset 名/指令，不重新应用 model/tools。[preset L412-L424](https://github.com/earendil-works/pi/blob/027a5847901b5dde30270abaa1041046cd2b4b55/packages/coding-agent/examples/extensions/preset.ts#L412-L424) | **资源层直接复用；preset 只借鉴状态快照。** |
| 4 | `spences10/my-pi` | 内建 feature registry 与 `/extensions` searchable manager；区分 saved/effective/CLI-forced state；变更后 reload；有 legacy backup migration。[manager L30-L91](https://github.com/spences10/my-pi/blob/1e3fac4e45aed0998b123470329db17dd27de23b/src/extensions/manager/index.ts#L30-L91)；[manager L154-L187](https://github.com/spences10/my-pi/blob/1e3fac4e45aed0998b123470329db17dd27de23b/src/extensions/manager/index.ts#L154-L187)；[migration L121-L155](https://github.com/spences10/my-pi/blob/1e3fac4e45aed0998b123470329db17dd27de23b/src/settings/migrate.ts#L121-L155) | 它是独立 Pi distribution，配置面远大于 package；其 shared store 大量使用 `unknown`+cast，且默认所有未显式配置的 feature 为 enabled，不符合本项目“昂贵/特权行为 opt-in”契约。[`pi-settings/index.ts` L11-L18](https://github.com/spences10/my-pi/blob/1e3fac4e45aed0998b123470329db17dd27de23b/packages/pi-settings/src/index.ts#L11-L18)；[`manager/config.ts` L52-L66](https://github.com/spences10/my-pi/blob/1e3fac4e45aed0998b123470329db17dd27de23b/src/extensions/manager/config.ts#L52-L66) | **学 feature inventory 和 migration report，不学 distribution 复杂度。** |
| 5 | `dannote/dot-pi` | Bootstrap 有 `--yes`、`--dry-run`、`--local`、平台检测、可选 companion，默认低惊讶并把实验/凭证功能设为 opt-in。[installer L16-L55](https://github.com/dannote/dot-pi/blob/68aebfddc297eab2f467d680421995e07a3565a6/install.sh#L16-L55)；[README L117-L142](https://github.com/dannote/dot-pi/blob/68aebfddc297eab2f467d680421995e07a3565a6/README.md#L117-L142)；[README L282-L310](https://github.com/dannote/dot-pi/blob/68aebfddc297eab2f467d680421995e07a3565a6/README.md#L282-L310) | 设置散落于 Pi settings、env JSON、环境变量；helper 直接读 `.pi/settings.json`，未展示 Pi trust gate。[`shared/settings.ts` L7-L34](https://github.com/dannote/dot-pi/blob/68aebfddc297eab2f467d680421995e07a3565a6/extensions/shared/settings.ts#L7-L34) | **学 dry-run/可选能力/低惊讶默认，不学散装配置。** |
| 6 | `w-winter/dot314` | README 资源目录清楚，明确教用户用原生 `pi config` 与 package filter；区分导出和未导出扩展。[README L15-L78](https://github.com/w-winter/dot314/blob/073a99abce5d87d2119d7147a83b5cfba1db2667/README.md#L15-L78)；[README L134-L150](https://github.com/w-winter/dot314/blob/073a99abce5d87d2119d7147a83b5cfba1db2667/README.md#L134-L150) | 配置文件常位于 extension 源目录；统一 setup、schema、migration、doctor 不明显；preset 文件甚至未从 package manifest 导出。[`package.json` L21-L60](https://github.com/w-winter/dot314/blob/073a99abce5d87d2119d7147a83b5cfba1db2667/package.json#L21-L60) | **学文档化 discovery 和“不要默认导出一切”。** |
| 7 | `ben-vargas/pi-packages` | 独立小包、每包 README；`pi-exa-mcp` 明确 CLI/env/project/global precedence。[root README L9-L24](https://github.com/ben-vargas/pi-packages/blob/e559b5f021798976a5ab3414995aadce457bd734/README.md#L9-L24)；[Exa README L96-L147](https://github.com/ben-vargas/pi-packages/blob/e559b5f021798976a5ab3414995aadce457bd734/packages/pi-exa-mcp/README.md#L96-L147) | “first match wins”来源太多；项目文件可包含 API key；缺配置时自动写全局默认文件，违背 side-effect-free load。[Exa README L100-L107](https://github.com/ben-vargas/pi-packages/blob/e559b5f021798976a5ab3414995aadce457bd734/packages/pi-exa-mcp/README.md#L100-L107) | **只学 precedence 文档格式，不学 secret/自动落盘。** |
| 8 | `narumiruna/pi-extensions` 根 package filtering（补充观察） | 推荐“install only what you need”，root git package 也给出 Pi filter 方法。[root README L9-L10](https://github.com/narumiruna/pi-extensions/blob/5e34d9ac004d7785bb1285b876f31cb2238d6e0b/README.md#L9-L10)；[root README L120-L140](https://github.com/narumiruna/pi-extensions/blob/5e34d9ac004d7785bb1285b876f31cb2238d6e0b/README.md#L120-L140) | 根仓库拥有大量独立包，若照搬到本项目会引入发布/版本治理成本。 | **当前无需拆成 monorepo。** |

> `ben-vargas/pi-packages` 在“可配置 setup”上弱于其他候选，因此只作为反例/局部参考；没有发现比 SuPi + narumiruna + Pi 官方组合更强、且与本项目目标更贴近的替代候选。

---

## 4. 按重点维度的机制比较

### 4.1 统一配置入口

**事实：**

- SuPi 将各扩展字段收集到单一 event-backed registry；重复 section ID 采用 last-wins 并产生 warning，而非悄悄覆盖。[`settings-registry.ts` L55-L76](https://github.com/mrclrchtr/supi/blob/1b61ce13050271de514c5a43b14efef7159477d5/packages/supi-core/src/settings/settings-registry.ts#L55-L76)
- `spences10/my-pi` 用静态 manifest 生成列表、CLI flags、aliases 和 lazy loaders；manager 同时展示“saved config”和“current process”。[`builtin-registry.ts` L15-L31](https://github.com/spences10/my-pi/blob/1e3fac4e45aed0998b123470329db17dd27de23b/src/extensions/builtin-registry.ts#L15-L31)；[`manager/index.ts` L42-L74](https://github.com/spences10/my-pi/blob/1e3fac4e45aed0998b123470329db17dd27de23b/src/extensions/manager/index.ts#L42-L74)
- `my-pi-setup` 已经坚持单一 command + 单一 typed tool；这是更小、更适合 package 的控制面。[当前 test L6-L18](https://github.com/tt-a1i/my-pi-setup/blob/3139b4b80800edb44d665cd6575093a3049727d2/extensions/setup/index.test.ts#L6-L18)

**建议：** 不引入 `/footer-settings`、`/summary-settings` 等新命令。把 SuPi 的“声明式字段元数据”和 my-pi 的“saved/effective inventory”压缩进现有 `/my-pi-setup`，由 no-argument flow 提供 Overview / Change / Doctor；模型仍解释自然语言，持久化仍只走最小 typed tool。

### 4.2 Global / project scope

**事实：**

- Pi 官方 scope 是可信基线：项目设置覆盖全局，且 project resources 在交互模式先询问 trust，非交互模式遵循 `defaultProjectTrust`。[官方 settings L3-L22](https://github.com/earendil-works/pi/blob/027a5847901b5dde30270abaa1041046cd2b4b55/packages/coding-agent/docs/settings.md#L3-L22)
- SuPi 的 UX 很好：显示 value source，Tab 切 scope，删除当前层 override 后继承 global/default。[SuPi README L27-L35](https://github.com/mrclrchtr/supi/blob/1b61ce13050271de514c5a43b14efef7159477d5/packages/supi-settings/README.md#L27-L35)；[`settings-schema.ts` L213-L240](https://github.com/mrclrchtr/supi/blob/1b61ce13050271de514c5a43b14efef7159477d5/packages/supi-core/src/settings/settings-schema.ts#L213-L240)
- `spences10/my-pi` 刻意把 trust 和敏感 extension state 留在 global store，不允许 repo 通过 `.pi/settings.json` 自我授权。[`pi-settings/README.md` L15-L26](https://github.com/spences10/my-pi/blob/1e3fac4e45aed0998b123470329db17dd27de23b/packages/pi-settings/README.md#L15-L26)

**建议：** 若增加 project scope，应按字段分类，而不是让整个 JSON 都可覆盖：

- 可 project override：footer layout/style、result display、workflow limits（仍受 hard cap）。
- global-only：未来 secrets、provider auth、跨项目 trust、可能产生额外费用的默认 model choice。
- 所有 project 读取必须通过 Pi trust 状态；UI/status 必须显示 `effective value + source`，并提供“继承”而非复制全量 global 配置。

### 4.3 Schema、validation、migrations

**事实：**

- `pi-statusline` 将诊断分为 unknown/invalid/parse/io；unknown 可保留并 warning，非法已知值阻止保存。[`settings.ts` L93-L107](https://github.com/narumiruna/pi-extensions/blob/5e34d9ac004d7785bb1285b876f31cb2238d6e0b/extensions/pi-statusline/src/settings.ts#L93-L107)；[`settings.ts` L141-L187](https://github.com/narumiruna/pi-extensions/blob/5e34d9ac004d7785bb1285b876f31cb2238d6e0b/extensions/pi-statusline/src/settings.ts#L141-L187)；[`settings.ts` L360-L375](https://github.com/narumiruna/pi-extensions/blob/5e34d9ac004d7785bb1285b876f31cb2238d6e0b/extensions/pi-statusline/src/settings.ts#L360-L375)
- `pi-sync` 使用明确 `version: 3`，拒绝旧 schema、混合 backend 字段、悬空引用与危险 secret/URL；不覆盖不支持的旧文档。[`config.ts` L254-L315](https://github.com/narumiruna/pi-extensions/blob/5e34d9ac004d7785bb1285b876f31cb2238d6e0b/extensions/pi-sync/src/config.ts#L254-L315)；[README L170-L180](https://github.com/narumiruna/pi-extensions/blob/5e34d9ac004d7785bb1285b876f31cb2238d6e0b/extensions/pi-sync/README.md#L170-L180)
- `spences10/my-pi` 的迁移会把旧文件移入 timestamp backup dir，并写 migration report。[`migrate.ts` L121-L155](https://github.com/spences10/my-pi/blob/1e3fac4e45aed0998b123470329db17dd27de23b/src/settings/migrate.ts#L121-L155)
- 当前 `my-pi-setup` 读失败直接返回 defaults，无法区分“不存在”和“损坏/无权限”。[`setup-config.ts` L400-L411](https://github.com/tt-a1i/my-pi-setup/blob/3139b4b80800edb44d665cd6575093a3049727d2/extensions/shared/setup-config.ts#L400-L411)

**建议：** 引入 `configVersion` 和 `loadSetupConfigResult = {config, source, diagnostics, rawDocument}`；缺文件才使用无警告 defaults，malformed/IO error 必须保留原文件并阻止写入，直到用户修复或显式 reset。迁移函数按版本逐步转换，保留 unknown top-level/section fields；不需要引入重型 schema 库，现有 TypeBox/手写 guard 已足够。

### 4.4 Interactive TUI 与 live preview

**事实：**

- Pi 官方 preset example 在切换前快照 model/thinking/tools，清除 preset 时恢复原状态。[`preset.ts` L101-L111](https://github.com/earendil-works/pi/blob/027a5847901b5dde30270abaa1041046cd2b4b55/packages/coding-agent/examples/extensions/preset.ts#L101-L111)；[`preset.ts` L270-L277](https://github.com/earendil-works/pi/blob/027a5847901b5dde30270abaa1041046cd2b4b55/packages/coding-agent/examples/extensions/preset.ts#L270-L277)
- `pi-statusline` 在 picker selection change 时仅 preview；finally 总会清掉 preview；只有 Enter 选中后才 save，apply 失败会 rollback。[`commands.ts` L181-L216](https://github.com/narumiruna/pi-extensions/blob/5e34d9ac004d7785bb1285b876f31cb2238d6e0b/extensions/pi-statusline/src/commands.ts#L181-L216)；[`commands.ts` L240-L267](https://github.com/narumiruna/pi-extensions/blob/5e34d9ac004d7785bb1285b876f31cb2238d6e0b/extensions/pi-statusline/src/commands.ts#L240-L267)
- `pi-tui-kit` 已把 serialized save、rollback、cancel、stale continuation 和 TUI/RPC adaptation 做成标准契约。[TUI kit L97-L148](https://github.com/narumiruna/pi-extensions/blob/5e34d9ac004d7785bb1285b876f31cb2238d6e0b/packages/pi-tui-kit/README.md#L97-L148)

**建议：** 以后为 footer 做 deterministic preview picker，但不替换自然语言入口：模型识别“我要预览 footer”后打开 package-owned TUI；Up/Down 只改 runtime preview，Enter 原子保存，Escape 恢复 saved config。不要先做一个通用 TUI framework；现有设置数量不足以证明该抽象必要。

### 4.5 Presets / profiles

**事实：**

- 官方 example preset 可组合 provider/model/thinking/tools/instructions，并支持 CLI flag、slash command、快捷键和 session state。[`preset.ts` L1-L10](https://github.com/earendil-works/pi/blob/027a5847901b5dde30270abaa1041046cd2b4b55/packages/coding-agent/examples/extensions/preset.ts#L1-L10)；[`preset.ts` L352-L390](https://github.com/earendil-works/pi/blob/027a5847901b5dde30270abaa1041046cd2b4b55/packages/coding-agent/examples/extensions/preset.ts#L352-L390)
- `pi-statusline` 的 information profiles 只替换 `segments`，保留其他/未知字段，是“窄 preset”范例。[statusline README L38-L59](https://github.com/narumiruna/pi-extensions/blob/5e34d9ac004d7785bb1285b876f31cb2238d6e0b/extensions/pi-statusline/README.md#L38-L59)

**建议：** profile 应当是“有明确工作流价值的稀疏 patch”，不是整个 config snapshot。候选名称可为 `minimal`、`balanced`、`multi-agent`，但只有在用户反复同时切换 3 个以上字段后再实现。不要把具体 provider/model 写进内置 profile；model 应继承当前 Pi 或由用户显式选择。

### 4.6 Feature discovery / doctor

**事实：**

- `spences10/my-pi` 的 manager 显示每项 key、说明、saved state、effective state、CLI override；支持 search。[`manager/index.ts` L42-L91](https://github.com/spences10/my-pi/blob/1e3fac4e45aed0998b123470329db17dd27de23b/src/extensions/manager/index.ts#L42-L91)；[`manager/index.ts` L192-L240](https://github.com/spences10/my-pi/blob/1e3fac4e45aed0998b123470329db17dd27de23b/src/extensions/manager/index.ts#L192-L240)
- SuPi debug 可输出 observed registered tools、active tools、commands 的 versioned inventory marker，同时避免把诊断作为 LLM-visible user message。[`status-log.ts` L15-L55](https://github.com/mrclrchtr/supi/blob/1b61ce13050271de514c5a43b14efef7159477d5/packages/supi-debug/src/status-log.ts#L15-L55)
- `pi-sync doctor` 不只读配置，还验证 backend 并明确其副作用边界；WebDAV doctor 用 isolated probe 验证 conditional write。[pi-sync README L188-L212](https://github.com/narumiruna/pi-extensions/blob/5e34d9ac004d7785bb1285b876f31cb2238d6e0b/extensions/pi-sync/README.md#L188-L212)；[README L222-L224](https://github.com/narumiruna/pi-extensions/blob/5e34d9ac004d7785bb1285b876f31cb2238d6e0b/extensions/pi-sync/README.md#L222-L224)

**建议：** 在现有 `/my-pi-setup` 无参数流程中增加只读 doctor 数据：config path/version/source、diagnostics、每个 package-owned feature 的 configured/effective 状态、依赖可用性、summary model 是否仍在 registry、哪些资源应通过 `pi config` 管理。默认 doctor 不联网、不调用模型、不写文件；若用户要求模型解释，再把结构化结果交给当前模型。

### 4.7 Package filtering / extension toggle

**事实：**

- Pi 原生 object package entry 已完整定义资源 filter，并用 Tab 切 global/project；project entry 可作为 global package 的 delta。[官方 `packages.md` L190-L228](https://github.com/earendil-works/pi/blob/027a5847901b5dde30270abaa1041046cd2b4b55/packages/coding-agent/docs/packages.md#L190-L228)
- `dot314`、`dot-pi` 都把 optional resources 交给原生 package filter，而不是在自有 JSON 再做一遍。[dot314 README L42-L74](https://github.com/w-winter/dot314/blob/073a99abce5d87d2119d7147a83b5cfba1db2667/README.md#L42-L74)；[dot-pi README L282-L286](https://github.com/dannote/dot-pi/blob/68aebfddc297eab2f467d680421995e07a3565a6/README.md#L282-L286)

**建议：** `my-pi-setup` 应维护一个只读 feature catalog（id、label、kind、default、restart/reload requirement、dependencies），但资源是否装载仍由 `pi config` 决定。对于已加载扩展内部的 runtime behavior（recap、footer、header）才继续写 `my-pi-setup.json`。这样避免“Pi filter 说 disabled，但 package config 又说 enabled”的双真相源。

### 4.8 Secrets 与 model selection

**事实：**

- `pi-sync` 把 credential 放在 private global file，POSIX `0600`，菜单/status/error/log 只显示 masked/presence，不显示值。[README L43-L65](https://github.com/narumiruna/pi-extensions/blob/5e34d9ac004d7785bb1285b876f31cb2238d6e0b/extensions/pi-sync/README.md#L43-L65)
- `ben-vargas/pi-exa-mcp` 允许 API key 出现在 project config，且缺配置时自动写 global defaults；这是不应采用的组合。[Exa README L38-L45](https://github.com/ben-vargas/pi-packages/blob/e559b5f021798976a5ab3414995aadce457bd734/packages/pi-exa-mcp/README.md#L38-L45)；[Exa README L100-L107](https://github.com/ben-vargas/pi-packages/blob/e559b5f021798976a5ab3414995aadce457bd734/packages/pi-exa-mcp/README.md#L100-L107)
- 当前 `my-pi-setup` 不持有 API key，model selection 使用 Pi registry，这是更小的 trust boundary。[当前 `index.ts` L185-L203](https://github.com/tt-a1i/my-pi-setup/blob/3139b4b80800edb44d665cd6575093a3049727d2/extensions/setup/index.ts#L185-L203)

**建议：** 继续不存 provider secrets；未来若必须存 package secret，只允许 global private file + masked TUI + no-log，且排除 project scope/export。model profile 不硬编码 provider/model；保存前验证 registry，doctor 再验证“配置的 model 当前是否仍存在”。

### 4.9 Portability / sync

**事实：**

- `pi-sync` 支持 allowlisted Pi roots、自定义安全相对路径、secret scanning、immutable snapshot、conflict check、backup、transaction journal 和 startup recovery。[README L8-L15](https://github.com/narumiruna/pi-extensions/blob/5e34d9ac004d7785bb1285b876f31cb2238d6e0b/extensions/pi-sync/README.md#L8-L15)；[`snapshot-transaction.ts` L26-L68](https://github.com/narumiruna/pi-extensions/blob/5e34d9ac004d7785bb1285b876f31cb2238d6e0b/extensions/pi-sync/src/snapshot-transaction.ts#L26-L68)

**建议：** 当前不做远端 sync。以后先提供 `export`/`import preview` 的纯 JSON patch：带 schema version、去除 secrets、列出 diff、显式确认后应用。若用户真的需要多机同步，优先让独立 sync package 管理，而不是把网络 backend 嵌进 setup 核心。

### 4.10 Safe defaults / rollback

**事实：**

- `dot-pi` 将实验、个人、平台相关和需凭证资源排除在默认 manifest 外。[README L282-L308](https://github.com/dannote/dot-pi/blob/68aebfddc297eab2f467d680421995e07a3565a6/README.md#L282-L308)
- `pi-statusline` 缺文件时不创建文件；非法文件不覆盖；apply 失败恢复旧设置。[README L117-L166](https://github.com/narumiruna/pi-extensions/blob/5e34d9ac004d7785bb1285b876f31cb2238d6e0b/extensions/pi-statusline/README.md#L117-L166)；[`commands.ts` L595-L625](https://github.com/narumiruna/pi-extensions/blob/5e34d9ac004d7785bb1285b876f31cb2238d6e0b/extensions/pi-statusline/src/commands.ts#L595-L625)
- 当前 `my-pi-setup` recap 默认 off，符合“额外模型调用必须 opt-in”；但 loader 把损坏配置静默降为 defaults。[`setup-config.ts` L129-L144](https://github.com/tt-a1i/my-pi-setup/blob/3139b4b80800edb44d665cd6575093a3049727d2/extensions/shared/setup-config.ts#L129-L144)；[`setup-config.ts` L404-L411](https://github.com/tt-a1i/my-pi-setup/blob/3139b4b80800edb44d665cd6575093a3049727d2/extensions/shared/setup-config.ts#L404-L411)

**建议：** 保持 opt-in 默认；把“缺文件”和“坏文件”分开。持久化和 runtime apply 组成一个事务：validate → write candidate → apply → 成功确认；apply 失败时只在文件 identity 仍匹配 candidate 时恢复旧文档，避免覆盖并发新写入。

### 4.11 Tests

**事实：**

- SuPi 对 source precedence、typed parsing、duplicate registry diagnostics 做单元测试。[`settings-schema.test.ts` L15-L54](https://github.com/mrclrchtr/supi/blob/1b61ce13050271de514c5a43b14efef7159477d5/packages/supi-core/__tests__/unit/settings/settings-schema.test.ts#L15-L54)；[`settings-registry.test.ts` L21-L48](https://github.com/mrclrchtr/supi/blob/1b61ce13050271de514c5a43b14efef7159477d5/packages/supi-core/__tests__/unit/settings/settings-registry.test.ts#L21-L48)
- `pi-sync` 对 version schema、悬空引用、混合字段、危险路径、duplicate remote、secret redaction 和 byte-for-byte preservation 有针对性测试。[`v3-schema.test.ts` L51-L135](https://github.com/narumiruna/pi-extensions/blob/5e34d9ac004d7785bb1285b876f31cb2238d6e0b/extensions/pi-sync/test/v3-schema.test.ts#L51-L135)；[`v3-schema.test.ts` L216-L239](https://github.com/narumiruna/pi-extensions/blob/5e34d9ac004d7785bb1285b876f31cb2238d6e0b/extensions/pi-sync/test/v3-schema.test.ts#L216-L239)
- 当前项目 scripts 已有 `check`、`format:check`、`test`，但 setup command test 主要验证注册和 prompt 文案。[当前 `package.json` L35-L40](https://github.com/tt-a1i/my-pi-setup/blob/3139b4b80800edb44d665cd6575093a3049727d2/package.json#L35-L40)；[`setup/index.test.ts` L6-L61](https://github.com/tt-a1i/my-pi-setup/blob/3139b4b80800edb44d665cd6575093a3049727d2/extensions/setup/index.test.ts#L6-L61)

**建议：** 新增最小 storage contract suite：missing file side-effect-free、valid/malformed/invalid、unknown preservation、v0→v1 migration、`0600`、atomic rename failure、concurrent replacement preservation、runtime apply rollback、global/project precedence+trust、doctor redaction。无需引入新 test framework。

---

## 5. Ranked adoption list

### 立即做

1. **P0 — Versioned config document 与结构化 diagnostics。**
   - 增加 `configVersion`；loader 返回 `source/path/diagnostics/rawDocument`。
   - 仅缺文件可静默 defaults；parse/IO/invalid 进入可见诊断，禁止覆盖坏文件。
   - 保留未知字段，非法已知字段阻止 save。
   - 依据：`pi-statusline` diagnostics/save contract。[`settings.ts` L93-L107](https://github.com/narumiruna/pi-extensions/blob/5e34d9ac004d7785bb1285b876f31cb2238d6e0b/extensions/pi-statusline/src/settings.ts#L93-L107)；[`settings.ts` L360-L400](https://github.com/narumiruna/pi-extensions/blob/5e34d9ac004d7785bb1285b876f31cb2238d6e0b/extensions/pi-statusline/src/settings.ts#L360-L400)
2. **P0 — 保存 + runtime apply rollback。**
   - 保持临时文件+rename+`0600`；增加 candidate identity 和 compare-before-rollback。
   - 配置事件/apply 失败时恢复旧文档和旧 runtime，不覆盖并发新版本。
   - 依据：`pi-statusline` identity-aware rollback。[`settings.ts` L403-L434](https://github.com/narumiruna/pi-extensions/blob/5e34d9ac004d7785bb1285b876f31cb2238d6e0b/extensions/pi-statusline/src/settings.ts#L403-L434)；[`commands.ts` L816-L843](https://github.com/narumiruna/pi-extensions/blob/5e34d9ac004d7785bb1285b876f31cb2238d6e0b/extensions/pi-statusline/src/commands.ts#L816-L843)
3. **P0 — 在 `/my-pi-setup` 内加入只读 Doctor / Inventory。**
   - 输出 schema/version/source/path、diagnostics、saved/effective feature、model resolvability、reload requirement。
   - 不新增用户命令，不联网、不写配置、不调用模型作为默认实现。
   - 依据：my-pi saved/effective 状态与 SuPi observed inventory。[my-pi manager L42-L74](https://github.com/spences10/my-pi/blob/1e3fac4e45aed0998b123470329db17dd27de23b/src/extensions/manager/index.ts#L42-L74)；[SuPi status L27-L55](https://github.com/mrclrchtr/supi/blob/1b61ce13050271de514c5a43b14efef7159477d5/packages/supi-debug/src/status-log.ts#L27-L55)
4. **P1 — 明确资源 filter ownership。**
   - `/my-pi-setup` 只解释/检测；extension/skill/theme 的 load/unload 引导到 Pi 原生 `pi config`。
   - package-owned runtime toggle 继续由 typed setup config 管理。
   - 依据：Pi 官方 `pi config` scope/filter。[`packages.md` L190-L228](https://github.com/earendil-works/pi/blob/027a5847901b5dde30270abaa1041046cd2b4b55/packages/coding-agent/docs/packages.md#L190-L228)
5. **P1 — 补 storage/migration/rollback tests。**
   - 优先覆盖数据丢失和错误可观察性，不扩测试框架。
   - 依据：`pi-sync` byte-preservation tests。[`v3-schema.test.ts` L216-L239](https://github.com/narumiruna/pi-extensions/blob/5e34d9ac004d7785bb1285b876f31cb2238d6e0b/extensions/pi-sync/test/v3-schema.test.ts#L216-L239)

### 以后做

1. **受 trust 约束的 project scope。** 用 defaults ← global ← trusted project；UI 显示来源并支持 inherit。先只开放无 secret、低风险字段。[Pi trust L12-L22](https://github.com/earendil-works/pi/blob/027a5847901b5dde30270abaa1041046cd2b4b55/packages/coding-agent/docs/settings.md#L12-L22)；[SuPi source UI L27-L35](https://github.com/mrclrchtr/supi/blob/1b61ce13050271de514c5a43b14efef7159477d5/packages/supi-settings/README.md#L27-L35)
2. **Footer deterministic TUI + live preview。** 复用现有 `/my-pi-setup` 入口；preview 不落盘，Enter commit，Escape restore。[statusline picker L240-L267](https://github.com/narumiruna/pi-extensions/blob/5e34d9ac004d7785bb1285b876f31cb2238d6e0b/extensions/pi-statusline/src/commands.ts#L240-L267)
3. **稀疏 setup profiles。** 仅当真实使用证明经常联动多个字段；profile 不含硬编码 model/provider，支持恢复原 runtime state。[官方 preset L101-L111](https://github.com/earendil-works/pi/blob/027a5847901b5dde30270abaa1041046cd2b4b55/packages/coding-agent/examples/extensions/preset.ts#L101-L111)
4. **可移植 export/import preview。** 先本地、去 secret、带 diff 和 schema version；远端 sync 保持独立产品边界。[pi-sync allowlist/safety L160-L168](https://github.com/narumiruna/pi-extensions/blob/5e34d9ac004d7785bb1285b876f31cb2238d6e0b/extensions/pi-sync/README.md#L160-L168)
5. **声明式内部字段 catalog。** 当 package-owned 设置跨到 3 个以上独立 extension owner 时，再引入类似 SuPi contribution registry；当前可先用静态 metadata 数组，避免 event-bus 过度抽象。[SuPi registry L14-L33](https://github.com/mrclrchtr/supi/blob/1b61ce13050271de514c5a43b14efef7159477d5/packages/supi-core/src/settings/settings-registry.ts#L14-L33)

### 不做

1. **不新增 extension-specific setup 命令。** 保持 `/my-pi-setup` 单入口；SuPi/my-pi 的独立命令适合它们的 distribution/monorepo，不适合本项目契约。[当前 command contract `SETUP.md` L26-L45](https://github.com/tt-a1i/my-pi-setup/blob/3139b4b80800edb44d665cd6575093a3049727d2/SETUP.md#L26-L45)
2. **不复制 Pi package filtering。** 不在 `my-pi-setup.json` 再建 extensions/skills/themes include/exclude；Pi 已有唯一真相源。[官方 filtering L190-L220](https://github.com/earendil-works/pi/blob/027a5847901b5dde30270abaa1041046cd2b4b55/packages/coding-agent/docs/packages.md#L190-L220)
3. **不把 secrets 放进 project config 或可同步 profile。** 继续委托 Pi provider auth；任何未来 package secret 只允许 global private store。[pi-sync secret contract L59-L67](https://github.com/narumiruna/pi-extensions/blob/5e34d9ac004d7785bb1285b876f31cb2238d6e0b/extensions/pi-sync/README.md#L59-L67)
4. **不在读取或安装时自动生成配置。** 缺文件应只是 built-in defaults；反例是 Exa package 的自动写 default config。[Exa README L100-L107](https://github.com/ben-vargas/pi-packages/blob/e559b5f021798976a5ab3414995aadce457bd734/packages/pi-exa-mcp/README.md#L100-L107)
5. **不把 pi-sync 的完整跨进程锁/远端 backend/journal 搬进本地 setup。** 只借鉴 identity-aware rollback 和 migration safety；复杂度应与数据损失风险匹配。[pi-sync backend/recovery L214-L228](https://github.com/narumiruna/pi-extensions/blob/5e34d9ac004d7785bb1285b876f31cb2238d6e0b/extensions/pi-sync/README.md#L214-L228)
6. **不硬编码默认 provider/model，不在首次 setup 前发模型调用。** 当前 recap 默认 off、model 由 registry 验证的方向正确。[当前 defaults L129-L144](https://github.com/tt-a1i/my-pi-setup/blob/3139b4b80800edb44d665cd6575093a3049727d2/extensions/shared/setup-config.ts#L129-L144)；[当前 model validation L185-L203](https://github.com/tt-a1i/my-pi-setup/blob/3139b4b80800edb44d665cd6575093a3049727d2/extensions/setup/index.ts#L185-L203)

---

## 6. 推荐的目标形态（非实现方案）

```text
/my-pi-setup
  ├─ Overview: 当前 effective config + source + impact
  ├─ Change: 自然语言 → 最小 typed mutation
  ├─ Preview: 仅对有视觉收益的字段，runtime-only preview
  ├─ Doctor: config/version/diagnostics/feature/model/resource inventory
  └─ Portability（以后）: export/import preview

Storage
  defaults
    ↓
  global document (private, versioned)
    ↓
  trusted project sparse overrides（以后，仅安全字段）
    ↓
  runtime preview/explicit session override
```

关键边界：

- **Pi owns resource loading**：packages/extensions/skills/prompts/themes 与 project trust。
- **my-pi-setup owns package behavior**：recaps、workflow limits、UI/footer、result display。
- **Pi owns provider auth**：setup 只保存经过 registry 验证的 model reference。
- **storage owns durability；runtime owns apply**：二者以可回滚 transaction 连接，不互相吞错。
- **facts 与 recommendations 分离**：doctor 输出事实；当前模型可基于事实解释和建议，但不能成为配置真相源。

这条路线保留了 `my-pi-setup` 当前最有价值的“小 typed state + 自然语言单入口”，同时吸收 SuPi 的统一发现、narumiruna 的安全事务、Pi 官方的 scope/filter，以及 spences10 的 saved/effective inventory，而不引入它们各自不适合本项目的规模和复杂度。
