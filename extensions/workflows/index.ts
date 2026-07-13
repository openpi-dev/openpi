/**
 * workflows: model-authored multi-agent orchestration.
 *
 * A `workflow` tool that runs a JavaScript orchestration script written inline
 * by the model. The script executes ordered phases, fanning work out to
 * isolated subagents:
 *
 *   export const meta = { name, description, phases: [{ title, detail? }] }
 *   phase(title)                                  // mark runtime phase progression
 *   await agent(prompt, { label?, phase?, schema?, model?, provider?, effort? })
 *   await parallel([() => agent(...), ...], { concurrency? })
 *   args                                          // parsed JSON args passed with the tool call
 *
 * `agent()` always resolves to `{ ok, output, structured?, error? }` — it
 * never throws into the script. Scripts branch on `ok` explicitly.
 *
 * Runs are blocking by default (live progress in the tool block). Pass
 * `background: true` to return immediately and get a follow-up message when
 * the run finishes. Run artifacts (script, args, statuses, result) are saved
 * under `~/.pi/agent/workflows/<runId>/` for inspection; there is no resume.
 */

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  getAgentDir,
  getMarkdownTheme,
  keyHint,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { sessionWorkflowRunIds, showWorkflowDashboard } from "./dashboard.ts";
import { extractMeta, stripExports, type WorkflowMeta } from "./meta.ts";
import {
  aggregateUsage,
  countStates,
  emptyUsage,
  formatElapsed,
  formatUsage,
  phaseGroups,
  resultJson,
  shortenHome,
  stateSquare,
  statusColor,
  statusWord,
  SQUARE,
  type AgentRecord,
  type WorkflowDetails,
} from "./model.ts";
import {
  createWorkflowLoader,
  runAgent,
  type ThinkingLevel,
  type WorkflowModel,
} from "./runner.ts";

const PREVIEW_LENGTH = 200;
const EMIT_INTERVAL_MS = 120;

const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

/** What `agent()` resolves to inside the script. */
interface ScriptAgentResult {
  ok: boolean;
  output: string;
  structured?: unknown;
  error?: string;
}

interface AgentCallOptions {
  label?: unknown;
  phase?: unknown;
  schema?: unknown;
  model?: unknown;
  provider?: unknown;
  effort?: unknown;
}

const WorkflowParams = Type.Object({
  script: Type.String({
    description:
      "JavaScript workflow script. May start with `export const meta = {...}`, then use phase(), agent(), parallel(), args, and a final `return`.",
  }),
  args: Type.Optional(
    Type.String({
      description:
        "Optional JSON string exposed to the script as `args` (parsed when valid JSON, otherwise passed through as the raw string).",
    }),
  ),
  background: Type.Optional(
    Type.Boolean({
      description:
        "Run in the background: the tool returns a run id immediately and you receive a follow-up message when the workflow finishes. Defaults to false (blocking with live progress).",
    }),
  ),
});

type WorkflowInput = Static<typeof WorkflowParams>;

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
  ...args: string[]
) => (...fnArgs: unknown[]) => Promise<unknown>;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function summaryLine(details: WorkflowDetails): string {
  const { done, failed } = countStates(details);
  const settled = done + failed;
  return `workflow ${details.name ?? details.runId}: ${settled}/${details.agents.length} agents${
    details.currentPhase ? ` · ${details.currentPhase}` : ""
  }`;
}

/** Plain-text report for the LLM (and the background follow-up message). */
function resultText(details: WorkflowDetails, runDir: string): string {
  const { done, failed } = countStates(details);
  const elapsed = formatElapsed(details.startedAt, details.finishedAt);
  const lines = [
    `Workflow ${details.name ? `"${details.name}"` : details.runId} ${details.status} — ` +
      `${done}/${details.agents.length} agents ok${failed ? `, ${failed} failed` : ""} ` +
      `across ${details.phases.length} phase(s) in ${elapsed}.`,
    `Run dir: ${shortenHome(runDir)}`,
  ];
  if (details.error) lines.push(`Error: ${details.error}`);
  if (details.agents.length > 0) {
    lines.push("", "Agents:");
    for (const agent of details.agents) {
      const status =
        agent.state === "done"
          ? "ok"
          : agent.state === "error"
            ? "FAILED"
            : "running";
      lines.push(
        `- [${agent.label}]${agent.phase ? ` (${agent.phase})` : ""} ${status}` +
          (agent.error ? ` — ${agent.error}` : ""),
      );
    }
  }
  if (details.result !== undefined)
    lines.push("", "Result:", resultJson(details.result));
  return lines.join("\n");
}

