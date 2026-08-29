# Setup

Use Node.js 22.19.0 or newer. Install the public Pi package:

```sh
pi install npm:@tt-a1i/openpi
```

To inspect the current source before loading it, install directly from GitHub instead:

```sh
pi install git:github.com/openpi-dev/openpi
```

Pi installs the package dependencies automatically. Restart Pi or run `/reload` after installation.

## fd, rg, and read-only git tools

The `file-search` extension registers `fd` and `rg` as model tools, and `git-read` registers `git_show`, `git_diff`, and `git_log` (read-only git inspection). They stay outside an ordinary parent turn until the user explicitly asks to use `fd`/`rg`/git history, or structured file search, or the model loads the `search` group through `openpi_load_tools`. Entering or restoring Plan Mode is a runtime-safety exception: it loads `search` for that Session so diff investigation can use the structured Git boundary. The gateway is shown after an explicit OpenPI-capability request, or remains visible when the user opts into adaptive discovery; child sessions may still receive these tools through the reviewed child-safe allowlist (the read-only git tools let reviewer/advisor subagents inspect diffs, which a bash-free tool boundary otherwise excludes). No setup is normally needed: at startup `fd`/`rg` silently use a system-installed binary (`fd`/`fdfind` and `rg`) when available, or an existing binary in the agent's private managed bin directory (`~/.pi/agent/bin`). Only when neither exists does it download an official release binary (macOS/Linux, arm64/x64, over HTTPS) into that directory — a persistent cache that survives package updates — and show a one-time notification. If your platform is unsupported, install `fd` and `rg` with your package manager and restart Pi. The git tools require a system `git`.

While Plan Mode is active, raw Bash `git diff`, `git show`, and `git whatchanged` are refused, as are diff-generating `git log` options such as `-p`, `--stat`, `--name-only`, and `-L`. Use `git_log` to find commits and `git_diff` / `git_show` to inspect changes; the latter commands always pass `--no-ext-diff --no-textconv --no-color`, so repository-configured `diff.external` and textconv drivers are not executed. This guarantee is scoped to the Git diff-driver boundary rather than every possible hostile Git configuration; the remaining allowlisted Git investigation commands still run inside Pi's existing project Trust boundary.

## Theme

Add the included theme to `~/.pi/agent/settings.json` while keeping your existing settings:

```json
{
  "theme": "github-dark-default"
}
```

Pi will load the extensions and theme the next time it starts. OpenPI's Background, Subagent, and Workflow Skill files remain in the package, but ordinary turns do not advertise them in the system prompt; the matching path is disclosed only after explicit capability intent or after the model loads that group through the opt-in adaptive gateway.

## Configure this package

Use the single canonical package-owned command. `/my-pi-setup` remains a compatibility alias. With no arguments, the current model explains the configurable areas and uses `ask_user`: first run initializes them; later runs explain the saved state and ask whether to keep it, change one area, or review everything. With arguments, it treats the rest as a targeted natural-language request. Persist still goes through the typed `configure_my_pi_setup` tool. The writer stays hidden while a busy Session queues the setup request, becomes active only when that exact request is delivered to the model, and is hidden again afterward. One successful apply completes the episode. If the run settles without a successful apply, OpenPI appends a visible, durable closure receipt to the Session and later model context; it says that the writer is hidden and re-entry requires `/openpi-setup <request>`. OpenPI also verifies that the active writer belongs to the package source before announcing an active setup episode; duplicate or mismatched sources fail closed without injecting the setup request. A later configuration change starts a new episode with `/openpi-setup <request>` rather than reusing the hidden tool:

```text
/openpi-setup
/openpi-setup 让模型在合适时自主发现并采用 OpenPI 能力
/openpi-setup 只在我明确要求时加载 OpenPI 能力
/openpi-setup 开启下一步预测，使用 seal/deepseek-v4-flash，关闭推理
/openpi-setup 关闭下一步预测
/openpi-setup workflow 同时跑 16 个 agent，总任务最多 256 个
/openpi-setup 显示大标题
/openpi-setup 切换 Footer 为 powerline
/openpi-setup 用 mono powerline Footer
/openpi-setup Footer 用 compact
/openpi-setup Footer 两行：cwd flex model / context cost flex git
/openpi-setup Footer 只显示 model、thinking、context、cache 和 git
/openpi-setup 关闭自定义状态栏
/openpi-setup 编辑后自动跑 npm run format
/openpi-setup 关闭 post-edit 命令
/openpi-setup 给 explorer 指定当前 Registry 中可用的模型
/openpi-setup 清除 explorer 的模型，让它继承父模型
```

