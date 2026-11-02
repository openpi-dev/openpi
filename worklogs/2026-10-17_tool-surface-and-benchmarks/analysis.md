# 分析汇总：工具面冻结、跑分与 Fusion 评估（2026-10-17 至 2026-10-24）

本文是 lead agent 在这段会话里的分析结论汇总，按主题整理，不是受治理的正式记录。正式结论以 `docs/decisions/0005-frozen-tool-surface.md` 和 `docs/benchmarks/` 下的记录为准。原始跑分证据在私有归档仓 `tt-a1i/openpi-bench-archive`，下文用 `runs/<目录>` 引用。

每节都区分**事实**（有数据或代码依据）和**推断/建议**。

## 1. 起点：动态加载工具会破坏缓存

用户最初的设想是：初始工具集尽量小，用户用到时按关键字动态加载能力组，这样大部分用户的体验接近原生 Pi。

**事实**
- 第一轮跑分（`runs/2026-10-17_round1_openpi-vs-opencode`，OpenPI npm 0.10.0，deepseek-v4.1-flash）缓存命中率约 69%，opencode 约 92%。
- 根因是会话中途 `toolsAdded` 改变了模型可见的工具列表，打断了 prompt 前缀缓存。

**决定**（Issue #879，Decision 0005）
- 放弃关键字触发的动态加载。会话开始时固定工具面，之后不因关键字或运行状态而变化。
- 删除冗余工具（后台终端、tasks、goal 等），Code Mode 默认关闭，去掉 Pi 原生没有的删除保护。
- 子代理和 workflow 工具保留常驻，原因是部分用户需要；未使用时的代价是常驻前缀，约 10%。

**验证**
- `runs/2026-10-18_661b2bc_drop-bg`：首轮 prompt 中位数从 6562 降到 3816 token；kv-store k=3 从 0/4 变成 3/3。原来的失败原因是后台进程生命周期，与缓存无关。
- `runs/2026-10-19_..._threeway-v2-k2-prebuilt`：20/20 个 OpenPI trial 工具数恒为 12，每个 trial 只有 1 个系统提示哈希，缓存完全未命中 0 次。

## 2. 跑分总览：OpenPI 对纯 Pi

| 跑分 | 模型 | 通过（OpenPI / 纯 Pi） | 效率 |
| --- | --- | --- | --- |
| frozen 7413c2a，k=1 | deepseek-flash high | 9/10 对 8/10 | — |
| threeway，k=2 | deepseek-flash high | 18/19 对 19/20（排除 1 次 infra） | 折算成本中位数持平 |
| threeway-v2，k=2 | deepseek-flash xhigh | 19/20 对 20/20 | OpenPI 逐对中位比 1.26，20 对中只有 5 对更便宜 |
| output-gap，k=5 | deepseek-flash xhigh | 20/20 对 20/20 | OpenPI 输出更多 14/20 对，中位比 1.158，Wilcoxon p=0.027 |
| Kimi 五题单次 | kimi-1021-preview high | 1/5 对 2/5 | — |
| Kimi HTML 重复 | kimi-1021-preview high | 2/4 对 2/3 | 请求数中位 33.5 对 21 |

**推断**：正确率没有可区分的差距；效率上有一个多轮方向一致的小差距，OpenPI 多 15% 到 25% 的输出或成本。见第 8 节。

## 3. Bash 默认超时（#885）

**事实**（`runs/2026-10-19_..._bash-timeout-regression`，commit `6f43b7c`）：40 个 trial、323 次 bash 调用，120 秒默认超时一次都没触发，没有命令被杀。

**结论**：对 TB10 这类常规题无害，可以发版。

## 4. 委派价值跑分（"B 轮"）

**事实**（`runs/2026-10-20_deepseek-v4.1-flash_delegation-value`）
- 18 个 trial 全部答对。N16 是 16 道互相独立、分布在十几个模块里的查找题。
- 明确要求委派时：墙钟中位比 1.60，折算总成本比 3.40。
- 不提示时，0/3 次主动委派；成本是纯 Pi 的 1.09 倍，与约 10% 的常驻前缀一致。
- 只算父会话自己的花费，委派时中位 73.9k，单干是 63.3k，父会话的开销并没有因为委派而下降。

**推断**
- 每个子任务只是秒级的查找，子代理从零摸索仓库的开销远大于并行省下的时间。
- 不委派是模型判断正确，不是缺陷。
- 这轮测的是"同一个模型并行"，不能用来评价"贵模型规划、便宜模型执行"的组合。

## 5. 子代理不再加载编排类 skill（#888）与 1.1.0 发版

**事实**
- 子代理只有 read、bash、edit、write 四个工具，`<available_skills>` 里却列着 subagents 和 workflows 两个 skill。24 个归档子会话里没有一个去读这两个 skill。
- 修法：skill 加载后再按规范路径过滤，软链接也覆盖到；git-info 是会执行代码的扩展，所以仍在加载前排除。最终 +147/−1，合并于 `35c70cc7`。
- 1.1.0：版本 PR #889（`e799a9b8`），tag `v1.1.0`，npm 发布成功。包含的内容有 bash 默认超时、子代理消耗显示（不显示价格，#887）和这次的 skill 过滤。