async function mapWithConcurrencyLimit<TIn, TOut>(
  items: TIn[],
  concurrency: number,
  fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results: TOut[] = new Array(items.length);
  let nextIndex = 0;
  const workers = new Array(limit).fill(null).map(async () => {
    while (true) {
      const current = nextIndex++;
      if (current >= items.length) return;
      results[current] = await fn(items[current], current);
    }
  });
  await Promise.all(workers);
  return results;
}

function writeRunFile(runDir: string, name: string, content: string) {
  try {
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, name), content, "utf8");
  } catch {
    // Artifacts are best-effort.
  }
}

function persistWorkflowJson(runDir: string, details: WorkflowDetails) {
  let serialized: string;
  try {
    serialized = JSON.stringify(details, null, 2);
  } catch {
    serialized = JSON.stringify(
      { ...details, result: "(unserializable)" },
      null,
      2,
    );
  }
  writeRunFile(runDir, "workflow.json", serialized);
}

interface RunSummary {
  runId: string;
  name?: string;
  status: string;
  done: number;
  total: number;
  startedAt: number;
  active: boolean;
}

function listRuns(
  activeRuns: Map<string, WorkflowDetails>,
  sessionId: string,
  referencedRunIds: ReadonlySet<string>,
): RunSummary[] {
  const base = path.join(getAgentDir(), "workflows");
  let names: string[] = [];
  try {
    names = fs.readdirSync(base).filter((name) => name.startsWith("wf_"));
  } catch {
    // No runs yet.
  }
  const summaries: RunSummary[] = [];
  for (const runId of names) {
    const live = activeRuns.get(runId);
    if (live) {
      const { done, failed } = countStates(live);
      summaries.push({
        runId,
        name: live.name,
        status: live.status,
        done: done + failed,
        total: live.agents.length,
        startedAt: live.startedAt,
        active: true,
      });
      continue;
    }
    try {
      const parsed = JSON.parse(
        fs.readFileSync(path.join(base, runId, "workflow.json"), "utf8"),
      ) as Partial<WorkflowDetails>;
      if (parsed.sessionId !== sessionId && !referencedRunIds.has(runId)) {
        continue;
      }
      const agents = parsed.agents ?? [];
      summaries.push({
        runId,
        name: parsed.name,
        status: parsed.status ?? "unknown",
        done: agents.filter((agent) => agent.state !== "running").length,
        total: agents.length,
        startedAt: parsed.startedAt ?? 0,
        active: false,
      });
    } catch {
      // Ignore unreadable artifacts because their session cannot be verified.
    }
  }
  return summaries.sort((a, b) => b.startedAt - a.startedAt);
}

function runDetailText(
  run: RunSummary,
  activeRuns: Map<string, WorkflowDetails>,
): string {
  const runDir = path.join(getAgentDir(), "workflows", run.runId);
  const live = activeRuns.get(run.runId);
  if (live) return resultText(live, runDir);
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(runDir, "workflow.json"), "utf8"),
    ) as WorkflowDetails;
    return resultText(parsed, runDir);
  } catch {
    return `Run ${run.runId} — ${run.status}`;
  }
}