Capability discovery defaults to `explicit`, preserving the zero-resident OpenPI tool surface until the user asks for a capability. The case-insensitive English words `subagent` and `workflow` are reserved authorization words: entering either word is sufficient to load its capability group, and the interactive editor shows it in Claude Code-style lavender before submission, with a darker purple fallback for light themes. This makes discussion that contains either English word an intentional opt-in tradeoff; conditional and negated clauses remain inert, while Chinese capability names still require a recognized action request. `adaptive` is an explicit opt-in that keeps only `openpi_load_tools` visible and allows the model to load a useful group on its own; because this can start Subagents, Workflows, or background processes, normal permission and configured concurrency/call limits still apply. Changing the setting updates the current Session immediately, while already loaded groups remain stable for that Session. Accepted Suggestion text is classified only after it becomes real editor input. The visual feedback and runtime activation share one fail-closed intent classifier. Next-action suggestions default to off. Run `/openpi-setup` to explicitly choose an available model and reasoning level. After a fully settled main-agent run, one suggestion may appear as dim inline text on the first row of an empty editor; reserved cells at the row end keep CJK IME preedit from overwriting it. `Right` accepts it into the editor without submitting, while any other editor input dismisses it. Suggestions are ephemeral and never enter session history or model context. Workflows default to 8 concurrent agents and 128 total agent calls per run; configurable hard maxima are 64 and 1024. The large decorative header defaults off and the custom dashboard footer defaults on with a one-line plain layout (`model context |flex| git pr cwd`; `thinking`, `cache`, `cost`, and `throughput` remain opt-in metrics). Footer presets are `powerline`, `powerline-mono`, and `compact`; style can also be set independently to `plain`, `powerline`, or `powerline-mono`. Custom layouts use a 2D `footerLines` array with at most one `flex` per row for left/right alignment. Nerd Font affects powerline separator glyphs (``) and adds Codex-style outline icons to compact read, terminal, edit, search, and directory activity rows; all accompanying text remains readable without it. Footer metrics use one Codicon outline family (`` model, `` context, and `` directory) plus `⎇` for the branch. A Nerd Font containing Codicons renders them as designed; without one, the text labels remain readable even if an icon falls back to an empty box. Footer changes apply immediately in the active TUI session. Subagent results default to the existing full display; compact mode shows only bounded status rows and keeps raw child reports behind `app.tools.expand` (`Ctrl+O` by default). Ordinary `read`, `grep`, `find`, and `ls` operations render as one-line semantic activity summaries. Bash and Write/Edit default to the same activity-row projection, showing the target, running/success/failure state, and useful line or diff counts without replaying stdout or previews. Select full independently for Bash or Write/Edit to keep Pi's native rendering expanded. `app.tools.expand` temporarily restores the native arguments, output, errors, diff, timing, images, truncation notices, and full-output metadata; it never changes Session history or model context. An optional post-edit command is off by default: set one (for example `npm run format`, maximum 500 characters) and it runs once in the background after each interactive-TUI turn with successful Write/Edit operations, with failures reported as a notification. It deliberately does not guess whether arbitrary Bash commands changed files. Built-in Agent roles `explorer`, `implementer`, `reviewer`, and `advisor` are shared by `subagent_spawn.agent_type` and Workflow `agent(..., { agent_type })`; all inherit the parent model by default. `/openpi-setup` may assign a currently available Registry model to any subset; clearing one returns it to inheritance and omitted roles stay unchanged. Model precedence is explicit call > selected role-file model > setup assignment > parent inheritance; effort is explicit call > selected role > parent. A trusted project `.pi/agents/<role>.md` overrides global `~/.pi/agent/agents/<role>.md`, which overrides the complete built-in role definition; overrides are diagnosed. Role-model changes apply to the next spawn or Workflow agent call without reload. Configuration is stored privately at `~/.pi/agent/my-pi-setup.json`.

Legacy `footerItems` is accepted and migrated at the input boundary, but new setup writes persist only canonical `footerLines`. Configurations written by this version are not guaranteed to retain their Footer layout when read by an older OpenPI version.

<!-- config-contract: capabilities.discovery suggestions.enabled suggestions.model workflows.concurrency workflows.maxAgentCalls ui.showHeader ui.customFooter ui.footerStyle ui.footerLines ui.subagentResultDisplay ui.bashToolDisplay ui.fileMutationDisplay postEdit.command subagents.roleModels -->

## Optional cross-session communication

