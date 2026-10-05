# 搜索输出成本与 FFF：确定性配对调查

- Status: validated at frozen tool-output/source boundaries; model-task benefit remains unknown.
- Created / verified: 2026-10-05（Asia/Taipei）。
- Related Issue: [#686](https://github.com/openpi-dev/openpi/issues/686)。
- Supersedes: none；本记录不采纳新的默认工具或项目约束。
- Evidence identity: `openpi-search-20261005-t5f8XA`，本地可检索目录 `/Users/tushaokun/work/openpi-evidence/search-20261005-t5f8XA/`。原始输出、冻结公开源码、脚本和依赖锁均在仓库外；`manifest.json` 保存实验文件 SHA256 和大小；`manifest-final.json` 追加分发源码及最终报告身份。

## 当前是否存在风险

已读取 README 的运行时来源要求，并核查 `pi list`：唯一 OpenPI 来源是本地安装 checkout，HEAD `331327e590c63769fb0f7ce99d03b2ddfd4145c0`，包含其他未提交修改，保持原状。本次实验显式使用另一份冻结公开源码，不声称正在运行的 Session 已加载实验代码。

本机 Pi 1.0.2 原生 grep 使用 `rg --json --line-number --color=never --hidden`，遵守 ignore 规则，默认100个匹配行、50KiB输出正文上限、单行500字符；支持主动指定 path/glob/limit，没有 cursor。默认普通工具是 read/bash/edit/write；个人设置含 `defaultTools: ["+codemode"]`。实际会话可以改变工具选择，因此这些设置不能证明某个正在运行的会话是否调用了 grep。OpenPI 的 compact renderer 不修改模型结果，不构成 Context 压缩。[安装包元数据](https://registry.npmjs.org/@earendil-works/pi-coding-agent/1.0.2)；对应分发源码冻结于证据目录的 `native-grep.js`

Code Mode 也不能一概视为“原样灌入”：脚本可选择只 `text()` 一小部分结果。本机原生 Code Mode 默认对打印输出设置10,000个估算token的预算（每token按4字符计算），超额保留头尾并写出完整文件。这是字符预算和模型主动投影，不能提供 grep 的按文件分页、检索完备性或相关性保证。分发源码冻结于同目录 `native-codemode-execute.js`，与安装包1.0.2及manifest hash对应

因此，当前存在的是**宽泛查询返回过多模型可见内容的风险**，不是“每次固定消耗50KB”或“已证明模型精度下降”。原生 path/glob/limit 和 Code Mode 投影已有收窄机制，但需要模型选择使用；现有 UI 优化没有改变这层语义。

## 冻结与方法

| 身份 | 实际值 |
| --- | --- |
| OpenPI 公开源码 | main `3cb2ecfe1bfbb98252651885311d309f83749428` 的 Git archive；不含用户 dirty/ignored 文件 |
| Pi | 本机1.0.2，npm gitHead `cd32f7725fdbddbaecdff5b1e68491563394e0ca`，原生 grep 源文件hash在manifest |
| FFF | 隔离 npm `@ff-labs/pi-fff@0.11.0`；wrapper gitHead `95fd777c2529fc7b4d7572dabff64cc07268f2c5`；依赖锁保留 |
| Host | Node26.8.1、macOS arm64、PATH ripgrep15.2.0；完整元数据在results |
| 模型 / thinking | N/A：实验没有模型回合或provider请求；分析写作不属于试验调用统计 |
| Verifier | 独立逐文件逐行、大小写敏感的字面串 includes；核对匹配的文件+行号集合 |
| 隔离 | 临时 agent directory、独立frecency/history DB、公开Git快照和人工fixture；未执行 `pi install` 或修改个人配置 |
| 成本 | 输出正文bytes/chars、取全所需tool calls、首调用和3个warm调用时间；不是实际provider token账单 |

比较四种调用：原生默认、原生limit20、原生提高limit的可恢复性探针、FFF默认并穷尽其cursor。对比参数保持意图一致；真实仓库的正式范围使用原生 `path: extensions/` 加 `glob: **/*.ts`，FFF使用 `path: extensions/**/*.ts`，verifier也只接受同一组TypeScript文件。调用文本和schema并非相同，不能称为request-identical模型实验。

脚本保留全部原始tool results。FFF分页设置100页保护，接受的案例均自然结束，没有撞保护。v1 pilot未归一化原生相对路径，不能用于真实仓库漏检指标；v3的TS glob与Markdown范围也不相同，不能把4条Markdown排除算成FFF漏检。二者都保留为harness失败/范围修正证据，真实仓库结论使用v4。接受的fixture使用v2；长上下文使用v3。

## 实测结果

“累计”只指实际取回的页面正文；遗漏结果时，不能用累计更小宣称同等检索成本降低。

| 固定任务 | 原生默认 | FFF默认与继续分页 | 结论 |
| --- | --- | --- | --- |
| 33条TODO，30条集中一文件 | 33条、809B、1次 | 首屏32条/582B；累计33条/607B、2次 | 首屏条数只少1，分组节省约25%累计字节；并非“少80%”，调用增加 |
| 一文件300条，另一文件1条 | 首屏100条；提高limit可301条/8,332B/1次 | 首屏200条；两页共201条，漏100条，无后续cursor | 完备性退化：更低输出来自遗漏，不能与完整结果等价 |
| 60个文件，各1条NEEDLE | 60条/1,369B/1次 | 首屏20条/521B；累计60条/1,550B/3次 | 首屏约少62%，累计反而多约13%，多2次调用 |
| OpenPI同范围57条AgentSession | 57条/4,427B/1次 | 首屏27条/1,572B；累计57条/3,337B/3次；无漏/多余 | 有条件收益：首屏约少65%，累计约少25%；调用增加 |
| 同一密集fixture，收窄到目标文件 | 1条/40B/1次 | 1条/41B/1次 | 主动收窄原生查询已能解决噪音；不能全归功于换后端 |
| 60条长匹配，context20 | 约50KiB正文加截断提示；正文保留5个匹配中心 | 60个匹配中心，单响应1,038,142B | FFF没有同等硬字节预算；取全与Context成本存在明显取舍 |

真实仓库3个查询在对齐范围后，FFF与原生取全集均一致（5、3、57条）。warm首屏查询3次中位数约为FFF0.45–1.90ms、原生14.55–17.51ms，说明本机已索引后的工具调用可以更快；不能推断模型端到端任务更快。FFF隔离loader/session/index启动另有成本：首次smoke约1.10s，后续独立Session约94–679ms（含679ms的长上下文fixture）；这些包含loader/session开销，不是纯扫描时间。调用顺序未随机化，样本很少，不作统计显著性或大仓性能声明。verifier仅覆盖当前固定文件名、字面串及TS范围，未实现通用ignore/glob/symlink合同；当前文件名没有空格、前导空格或cursor文本，输出解析并非通用解析器。

## 搜索语义与负收益证据

- FFF页大小是软上限，会完成当前文件；每文件最多200个匹配，cursor按文件offset前进。本次301条案例独立确认了100条不能从后续页恢复。源码没有把“无cursor”转成完备性保证。[wrapper](https://github.com/dmtrKovalenko/fff/blob/95fd777c2529fc7b4d7572dabff64cc07268f2c5/packages/pi-fff/src/index.ts)，[engine](https://github.com/dmtrKovalenko/fff/blob/95fd777c2529fc7b4d7572dabff64cc07268f2c5/crates/fff-core/src/grep/grep.rs)
- `extensions/`是任意层级目录segment，不是仓库根prefix，因此也包括 `tests/extensions/`。这是核心预期语义，但wrapper描述“Directory prefix”有歧义；不能把多出的范围称为模型false-positive。本次改用显式glob重新对齐。[query builder](https://github.com/dmtrKovalenko/fff/blob/95fd777c2529fc7b4d7572dabff64cc07268f2c5/packages/pi-fff/src/query.ts)，[constraint matcher](https://github.com/dmtrKovalenko/fff/blob/95fd777c2529fc7b4d7572dabff64cc07268f2c5/crates/fff-core/src/index/constraints.rs)
- 原生 `literal:true` 的 `a.b`只返回字面串；FFF自动识别regex，同时返回`axb`。原生零命中`settlePayment`；FFF追加明确标为“0 exact matches”的近似`settlePaymnt`。这是不同搜索合同，不能把近似结果当精确命中证明。[mode与fuzzy fallback](https://github.com/dmtrKovalenko/fff/blob/95fd777c2529fc7b4d7572dabff64cc07268f2c5/packages/pi-fff/src/index.ts)
- 不存在的FFF cursor实测静默回到第一页；源码cursor仅保存文件offset，没有query/index revision绑定。跨查询或索引变动分页的完整性尚未实测，不能声称稳定snapshot分页。[cursor store](https://github.com/dmtrKovalenko/fff/blob/95fd777c2529fc7b4d7572dabff64cc07268f2c5/packages/pi-fff/src/index.ts)
- FFF扫描等待15秒超时也会返回picker，未在每次grep输出标明索引是否完整。本次小fixture和公开快照没有复现超时，因此这条是源码风险，不是已观察失败。[picker factory](https://github.com/dmtrKovalenko/fff/blob/95fd777c2529fc7b4d7572dabff64cc07268f2c5/packages/pi-fff/src/file-picker.ts)

## 判断与下一层验证

**有输出风险，也有可用的收窄方式；现有证据不支持默认用FFF替换原生搜索。** 已观察到的工具层收益是分组减少重复路径、首屏更小、warm工具调用更快；工具层代价包括漏检、累计输出与调用增加、长上下文缺乏硬字节预算，以及搜索语义变化。尚未证明个人frecency/Git排序能把任务真正相关的目标放到首屏；fresh DB不代表真实使用后的排名。

候选机制优先是：模型可见的有界正文、文件级摘要、真实的截断/未完备提示和可继续取证。模型仍选择搜索范围、查询和策略，runtime只执行明确资源和正确性合同。原生收窄查询作为重要对照，不引入固定关键词路由或规定先后步骤。此处是建议，未成为Decision，也未实施产品默认。

工具层通过后才有理由做模型任务A/B：冻结同一provider/channel、模型/thinking、任务快照和独立验收器；限制同样总预算；记录真实输入/输出/cache计费、总回合、端到端时间、错误修改、遗漏与最终验收通过率。工具schema和提示变化也应记录，不能只比较输出字节。至少覆盖定位关键文件、找全调用点、确认“不存在”、跨目录修改及最终测试通过；任何遗漏、超预算、语义不兼容均单独分类。**本记录没有验证模型精度或实际账单收益。**
