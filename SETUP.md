# Setup

Clone or copy this repository to `~/.pi/agent`, then install its dependencies:

```sh
cd ~/.pi/agent
npm install
```

## fd and rg tools

The `file-search` extension registers `fd` and `rg` as model tools. No setup is normally needed: at startup it silently uses a system-installed `fd` (or `fdfind` on Debian/Ubuntu) and `rg` when available, or an existing fallback binary in `~/.pi/agent/bin/`. Only when neither exists does it download an official release binary (macOS/Linux, arm64/x64, over HTTPS) into `~/.pi/agent/bin/` and show a one-time notification. If your platform is unsupported, install `fd` and `rg` with your package manager and restart pi.

## Theme

Add the included theme to `~/.pi/agent/settings.json` while keeping your existing settings:

```json
{
  "theme": "github-dark-default"
}
```

Pi will load the extensions, skills, and theme from their directories the next time it starts.

## Configure this package

Use the single package-owned command. With no arguments, the current model explains the configurable areas and their impact, then uses `ask_user`: first run initializes them; later runs explain the saved state and ask whether to keep it, change one area, or review everything. With arguments, it treats the rest as a targeted natural-language request:

```text
/my-pi-setup
/my-pi-setup 开启摘要，使用 seal/deepseek-v4-flash，关闭推理
/my-pi-setup 开启本地 fallback 摘要，不调用模型
/my-pi-setup 关闭自动摘要
/my-pi-setup workflow 同时跑 16 个 agent，总任务最多 256 个
/my-pi-setup 显示大标题
/my-pi-setup Footer 只显示 model、thinking、context、cache 和 git
/my-pi-setup 关闭自定义状态栏
```

Run recaps default to off. Run `/my-pi-setup` to explicitly choose an available summary model or enable the no-model local fallback. Workflows default to 8 concurrent agents and 128 total agent calls per run; configurable hard maxima are 64 and 1024. The large decorative header defaults off and the custom dashboard footer defaults on. Subagent results default to the existing full display; users who do not usually inspect implementation detail can select compact previews. Write/Edit content and diffs default to a compact eight-line preview because file mutations are frequently verbose; set them to full if desired. Compact views expand with `app.tools.expand` (`Ctrl+O` by default). Configuration is stored privately at `~/.pi/agent/my-pi-setup.json`.

## Session Goal and Ledger

`/goal status`, `/goal <objective>`, `/goal pause`, `/goal resume`, and `/goal clear` control one branch-scoped bounded autonomous completion objective. Interactive `/goal <objective>` asks for a finite, observable success condition; model callers use `goal_set` with that condition explicitly. Before persistence, a no-tool Contract Judge rejects objective-restating, activity-only, perpetual, manual-stop, or otherwise unverifiable conditions; admission fails closed if that judge is unavailable. A valid Goal immediately queues its first autonomous Worker Turn. When `goal_set` runs inside an existing Turn, Pi delivers the kickoff as a follow-up, so the setup Turn is neither counted nor judged as Goal work.

Defaults are 40 settled Goal Worker Turns, 8 consecutive no-progress judgments, and 120 active minutes; an optional parent-run token budget must be at least 1000. The current session model/auth performs a no-tool external judgment after each Worker settlement. Evaluator tokens are reported separately from the optional parent-run budget. A restored, reloaded, forked, or tree-navigated active/waiting Goal is persisted as paused; `/goal resume` re-vets the Contract, then acts as explicit execution authorization and immediately queues the next Worker Turn. Legacy invalid Goals remain clearable but cannot bypass the new admission rule. Print/json automation is inert. The live UI uses one bounded Footer status; `/goal status` shows full detail.

Session Ledger remains advisory multi-item work intent. A Goal can include active Ledger T keys once as an action reminder, but Ledger state never proves completion. No `/my-pi-setup` setting is needed because both judges use the current model.

## Other commands added by this fork

- `/sessions` searches and previews project sessions before switching.
- `/ledger` inspects branch-scoped advisory work items.
- `/goal ...` controls the persistent bounded autonomous session objective.
- `/context-pivot <next phase>` deliberately compacts a long current session into a next-phase brief. It requires roughly 30,000 context tokens; use the separate `/handoff` skill when work should move to a genuinely new session.