const TOOL_DESCRIPTION = [
  "Run a multi-agent workflow from a JavaScript orchestration script you write inline. Use this when a task benefits from fanning work out across several isolated subagents in ordered phases (research fan-out, per-file review, verify-then-synthesize pipelines).",
  "The script runs as an async function body with these primitives:",
  "• export const meta = { name, description, phases: [{ title, detail? }] } — metadata for the progress UI. Declare all phases up front.",
  "• phase(title) — mark the current phase at runtime (use titles from meta.phases).",
  "• await agent(prompt, { label?, phase?, schema?, model?, provider?, effort? }) — run ONE subagent in an isolated context and wait for it. Always resolves to { ok, output, structured?, error? }; it NEVER throws. Check `ok` before using the result. When you pass a JSON `schema`, `structured` holds the parsed object on success. `model`/`provider` override the session model (e.g. provider: 'anthropic', model: 'claude-sonnet-4-5', or model: 'anthropic/claude-sonnet-4-5'); `effort` sets the thinking level (off|minimal|low|medium|high|xhigh|max). Subagents get the full built-in toolset plus skills and AGENTS.md context, but cannot spawn workflows.",
  "• await parallel([() => agent(...), () => agent(...)], { concurrency? }) — run agent thunks concurrently and return results in order. Unbounded by default; pass `concurrency` to bound it. Pass zero-arg thunks, not started promises.",
  "• args — the parsed value of the `args` tool parameter (or undefined).",
  "Everything else is plain JavaScript (map/filter/if/await/template strings), so fan out dynamically and feed earlier results into later prompts. `return` a final aggregate; it is reported back to you.",
  "Pass a `schema` to agent() whenever a later step branches on the result, so you get typed fields instead of prose. There is no resume: a failed run is simply re-run. Artifacts are saved under ~/.pi/agent/workflows/<runId>/ for inspection.",
  "Example:",
  "export const meta = { name: 'audit', description: 'Audit modules, then report', phases: [{ title: 'Scan' }, { title: 'Report' }] }",
  "const FINDINGS = { type: 'object', properties: { issues: { type: 'array', items: { type: 'string' } }, ok: { type: 'boolean' } }, required: ['issues', 'ok'] }",
  "phase('Scan')",
  "const scans = await parallel(args.files.map((f) => () => agent(`Audit ${f} for security issues.`, { label: `scan:${f}`, phase: 'Scan', schema: FINDINGS })))",
  "const findings = scans.filter((r) => r.ok).map((r) => r.structured)",
  "phase('Report')",
  "const report = await agent(`Summarize these findings: ${JSON.stringify(findings)}`, { label: 'report', phase: 'Report' })",
  "return { findings, report: report.ok ? report.output : report.error }",
].join("\n");

