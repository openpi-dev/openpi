# 工作记录：工具面冻结、跑分与 Fusion 评估

- 时间：2026-10-17 至 2026-10-24
- Agent：Devin CLI，Fusion 模式（lead 加常驻 sidekick），session `carnation-radiator`
- 性质：原始工作记录，按仓库所有者要求发布。**不是受治理的正式记录**，正式结论以 `docs/` 为准。

## 目录

| 路径 | 内容 |
| --- | --- |
| [`analysis.md`](analysis.md) | 全部分析结论的汇总，按主题整理，区分事实与推断 |
| [`transcript/lead.md`](transcript/lead.md) | lead 的完整轨迹：用户消息、回复、工具调用和结果（已截断） |
| [`transcript/sidekick.md`](transcript/sidekick.md) | sidekick 的轨迹：各次交接的实现与验证过程 |
| [`transcript/subagents.md`](transcript/subagents.md) | 外部 harness 调研子代理的轨迹（只读） |
| [`protocols/`](protocols/) | 交给跑分 agent 的任务指令：Kimi 重复对照、效率消融、Fusion 原型（含打分脚本） |
| [`export_session.py`](export_session.py) | 从本机 Devin 会话库导出轨迹的脚本 |

## 产出

| 产出 | 位置 |
| --- | --- |
| 工具面冻结决定 | Issue #879，`docs/decisions/0005-frozen-tool-surface.md` |
| Bash 默认超时 | PR #885 |
| 子代理消耗显示，以及去掉价格显示 | PR #886、#887 |
| 子代理不再加载编排类 skill | PR #888（`35c70cc7`） |
| 1.1.0 发版 | PR #889（`e799a9b8`），tag `v1.1.0` |
| Kimi 重复对照的 Benchmark 记录 | PR #899 |
| 原始跑分证据 | 私有归档仓 `tt-a1i/openpi-bench-archive`，`runs/` 下按轮次存放 |

## 轨迹是怎么导出的

```sh
python3 export_session.py carnation-radiator lead transcript/lead.md
python3 export_session.py carnation-radiator sidekick transcript/sidekick.md
python3 export_session.py carnation-radiator subagents transcript/subagents.md
```

- 每个 agent 的全部消息树按创建顺序输出。压缩后复制的重复消息按 message id 去重，废弃的分支也保留在原有的时间位置。
- **已去掉的内容**：
  - 系统消息，包括 Devin 和 sidekick 的系统提示；
  - 自动注入的环境、规则、skill 列表和 guidance 块；
  - 模型元数据和思考过程。
- **截断**：工具调用参数只保留前 2000 字符，工具结果只保留前 1200 字符。
- **脱敏**：本机用户目录替换为 `~` 或 `%USERPROFILE%`，形似凭据的字符串替换为 `[REDACTED]`。发布前另外扫过一遍常见密钥格式，没有命中。
- 轨迹是导出那一刻的快照，不包含之后的对话。