## 6. Fusion 与相关模式

**Cognition Fusion 原文**（cognition.com/blog/local-fusion）的要点：前沿模型当 lead，负责规划、审查和面向用户；便宜模型当常驻副手，负责执行；双方只交换 brief、结果和反馈，各自保住缓存。原文说法是"最高省 39%"；10-19 更新的数据是 Opus 5.5 + GPT-6 Luna 得分 68.1、成本低 31%；表中各项降幅在 11% 到 46% 之间。

**和其他模式的对比**

| | Claude Code advisor | 普通子代理 | Fusion |
| --- | --- | --- | --- |
| 主导者 | 便宜模型 | 父会话 | 贵模型 |
| 谁决定何时用对方 | 便宜模型 | 父模型，默认倾向少委派 | 规则要求默认委派实现 |
| 对方看到的上下文 | 完整对话 | brief | brief |
| 对方能否动手 | 不能调用工具 | 能 | 能 |
| 生命周期 | 每次咨询独立推理 | 一般做完就扔 | 整个会话常驻 |

**推断**
- 机制上，Fusion 就是"不同模型 + 常驻上下文 + 分工规则"的子代理。OpenPI 已有角色模型（`subagents.roleModels`）和 `subagent_send`，零代码就能搭出来。
- Fusion 的价值主张是经验性的：规则要能让 lead 真的少花钱。B 轮的数据说明，这件事不会自动发生。

**原型**（`protocols/fusion-proto/`）：lead 用 gpt-6.1-sol，sidekick 用 deepseek-flash；分 solo、fusion、noguide 三组；按标价计费；判定标准跑前定死，lead 自己的花费中位比必须 ≤0.7。**尚未运行**，需要 gpt-6.1-sol 凭据。如果最后要做成产品，必须做成显式开启的 `/fusion` 模式，并写一份 Decision 说明它为何是"编排交给模型自己判断"这一原则的例外。

## 7. Kimi 对照诊断

**事实**
- 五题单次跑中，OpenPI 的 HTML 产物用 `html.parser` 时遇到畸形标记抛出未捕获的异常；同一次 trial 最后约四分钟阻塞在 `subagent_wait` 上。
- 代码核对：非交互运行时，`subagent_spawn` 的返回会要求模型在最终回答前调用 `subagent_wait`，而 `subagent_wait` 只有 `ids` 一个参数，没有限时。
- 重复跑（`runs/2026-10-23_openpi-pi-tb4-repeat-windows-tt-earlystop`，`dee74e08`）：纯 Pi 也出现了同一个解析缺陷；4 个 OpenPI trial 里只有 1 个用了子代理，这次通过了，没有出现等子代理超时的情况。正式记录见 `docs/benchmarks/OPENPI_PI_KIMI_TB4_HTML_REPEAT_2026-10-23.md`（PR #899）。

**结论**：没有发现 OpenPI 让模型变差的证据。`subagent_wait` 加可选限时是一个可以独立修复的小缺陷，但它不是跑分差距的原因。

## 8. 效率差距与消融计划

**事实**：OpenPI 给父会话多加的模型可见内容只有 8 个工具的描述、子代理的一条使用指引，以及 2 个 skill 条目，首轮合计多约 1.5k token。其余扩展默认不注入上下文。

**推断**：这 1.5k token 大多会命中缓存，按 30 多轮算也只多出几万 token，解释不了 15% 到 25% 的差距。差距主要来自模型多跑的轮次和多产生的输出，也就是说，模型的行为因这些额外内容而改变了。具体是哪一部分引起的，目前未知。

**计划**（`protocols/efficiency-ablation.md`，尚未运行）：三组对照，纯 Pi、OpenPI、OpenPI 加 `--exclude-tools 'subagent_*,workflow,workflow_*'`，四道题各跑 5 次。用逐对计数判定差距能否复现、能否归因到常驻工具。
- 如果来自工具本身，就是保留子代理和 workflow 的已知代价；
- 如果来自指引或 skill 条目，可以低成本修掉。

## 9. 未决事项

- 效率消融跑分（第 8 节）。
- Fusion 原型跑分（第 6 节），需要前沿模型凭据。
- `subagent_wait` 可选限时：小缺陷，尚未开 issue。
- Windows 上 `tests/web/provider-settings-page.spec.ts` 偶发失败（expected '6' to be '9'），可能与 #829 属于同一类问题。

决定不做的事项：权限规则（用户决定不做）；后台 shell 和压缩前清理工具输出（归 Pi 管）；`fork_context`（委派价值未证明前属于过早优化）；死循环护栏（跑分中从未出现过死循环）。