[pi-intercom](https://github.com/nicobailon/pi-intercom) is an independently maintained Pi package for communication between top-level Sessions. OpenPI does not detect, recommend, install, configure, migrate, or remove it. If you need that capability, review its repository and install it through Pi's native package command:

```sh
pi install npm:pi-intercom
```

OpenPI Direct Subagents and Workflow children use their native parent/child result channels instead. To preserve process-level identity isolation, their Resource Loader excludes pi-intercom extensions and Skills installed from npm, Git, or local package sources without excluding ordinary project resources that merely share the same directory name.

## Session Goal and Tasks

`/goal`, `/goal <objective>`, `/goal edit`, `/goal pause`, `/goal resume`, and `/goal clear` implement a branch-scoped persistent objective with the current OpenAI Codex Goal semantics. `/goal <objective>` starts immediately with no second success-condition prompt or admission judge; the objective can contain up to 4000 characters. `/goal` shows status, objective, elapsed time, consumed tokens, optional token budget, and status-specific command hints. Replacing unfinished work requires `Replace current goal` confirmation, while a complete goal is replaced silently. Editing preserves usage and the optional budget; it reactivates complete or budget-limited goals only when the preserved budget is not already exhausted.

Model callers use `get_goal`, `create_goal`, and `update_goal`. `create_goal` is only for an explicitly requested persistent autonomous goal and fails while an unfinished goal exists. `update_goal` can only mark `complete` after a strict requirement-by-requirement evidence audit, or `blocked` after the same genuine blocker repeats for at least three consecutive Goal Turns. User/system operations own pause, resume, clear, usage limits, and budget limits.

There are no normal user-facing Turn, no-progress, or wall-clock caps; a hidden 1000-continuation circuit breaker exists only to stop runaway automation. An optional `token_budget` must only be positive. Goal non-cached Assistant input-plus-output Token and elapsed-time usage are persisted; crossing the budget marks `budget_limited` and queues one wrap-up Turn. Active goals continue after reload/resume. Fork and tree navigation defer inherited active continuation until the first explicit user input; paused, blocked, and usage-limited goals remain stopped and can prompt for Resume. A v1 active/waiting goal migrates once to paused. Assistant aborts pause an active goal and Assistant errors block it. Print/json automation is inert. Footer text mirrors Codex (`Pursuing goal (…)`, resume hints, `Goal unmet`, `Goal achieved`) without showing the objective or legacy Turn counts. An achieved Footer remains visible until the next explicit interactive/RPC input, then a branch-persisted acknowledgement hides only the Footer while `/goal` retains the completed record.

Session Tasks remain advisory multi-item work intent and do not determine Goal completion. They are scoped to the current request batch: once every item is done or dropped, the batch closes and the next `tasks_add` starts again at T1. The model marks a tracked item `in_progress` before starting it, records `done`, `blocked`, or `dropped` immediately after that item reaches a real outcome, and reconciles touched items before its final answer. Every add/update result returns the complete bounded current snapshot so the next item is explicit and the panel refreshes on each persisted transition. Commit, test, and authorization signals are only task-scoped evidence candidates; OpenPI never infers completion or mutates a task from those signals. Active items persist in a polished Claude Code-style panel above the editor; `Ctrl+Shift+T` or `/tasks hide|show|toggle` controls visibility, while `/tasks` opens the full list. No `/openpi-setup` setting or secondary judge model is required.

## Other commands added by this fork

- `/sessions` searches and previews project sessions before switching.
- `/tasks` inspects branch-scoped advisory work items.
- `/goal ...` controls the persistent autonomous session objective.
- `/context-pivot <next phase>` deliberately compacts a long current session into a next-phase brief. It requires at least 30,000 context tokens and is rejected below that; use the separate `/handoff` skill when work should move to a genuinely new session.
- `/cron every <5m> <prompt>`, `/cron in <30s> <prompt>`, `/cron list`, and `/cron remove <id>` schedule a prompt for this session. Jobs are in-memory and session-scoped (cleared on shutdown), fire only while the session is idle, and use a duration grammar (`30s`/`5m`/`2h`, minimum 30s) rather than crontab fields, because the scheduler polls about every 30 seconds. Jobs due in the same poll are delivered as one triggered turn while retaining each job's id and recurrence metadata; if that atomic delivery fails, every due job remains pending for retry.
- `/plan [objective]` explores read-only before changing anything and automatically loads the `search` capability for the current Session. While armed it blocks `edit`, `write`, mutating Bash, raw Git diff-rendering commands, `subagent_send`, `workflow`, and `bg_start`; read/grep/find/ls/fd/rg, `git_log`/`git_diff`/`git_show`, and verified non-diff Git/GitHub Bash commands stay available. It permits `subagent_spawn`, but the harness narrows every newly spawned planning child to investigation-only tools; agent types can narrow that list further, never widen it. The model must submit the complete plan through parent-only `plan_ready`; the write gate stays closed until `/plan` prepares an editable implementation prompt for the current or a fresh Session. `/plan off` cancels.