export default function workflows(pi: ExtensionAPI) {
  /** Live background runs, for /workflows and shutdown cleanup. */
  const activeRuns = new Map<
    string,
    { details: WorkflowDetails; abort: AbortController }
  >();
  const activeDetails = () =>
    new Map(
      [...activeRuns].map(([runId, run]) => [runId, run.details] as const),
    );

  /**
   * Persistent indicator on its own line below the editor:
   * "workflows running - /workflows" while any run is active, then
   * "workflows done - /workflows" until the dashboard is opened.
   */
  let lastUi: ExtensionContext["ui"] | undefined;
  let sawRuns = false;
  const updateIndicator = () => {
    const ui = lastUi;
    if (!ui) return;
    try {
      if (activeRuns.size === 0 && !sawRuns) {
        ui.setStatus("workflows", undefined);
        return;
      }
      const running = activeRuns.size > 0;
      const theme = ui.theme;
      ui.setStatus(
        "workflows",
        theme.fg(running ? "warning" : "success", SQUARE) +
          theme.fg("muted", ` workflows ${running ? "running" : "done"} - `) +
          theme.fg("accent", "/workflows"),
      );
    } catch {
      // UI may be unavailable.
    }
  };

  pi.on("session_start", (_event, ctx) => {
    if (ctx.hasUI) lastUi = ctx.ui;
    updateIndicator();
  });

  pi.on("session_shutdown", () => {
    for (const run of activeRuns.values()) run.abort.abort();
    lastUi = undefined;
  });

  pi.registerCommand("workflows", {
    description:
      "List workflow runs (`/workflows <runId>` for one run's detail)",
    handler: async (rawArgs, ctx) => {
      const arg = rawArgs.trim();
      if (ctx.mode === "tui") {
        lastUi = ctx.ui;
        await showWorkflowDashboard(ctx, activeDetails, arg || undefined);
        // Opening the dashboard acknowledges finished runs.
        if (activeRuns.size === 0) sawRuns = false;
        updateIndicator();
        return;
      }
      // Non-TUI fallback: plain text listing.
      const runs = listRuns(
        activeDetails(),
        ctx.sessionManager.getSessionId(),
        sessionWorkflowRunIds(ctx),
      );
      if (runs.length === 0) {
        ctx.ui.notify("No workflow runs yet.", "info");
        return;
      }
      if (arg) {
        const run = runs.find((r) => r.runId === arg || r.runId.endsWith(arg));
        ctx.ui.notify(
          run
            ? runDetailText(run, activeDetails())
            : `No workflow run matching "${arg}".`,
          run ? "info" : "warning",
        );
        return;
      }
      const labels = runs.map(
        (r) =>
          `${r.active ? "* " : "  "}${r.runId}  ${r.status}  ${r.name ?? ""}  ${r.done}/${r.total}`,
      );
      if (!ctx.hasUI) {
        ctx.ui.notify(labels.join("\n"), "info");
        return;
      }
      const choice = await ctx.ui.select("Workflow runs", labels);
      if (!choice) return;
      const run = runs[labels.indexOf(choice)];
      if (run) ctx.ui.notify(runDetailText(run, activeDetails()), "info");
    },
  });

  pi.registerTool({
    name: "workflow",
    label: "Workflow",
    description: TOOL_DESCRIPTION,
    promptSnippet:
      "Orchestrate isolated subagents from an inline JS script: phase()/agent()/parallel() with structured outputs and optional background execution",
    promptGuidelines: [
      "Use workflow when a task needs several subagents with phase dependencies or dynamic fan-out; keep single small delegations in the main session.",
      "In workflow scripts, agent() never throws — always check `.ok` on its result before using `.output`/`.structured`.",
    ],
    parameters: WorkflowParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      // Compile first so a syntax error fails fast with a clear message.
      let scriptFn: (...fnArgs: unknown[]) => Promise<unknown>;
      try {
        scriptFn = new AsyncFunction(
          "agent",
          "parallel",
          "phase",
          "args",
          stripExports(params.script),
        );
      } catch (error) {
        throw new Error(`Workflow script failed to parse: ${errorText(error)}`);
      }

      let args: unknown;
      if (params.args !== undefined) {
        try {
          args = JSON.parse(params.args);
        } catch {
          args = params.args;
        }
      }

      const meta: WorkflowMeta = extractMeta(params.script);
      const runId = `wf_${randomBytes(6).toString("hex")}`;
      const runDir = path.join(getAgentDir(), "workflows", runId);
      const background = (params.background ?? false) && ctx.hasUI;

      const details: WorkflowDetails = {
        runId,
        sessionId: ctx.sessionManager.getSessionId(),
        name: meta.name,
        description: meta.description,
        background,
        status: "running",
        startedAt: Date.now(),
        phases: [...meta.phases],
        agents: [],
      };

      writeRunFile(runDir, "script.js", params.script);
      if (params.args !== undefined)
        writeRunFile(runDir, "args.json", params.args);
      persistWorkflowJson(runDir, details);

      // Background runs get their own abort (survive Esc on the parent turn,
      // aborted on session shutdown). Blocking runs use the tool signal.
      const runAbort = new AbortController();
      const runSignal = runAbort.signal;
      if (!background && signal) {
        if (signal.aborted) runAbort.abort();
        else
          signal.addEventListener("abort", () => runAbort.abort(), {
            once: true,
          });
      }

      // Shared loaders: one resource discovery per variant per run.
      let plainLoader: ReturnType<typeof createWorkflowLoader> | undefined;
      let structuredLoader: ReturnType<typeof createWorkflowLoader> | undefined;
      const getLoader = (structured: boolean) => {
        if (structured)
          return (structuredLoader ??= createWorkflowLoader(
            ctx.cwd,
            "structured",
          ));
        return (plainLoader ??= createWorkflowLoader(ctx.cwd, "plain"));
      };

      // Throttled progress: tool-block updates when blocking. Background
      // runs are covered by the below-editor indicator and /workflows.
      let emitTimer: ReturnType<typeof setTimeout> | undefined;
      let lastEmit = 0;
      const flush = () => {
        emitTimer = undefined;
        lastEmit = Date.now();
        if (background) return;
        onUpdate?.({
          content: [{ type: "text", text: summaryLine(details) }],
          details,
        });
      };
      const emit = () => {
        if (emitTimer) return;
        emitTimer = setTimeout(
          flush,
          Math.max(0, EMIT_INTERVAL_MS - (Date.now() - lastEmit)),
        );
      };
      const flushNow = () => {
        if (emitTimer) clearTimeout(emitTimer);
        flush();
      };

      const phaseFn = (title: unknown) => {
        const text = String(title);
        details.currentPhase = text;
        if (!details.phases.some((p) => p.title === text))
          details.phases.push({ title: text });
        emit();
      };

      let agentCounter = 0;
      const agentFn = async (
        promptValue: unknown,
        optsValue: unknown = {},
      ): Promise<ScriptAgentResult> => {
        const index = ++agentCounter;
        const opts: AgentCallOptions =
          optsValue && typeof optsValue === "object"
            ? (optsValue as AgentCallOptions)
            : {};
        const label =
          typeof opts.label === "string" && opts.label.trim()
            ? opts.label.trim()
            : `agent-${index}`;

        const record: AgentRecord = {
          index,
          label,
          phase:
            typeof opts.phase === "string" ? opts.phase : details.currentPhase,
          state: "running",
          startedAt: Date.now(),
          preview: "",
          usage: emptyUsage(),
          transcript: [],
        };
        details.agents.push(record);
        emit();

        const fail = (error: string): ScriptAgentResult => {
          record.state = "error";
          record.error = error;
          record.finishedAt = Date.now();
          emit();
          return { ok: false, output: "", error };
        };

        const prompt =
          typeof promptValue === "string"
            ? promptValue
            : String(promptValue ?? "");
        if (!prompt.trim())
          return fail("agent() requires a non-empty prompt string");
        if (runSignal.aborted)
          return fail("Workflow was aborted before this agent started");

        // Model/provider resolution: default to the parent session's model.
        let model: WorkflowModel | undefined = ctx.model;
        if (opts.model !== undefined || opts.provider !== undefined) {
          const modelOpt =
            typeof opts.model === "string" ? opts.model : undefined;
          const providerOpt =
            typeof opts.provider === "string" ? opts.provider : undefined;
          if (!modelOpt)
            return fail(
              `agent "${label}": \`provider\` requires \`model\` as well`,
            );
          let resolved: WorkflowModel | undefined;
          if (providerOpt) {
            resolved = ctx.modelRegistry.find(providerOpt, modelOpt);
          } else {
            const slash = modelOpt.indexOf("/");
            if (slash > 0) {
              resolved = ctx.modelRegistry.find(
                modelOpt.slice(0, slash),
                modelOpt.slice(slash + 1),
              );
            }
            resolved ??= ctx.modelRegistry
              .getAll()
              .find((m) => m.id === modelOpt);
          }
          if (!resolved) {
            const requested = providerOpt
              ? `${providerOpt}/${modelOpt}`
              : modelOpt;
            return fail(
              `agent "${label}": unknown model "${requested}" (use provider/id)`,
            );
          }
          model = resolved;
        }

        // Effort → thinking level; default inherits the parent session.
        let thinkingLevel: ThinkingLevel = pi.getThinkingLevel();
        if (opts.effort !== undefined) {
          const effort = String(opts.effort);
          if (!(THINKING_LEVELS as readonly string[]).includes(effort)) {
            return fail(
              `agent "${label}": invalid effort "${effort}" (use ${THINKING_LEVELS.join("|")})`,
            );
          }
          thinkingLevel = effort as ThinkingLevel;
        }

        const outcome = await runAgent({
          prompt,
          schema: opts.schema,
          model,
          thinkingLevel,
          cwd: ctx.cwd,
          loader: await getLoader(opts.schema !== undefined),
          modelRegistry: ctx.modelRegistry,
          signal: runSignal,
          onProgress: (progress) => {
            record.preview = progress.preview.slice(0, PREVIEW_LENGTH);
            record.usage = progress.usage;
            record.model = progress.model ?? record.model;
            record.transcript = progress.transcript;
            emit();
          },
        });

        record.usage = outcome.usage;
        record.model = outcome.model ?? record.model;
        record.transcript = outcome.transcript;
        record.preview = (outcome.output || record.preview).slice(
          0,
          PREVIEW_LENGTH,
        );
        record.finishedAt = Date.now();
        record.state = outcome.ok ? "done" : "error";
        record.error = outcome.error;
        emit();

        return {
          ok: outcome.ok,
          output: outcome.output,
          ...(outcome.structured !== undefined
            ? { structured: outcome.structured }
            : {}),
          ...(outcome.error !== undefined ? { error: outcome.error } : {}),
        };
      };

      const parallelFn = async (
        items: unknown,
        optsValue?: unknown,
      ): Promise<unknown[]> => {
        if (!Array.isArray(items)) {
          throw new Error(
            "parallel() expects an array of zero-arg functions returning agent() calls",
          );
        }
        const opts = (
          optsValue && typeof optsValue === "object" ? optsValue : {}
        ) as {
          concurrency?: unknown;
        };
        const run = (item: unknown) =>
          Promise.resolve(
            typeof item === "function" ? (item as () => unknown)() : item,
          );
        const concurrency =
          typeof opts.concurrency === "number" &&
          Number.isFinite(opts.concurrency)
            ? Math.floor(opts.concurrency)
            : undefined;
        if (concurrency !== undefined && concurrency < 1) {
          throw new Error("parallel(): concurrency must be a positive integer");
        }
        if (concurrency === undefined || concurrency >= items.length) {
          return Promise.all(items.map(run));
        }
        return mapWithConcurrencyLimit(items, concurrency, run);
      };

      const finalize = (status: WorkflowDetails["status"]) => {
        details.status = status;
        details.finishedAt = Date.now();
        persistWorkflowJson(runDir, details);
        flushNow();
      };

      const runScript = async () => {
        try {
          details.result = await scriptFn(agentFn, parallelFn, phaseFn, args);
          finalize(runSignal.aborted ? "aborted" : "completed");
        } catch (error) {
          details.error = errorText(error);
          finalize(runSignal.aborted ? "aborted" : "failed");
        }
      };

      // Registered for /workflows visibility and session_shutdown abort;
      // blocking runs are watchable live from the dashboard too.
      activeRuns.set(runId, { details, abort: runAbort });
      sawRuns = true;
      if (ctx.hasUI) lastUi = ctx.ui;
      updateIndicator();

      if (background) {
        void runScript().finally(() => {
          activeRuns.delete(runId);
          updateIndicator();
          try {
            pi.sendUserMessage(
              `[Background workflow ${runId} ${details.status}]\n\n${resultText(details, runDir)}`,
              { deliverAs: "followUp" },
            );
          } catch {
            // Session may be shutting down.
          }
        });
        return {
          content: [
            {
              type: "text",
              text: [
                `Workflow ${details.name ? `"${details.name}"` : runId} launched in background (run ${runId}).`,
                `Artifacts: ${shortenHome(runDir)}`,
                "You'll receive a follow-up message when it finishes; /workflows shows progress.",
              ].join("\n"),
            },
          ],
          details,
        };
      }

      try {
        await runScript();
      } finally {
        activeRuns.delete(runId);
        updateIndicator();
      }
      return {
        content: [{ type: "text", text: resultText(details, runDir) }],
        details,
        isError: details.status !== "completed",
      };
    },

    renderCall(args: Partial<WorkflowInput>, theme) {
      const meta =
        typeof args.script === "string"
          ? extractMeta(args.script)
          : { phases: [] };
      let text =
        theme.fg("toolTitle", theme.bold("workflow ")) +
        theme.fg("accent", (meta as WorkflowMeta).name ?? "(script)");
      if (args.background) text += theme.fg("dim", " (background)");
      const description = (meta as WorkflowMeta).description;
      if (description) text += `\n  ${theme.fg("dim", description)}`;
      for (const phase of meta.phases.slice(0, 8)) {
        text += `\n  ${theme.fg("dim", SQUARE)} ${theme.fg("accent", phase.title)}${
          phase.detail ? theme.fg("dim", ` — ${phase.detail}`) : ""
        }`;
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      const details = result.details as WorkflowDetails | undefined;
      if (!details) {
        const first = result.content[0];
        return new Text(
          first?.type === "text" ? first.text : "(no output)",
          0,
          0,
        );
      }

      const { done, failed } = countStates(details);
      const settled = done + failed;
      const elapsed = formatElapsed(details.startedAt, details.finishedAt);
      let header =
        `${theme.fg(statusColor(details.status), SQUARE)} ${theme.fg("toolTitle", theme.bold("workflow "))}` +
        `${theme.fg("accent", details.name ?? details.runId)} ` +
        theme.fg(
          "dim",
          `${settled}/${details.agents.length} agents · ${elapsed} · `,
        ) +
        theme.fg(statusColor(details.status), statusWord(details.status));
      if (failed) header += theme.fg("error", ` · ${failed} failed`);
      if (details.background) header += theme.fg("dim", " (background)");
      if (details.status === "running" && details.currentPhase) {
        header += theme.fg("muted", ` · ${details.currentPhase}`);
      }
      const totals = formatUsage(aggregateUsage(details.agents));

      if (!expanded) {
        let text = header;
        for (const agent of details.agents) {
          text += `\n  ${stateSquare(agent.state, theme)} ${theme.fg("accent", agent.label)}${
            agent.phase ? theme.fg("dim", ` (${agent.phase})`) : ""
          }${theme.fg("dim", ` ${formatElapsed(agent.startedAt, agent.finishedAt)}`)}`;
        }
        if (totals) text += `\n  ${theme.fg("dim", `Total: ${totals}`)}`;
        if (details.error)
          text += `\n  ${theme.fg("error", `Error: ${details.error}`)}`;
        text += `\n${theme.fg("muted", `(${keyHint("app.tools.expand", "to expand")})`)}`;
        return new Text(text, 0, 0);
      }

      const container = new Container();
      container.addChild(new Text(header, 0, 0));
      if (details.description) {
        container.addChild(
          new Text(theme.fg("dim", details.description), 0, 0),
        );
      }

      for (const group of phaseGroups(details)) {
        container.addChild(new Spacer(1));
        container.addChild(
          new Text(theme.fg("muted", `─── ${group.title} ───`), 0, 0),
        );
        for (const agent of group.agents) {
          const usage = formatUsage(agent.usage, agent.model);
          let line = `${stateSquare(agent.state, theme)} ${theme.fg("accent", agent.label)} ${theme.fg(
            "dim",
            formatElapsed(agent.startedAt, agent.finishedAt),
          )}`;
          if (usage) line += ` ${theme.fg("dim", usage)}`;
          container.addChild(new Text(line, 0, 0));
          if (agent.error) {
            container.addChild(
              new Text(`  ${theme.fg("error", agent.error)}`, 0, 0),
            );
          } else if (agent.preview) {
            const preview = agent.preview.split("\n").slice(0, 2).join(" ");
            container.addChild(new Text(`  ${theme.fg("dim", preview)}`, 0, 0));
          }
        }
      }

      if (details.error) {
        container.addChild(new Spacer(1));
        container.addChild(
          new Text(theme.fg("error", `Error: ${details.error}`), 0, 0),
        );
      }

      if (details.result !== undefined) {
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("muted", "─── result ───"), 0, 0));
        container.addChild(
          new Markdown(
            `\`\`\`json\n${resultJson(details.result)}\n\`\`\``,
            0,
            0,
            getMarkdownTheme(),
          ),
        );
      }

      if (totals) {
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("dim", `Total: ${totals}`), 0, 0));
      }
      return container;
    },
  });
}
