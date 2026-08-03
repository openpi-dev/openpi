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
 * under `~/.pi/agent/workflows/<runId>/` for inspection; result and bounded
 * transcripts use separate artifacts, and there is no resume.
 */

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  CustomEditor,
  getAgentDir,
  getMarkdownTheme,
  keyHint,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { formatActivityStatus } from "../shared/activity-status.ts";
import { loadSetupConfig } from "../shared/setup-config.ts";
import { createWorkflowPersistence, persistWorkflowJson } from "./artifacts.ts";
import { RunController } from "./controller.ts";
import { sessionWorkflowRunIds, showWorkflowDashboard } from "./dashboard.ts";
import {
  extractMeta,
  prepareWorkflowScript,
  type WorkflowMeta,
} from "./meta.ts";
import {
  agentContext,
  aggregateUsage,
  countStates,
  emptyUsage,
  formatElapsed,
  formatUsage,
  phaseGroups,
  resultJson,
  stateSquare,
  statusColor,
  statusWord,
  SQUARE,
  type AgentRecord,
  type WorkflowDetails,
} from "./model.ts";
import {
  buildBackgroundWorkflowFollowUp,
  buildBackgroundWorkflowLaunchResult,
  buildWorkflowAgentPrompt,
  buildWorkflowResultMessage,
  WORKFLOW_LIFECYCLE_PROMPT_SNIPPET,
  WORKFLOW_PARAMETER_DESCRIPTIONS,
  WORKFLOW_PROMPT_GUIDELINES,
  WORKFLOW_PROMPT_SNIPPET,
  WORKFLOW_STATUS_PARAMETER_DESCRIPTIONS,
  WORKFLOW_STATUS_TOOL_DESCRIPTION,
  WORKFLOW_STOP_PARAMETER_DESCRIPTIONS,
  WORKFLOW_STOP_TOOL_DESCRIPTION,
  WORKFLOW_TOOL_DESCRIPTION,
} from "./prompt.ts";
import {
  WorkflowNavigationEditor,
  WorkflowStripState,
  WorkflowStripWidget,
  type WorkflowStripEntry,
} from "./navigation.ts";
import {
  createWorkflowResources,
  runAgent,
  type ThinkingLevel,
  type WorkflowModel,
} from "./runner.ts";
import { runWorkflowSandbox } from "./sandbox.ts";
import { safeStringify, writeFileAtomic } from "./serialization.ts";

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
    description: WORKFLOW_PARAMETER_DESCRIPTIONS.script,
  }),
  args: Type.Optional(
    Type.String({
      description: WORKFLOW_PARAMETER_DESCRIPTIONS.args,
    }),
  ),
  background: Type.Optional(
    Type.Boolean({
      description: WORKFLOW_PARAMETER_DESCRIPTIONS.background,
    }),
  ),
});

type WorkflowInput = Static<typeof WorkflowParams>;

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(
    0,
    16 * 1024,
  );
}

function summaryLine(details: WorkflowDetails): string {
  const { done, failed } = countStates(details);
  const settled = done + failed;
  return `workflow ${details.name ?? details.runId}: ${settled}/${details.agents.length} agents${
    details.currentPhase ? ` · ${details.currentPhase}` : ""
  }`;
}

function writeRunFile(runDir: string, name: string, content: string) {
  writeFileAtomic(path.join(runDir, name), content);
}

function compactToolDetails(details: WorkflowDetails): WorkflowDetails {
  return {
    ...details,
    ...(details.result !== undefined
      ? {
          result: JSON.parse(
            safeStringify(details.result, { maxBytes: 64 * 1024 }),
          ),
        }
      : {}),
    agents: details.agents.map((agent) => ({ ...agent, transcript: [] })),
  };
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
  startedSince = 0,
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
      const startedAt = parsed.startedAt ?? 0;
      const touchedAt = Math.max(startedAt, parsed.finishedAt ?? 0);
      if (
        touchedAt < startedSince ||
        (parsed.sessionId !== sessionId && !referencedRunIds.has(runId))
      ) {
        continue;
      }
      const agents = parsed.agents ?? [];
      summaries.push({
        runId,
        name: parsed.name,
        status:
          parsed.status === "running"
            ? "aborted"
            : (parsed.status ?? "unknown"),
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
  if (live) return buildWorkflowResultMessage(live, runDir);
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(runDir, "workflow.json"), "utf8"),
    ) as WorkflowDetails;
    return buildWorkflowResultMessage(parsed, runDir);
  } catch {
    return `Run ${run.runId} — ${run.status}`;
  }
}

export default function workflows(pi: ExtensionAPI) {
  /** Live background runs, for /workflows and shutdown cleanup. */
  const activeRuns = new Map<
    string,
    {
      details: WorkflowDetails;
      controller: RunController;
      completion?: Promise<void>;
    }
  >();
  const activeDetails = () =>
    new Map(
      [...activeRuns].map(([runId, run]) => [runId, run.details] as const),
    );
  const settledRuns = new Map<string, WorkflowDetails>();
  const stripState = new WorkflowStripState();
  const widgetKey = "workflow-navigation";

  /**
   * Finished counts are an unread notice: opening the dashboard or sending the
   * next explicit request acknowledges them.
   */
  let lastContext: ExtensionContext | undefined;
  let completedRuns = 0;
  let failedRuns = 0;
  let widgetVisible = false;
  let requestWidgetRender: (() => void) | undefined;
  let dashboardOpen = false;
  /**
   * Start of the current request. The dashboard reports the work belonging to
   * it, not the whole session's run history.
   */
  let turnStartedAt = 0;

  const newestEntry = (
    entries: Iterable<readonly [string, WorkflowDetails]>,
  ): WorkflowStripEntry | undefined => {
    let newest: WorkflowStripEntry | undefined;
    for (const [runId, details] of entries) {
      if (!newest || details.startedAt > newest.details.startedAt) {
        newest = { runId, details };
      }
    }
    return newest;
  };

  const stripEntry = () => {
    const running = newestEntry(
      [...activeRuns].map(([runId, run]) => [runId, run.details] as const),
    );
    return running ?? newestEntry(settledRuns);
  };

  const updateWorkflowWidget = () => {
    const ctx = lastContext;
    if (!ctx || ctx.mode !== "tui") return;
    const visible = Boolean(stripEntry());
    if (visible === widgetVisible) return;
    if (!visible) {
      stripState.focused = false;
      requestWidgetRender = undefined;
      ctx.ui.setWidget(widgetKey, undefined);
      widgetVisible = false;
      return;
    }
    ctx.ui.setWidget(
      widgetKey,
      (tui, theme) => {
        requestWidgetRender = () => tui.requestRender();
        return new WorkflowStripWidget(tui, theme, stripState, stripEntry);
      },
      { placement: "belowEditor" },
    );
    widgetVisible = true;
  };

  const updateIndicator = () => {
    const ctx = lastContext;
    if (!ctx) return;
    try {
      const running = activeRuns.size;
      if (running === 0 && completedRuns === 0 && failedRuns === 0) {
        ctx.ui.setStatus("workflows", undefined);
      } else {
        ctx.ui.setStatus(
          "workflows",
          formatActivityStatus(ctx.ui.theme, "workflows", {
            running,
            done: completedRuns,
            failed: failedRuns,
          }),
        );
      }
      updateWorkflowWidget();
    } catch {
      // UI may be unavailable.
    }
  };

  const acknowledgeSettledRuns = () => {
    completedRuns = 0;
    failedRuns = 0;
    settledRuns.clear();
  };

  const recordSettledRun = (details: WorkflowDetails) => {
    settledRuns.set(details.runId, details);
    if (details.status === "completed") completedRuns += 1;
    else failedRuns += 1;
  };

  const stopRun = (runId: string) => {
    const run = activeRuns.get(runId);
    if (!run || run.details.status !== "running") return false;
    run.controller.abort("Stopped by user");
    return true;
  };

  const openDashboard = async (
    ctx: ExtensionContext,
    initialRunId?: string,
    startedSince = turnStartedAt,
  ) => {
    if (dashboardOpen || ctx.mode !== "tui") return;
    dashboardOpen = true;
    stripState.focused = false;
    try {
      await showWorkflowDashboard(
        ctx,
        activeDetails,
        initialRunId,
        startedSince,
        stopRun,
      );
      acknowledgeSettledRuns();
    } finally {
      dashboardOpen = false;
      updateIndicator();
    }
  };

  const installWorkflowNavigation = (ctx: ExtensionContext) => {
    if (ctx.mode !== "tui") return;
    const previous = ctx.ui.getEditorComponent();
    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      const base =
        previous?.(tui, theme, keybindings) ??
        new CustomEditor(tui, theme, keybindings);
      return new WorkflowNavigationEditor(
        base,
        keybindings,
        stripState,
        () => Boolean(stripEntry()),
        () => {
          const entry = stripEntry();
          if (entry) void openDashboard(ctx, entry.runId);
        },
        () => {
          requestWidgetRender?.();
          tui.requestRender();
        },
      );
    });
  };

  pi.on("session_start", (_event, ctx) => {
    if (ctx.hasUI) lastContext = ctx;
    turnStartedAt = 0;
    completedRuns = 0;
    failedRuns = 0;
    settledRuns.clear();
    installWorkflowNavigation(ctx);
    updateIndicator();
  });

  pi.on("input", (event) => {
    if (event.source === "extension") return;
    turnStartedAt = Date.now();
    acknowledgeSettledRuns();
    updateIndicator();
  });

  pi.on("session_shutdown", async () => {
    const runs = [...activeRuns.values()];
    for (const run of runs) run.controller.abort("Session is shutting down");
    await Promise.all(
      runs.map((run) => run.controller.settle({ abort: true })),
    );
    const completions = runs
      .map((run) => run.completion)
      .filter(
        (completion): completion is Promise<void> => completion !== undefined,
      );
    if (completions.length > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 8_000);
        timer.unref?.();
      });
      await Promise.race([Promise.allSettled(completions), timeout]);
      if (timer) clearTimeout(timer);
    }
    try {
      lastContext?.ui.setStatus("workflows", undefined);
      lastContext?.ui.setWidget(widgetKey, undefined);
    } catch {
      // UI may already be disposed.
    }
    lastContext = undefined;
    widgetVisible = false;
    requestWidgetRender = undefined;
    stripState.focused = false;
  });

  pi.registerCommand("workflows", {
    description:
      "List workflow runs (`/workflows <runId>` for detail, `/workflows <runId> stop` to cancel)",
    handler: async (rawArgs, ctx) => {
      const arg = rawArgs.trim();

      // `/workflows <runId> stop` (or `stop <runId>`) cancels a running
      // workflow. Background runs otherwise only stop at session shutdown.
      const stopMatch = arg.match(/^(?:stop\s+(\S+)|(\S+)\s+stop)$/i);
      if (stopMatch) {
        const target = stopMatch[1] ?? stopMatch[2];
        const entry = [...activeRuns.entries()].find(
          ([runId, run]) =>
            (runId === target || runId.endsWith(target)) &&
            run.details.status === "running",
        );
        if (!entry) {
          ctx.ui.notify(`No running workflow matching "${target}".`, "warning");
          return;
        }
        const [runId, run] = entry;
        run.controller.abort("Stopped by user");
        ctx.ui.notify(`Stopping workflow ${runId}…`, "info");
        return;
      }

      // An explicit run id is a deliberate lookup, so it reaches session history.
      const startedSince = arg ? 0 : turnStartedAt;
      if (ctx.mode === "tui") {
        lastContext = ctx;
        await openDashboard(ctx, arg || undefined, startedSince);
        return;
      }
      // Non-TUI fallback: plain text listing.
      const runs = listRuns(
        activeDetails(),
        ctx.sessionManager.getSessionId(),
        sessionWorkflowRunIds(ctx),
        startedSince,
      );
      if (runs.length === 0) {
        ctx.ui.notify("No workflow runs for this request.", "info");
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
    description: WORKFLOW_TOOL_DESCRIPTION,
    promptSnippet: WORKFLOW_PROMPT_SNIPPET,
    promptGuidelines: WORKFLOW_PROMPT_GUIDELINES,
    parameters: WorkflowParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      let prepared: ReturnType<typeof prepareWorkflowScript>;
      try {
        prepared = prepareWorkflowScript(params.script);
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

      const meta = prepared.meta;
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
      const persistence = createWorkflowPersistence(runDir, details);

      // Background runs survive Esc on the parent turn, but all runs are
      // aborted and settled during session shutdown.
      const workflowConfig = loadSetupConfig().workflows;
      const controller = new RunController(
        background ? undefined : signal,
        workflowConfig.concurrency,
        workflowConfig.maxAgentCalls,
      );

      // Each concurrent child gets its own extension runtime. All children use
      // the parent cwd and live trust decision.
      const projectTrusted = ctx.isProjectTrusted();
      const getResources = (structured: boolean) =>
        createWorkflowResources(
          ctx.cwd,
          structured ? "structured" : "plain",
          projectTrusted,
        );

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
          details: compactToolDetails(details),
        });
      };
      const emit = (checkpoint = true) => {
        if (checkpoint) persistence.checkpoint();
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
        invocationSignal?: AbortSignal,
      ): Promise<ScriptAgentResult> => {
        const index = ++agentCounter;
        const opts: AgentCallOptions =
          optsValue && typeof optsValue === "object"
            ? (optsValue as AgentCallOptions)
            : {};
        const label =
          typeof opts.label === "string" && opts.label.trim()
            ? opts.label.trim().slice(0, 160)
            : `agent-${index}`;

        const record: AgentRecord = {
          index,
          label,
          phase:
            typeof opts.phase === "string"
              ? opts.phase.slice(0, 160)
              : details.currentPhase,
          state: "running",
          model: ctx.model?.id,
          contextWindow: ctx.model?.contextWindow,
          startedAt: Date.now(),
          preview: "",
          usage: emptyUsage(),
          transcript: [],
        };
        details.agents.push(record);
        persistence.checkpoint({ immediate: true });
        emit(false);

        const fail = (error: string): ScriptAgentResult => {
          record.state = "error";
          record.error = error;
          record.finishedAt = Date.now();
          emit();
          return { ok: false, output: "", error };
        };

        const prompt = buildWorkflowAgentPrompt(
          typeof promptValue === "string"
            ? promptValue
            : String(promptValue ?? ""),
        );
        if (!prompt.trim())
          return fail("agent() requires a non-empty prompt string");
        if (controller.signal.aborted)
          return fail("Workflow was aborted before this agent started");

        return controller
          .schedule(async (runSignal) => {
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
            record.model = model?.id;
            record.contextWindow = model?.contextWindow;
            emit();

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

            const resources = await getResources(opts.schema !== undefined);
            const outcome = await runAgent({
              prompt,
              schema: opts.schema,
              model,
              thinkingLevel,
              cwd: ctx.cwd,
              loader: resources.loader,
              settingsManager: resources.settingsManager,
              modelRegistry: ctx.modelRegistry,
              signal: runSignal,
              onProgress: (progress) => {
                record.preview = progress.preview.slice(0, PREVIEW_LENGTH);
                record.usage = progress.usage;
                record.model = progress.model ?? record.model;
                record.contextWindow =
                  progress.contextWindow ?? record.contextWindow;
                record.transcript = progress.transcript;
                emit();
              },
            });

            record.usage = outcome.usage;
            record.model = outcome.model ?? record.model;
            record.contextWindow =
              outcome.contextWindow ?? record.contextWindow;
            record.transcript = outcome.transcript;
            record.preview = (outcome.output || record.preview).slice(
              0,
              PREVIEW_LENGTH,
            );
            record.finishedAt = Date.now();
            record.state = outcome.ok ? "done" : "error";
            if (outcome.ok) {
              delete record.error;
            } else {
              record.error = outcome.error ?? "Agent failed";
            }
            emit();

            return {
              ok: outcome.ok,
              output: outcome.output,
              ...(outcome.structured !== undefined
                ? { structured: outcome.structured }
                : {}),
              ...(outcome.error !== undefined ? { error: outcome.error } : {}),
            };
          }, invocationSignal)
          .catch((error) => fail(errorText(error)));
      };

      const runScript = async () => {
        let status: WorkflowDetails["status"] = "completed";
        try {
          details.result = await runWorkflowSandbox({
            source: prepared.source,
            args,
            cwd: ctx.cwd,
            signal: controller.signal,
            onAgent: agentFn,
            onPhase: phaseFn,
            maxConcurrency: workflowConfig.concurrency,
            maxAgentCalls: workflowConfig.maxAgentCalls,
          });
        } catch (error) {
          details.error = errorText(error);
          status = controller.signal.aborted ? "aborted" : "failed";
          controller.abort("Workflow script failed");
        }

        const settled = await controller.settle({
          abort: status !== "completed",
        });
        if (!settled) {
          status = "failed";
          details.error = details.error
            ? `${details.error}; agent shutdown deadline exceeded`
            : "Agent shutdown deadline exceeded";
        }
        for (const record of details.agents) {
          if (record.state !== "running") continue;
          record.state = "error";
          record.error =
            record.error ?? "Agent did not settle before run cleanup";
          record.finishedAt = Date.now();
        }
        details.status = status;
        details.finishedAt = Date.now();
        try {
          persistence.flush();
        } catch (error) {
          details.status = "failed";
          details.error = `Artifact persistence failed: ${errorText(error)}`;
          throw new Error(details.error);
        } finally {
          flushNow();
        }
      };

      // Registered for /workflows visibility and session_shutdown abort;
      // blocking runs are watchable live from the dashboard too.
      const activeRun = { details, controller } as {
        details: WorkflowDetails;
        controller: RunController;
        completion?: Promise<void>;
      };
      activeRuns.set(runId, activeRun);
      const completion = runScript();
      activeRun.completion = completion;
      if (ctx.hasUI) lastContext = ctx;
      updateIndicator();

      if (background) {
        void completion
          .catch((error) => {
            details.status = "failed";
            details.finishedAt = Date.now();
            details.error = details.error ?? errorText(error);
          })
          .finally(() => {
            activeRuns.delete(runId);
            recordSettledRun(details);
            updateIndicator();
            try {
              // Deliver like the subagent/terminal families: a custom-typed
              // session message with a dedicated renderer, not a plain
              // user-provenance turn.
              //
              // Wake the model only if it is idle and therefore plausibly
              // waiting on this run. If it is busy with something else, the
              // result still enters context with the user's next message
              // (nextTurn) instead of forcing a turn it can only acknowledge.
              const wake = ctx.isIdle();
              pi.sendMessage(
                {
                  customType: "workflow-result",
                  content: buildBackgroundWorkflowFollowUp({
                    runId,
                    name: details.name,
                    status: details.status,
                    result: buildWorkflowResultMessage(details, runDir),
                  }),
                  display: true,
                  details: compactToolDetails(details),
                },
                wake
                  ? { deliverAs: "followUp", triggerTurn: true }
                  : { deliverAs: "nextTurn" },
              );
            } catch {
              // Session may be shutting down.
            }
          });
        return {
          content: [
            {
              type: "text",
              text: buildBackgroundWorkflowLaunchResult({
                runId,
                name: details.name,
                runDir,
              }),
            },
          ],
          details: compactToolDetails(details),
        };
      }

      try {
        await completion;
      } finally {
        activeRuns.delete(runId);
        recordSettledRun(details);
        updateIndicator();
      }
      if (details.status !== "completed") {
        // Pi marks tool failures only when execute throws; returning isError is
        // ignored by the extension API.
        throw new Error(buildWorkflowResultMessage(details, runDir));
      }
      return {
        content: [
          {
            type: "text",
            text: buildWorkflowResultMessage(details, runDir),
          },
        ],
        details: compactToolDetails(details),
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
          const context = agentContext(agent);
          text += `\n  ${stateSquare(agent.state, theme)} ${theme.fg("accent", agent.label)}${
            agent.phase ? theme.fg("dim", ` (${agent.phase})`) : ""
          }${theme.fg(
            "dim",
            `${context ? ` · ${context}` : ""} · ${formatElapsed(agent.startedAt, agent.finishedAt)}`,
          )}`;
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
          const context = agentContext(agent);
          let line = `${stateSquare(agent.state, theme)} ${theme.fg("accent", agent.label)} ${theme.fg(
            "dim",
            [context, formatElapsed(agent.startedAt, agent.finishedAt)]
              .filter(Boolean)
              .join(" · "),
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

  /** Resolve a run id (exact or suffix) to its details from live, settled, or disk. */
  const resolveRunDetails = (target: string): WorkflowDetails | undefined => {
    for (const [runId, run] of activeRuns) {
      if (runId === target || runId.endsWith(target)) return run.details;
    }
    for (const [runId, details] of settledRuns) {
      if (runId === target || runId.endsWith(target)) return details;
    }
    // Fall back to a persisted run this session may not still track in memory.
    const base = path.join(getAgentDir(), "workflows");
    let names: string[] = [];
    try {
      names = fs.readdirSync(base).filter((name) => name.startsWith("wf_"));
    } catch {
      return undefined;
    }
    const match = names.find((n) => n === target || n.endsWith(target));
    if (!match) return undefined;
    try {
      const parsed = JSON.parse(
        fs.readFileSync(path.join(base, match, "workflow.json"), "utf8"),
      ) as WorkflowDetails;
      // A run absent from activeRuns cannot still be running this session; a
      // persisted "running" is a run that was hard-killed or missed the
      // shutdown settle deadline. Normalize it to "aborted" so this detail path
      // agrees with listRuns and with workflow_stop (which reports it stopped).
      if (parsed.status === "running") {
        return { ...parsed, status: "aborted" };
      }
      return parsed;
    } catch {
      return undefined;
    }
  };

  pi.registerTool({
    name: "workflow_stop",
    label: "Stop Workflow",
    description: WORKFLOW_STOP_TOOL_DESCRIPTION,
    promptSnippet: WORKFLOW_LIFECYCLE_PROMPT_SNIPPET,
    parameters: Type.Object({
      runId: Type.String({
        description: WORKFLOW_STOP_PARAMETER_DESCRIPTIONS.runId,
      }),
    }),
    execute(_toolCallId, params) {
      const entry = [...activeRuns.entries()].find(
        ([runId, run]) =>
          (runId === params.runId || runId.endsWith(params.runId)) &&
          run.details.status === "running",
      );
      if (!entry) {
        const running = [...activeRuns.keys()];
        throw new Error(
          `No running workflow matching "${params.runId}". Running: ${running.join(", ") || "none"}.`,
        );
      }
      const [runId] = entry;
      stopRun(runId);
      return Promise.resolve({
        content: [{ type: "text", text: `Stopping workflow ${runId}.` }],
        details: { runId, status: "aborting" },
      });
    },
  });

  pi.registerTool({
    name: "workflow_status",
    label: "Workflow Status",
    description: WORKFLOW_STATUS_TOOL_DESCRIPTION,
    parameters: Type.Object({
      runId: Type.Optional(
        Type.String({
          description: WORKFLOW_STATUS_PARAMETER_DESCRIPTIONS.runId,
        }),
      ),
    }),
    execute(_toolCallId, params) {
      // Details are a uniform run-summary array (one entry for a single-id peek)
      // so the tool has a single result shape; the text carries the detail.
      const summarize = (d: WorkflowDetails) => {
        const { done, failed } = countStates(d);
        return {
          runId: d.runId,
          name: d.name,
          status: d.status,
          done,
          failed,
          total: d.agents.length,
        };
      };
      if (params.runId) {
        const details = resolveRunDetails(params.runId);
        if (!details) {
          const running = [...activeRuns.keys()];
          throw new Error(
            `No workflow matching "${params.runId}". Active: ${running.join(", ") || "none"}.`,
          );
        }
        const runDir = path.join(getAgentDir(), "workflows", details.runId);
        return Promise.resolve({
          content: [
            { type: "text", text: buildWorkflowResultMessage(details, runDir) },
          ],
          details: { runs: [summarize(details)] },
        });
      }
      const runs = [
        ...[...activeRuns.values()].map((run) => run.details),
        ...settledRuns.values(),
      ];
      if (runs.length === 0) {
        return Promise.resolve({
          content: [
            { type: "text", text: "No active or recently finished workflows." },
          ],
          details: { runs: [] },
        });
      }
      const lines = runs.map((d) => {
        const { done, failed } = countStates(d);
        return `${d.runId}${d.name ? ` "${d.name}"` : ""} — ${statusWord(d.status)} · ${done + failed}/${d.agents.length} agents${failed ? `, ${failed} failed` : ""}`;
      });
      return Promise.resolve({
        content: [{ type: "text", text: lines.join("\n") }],
        details: { runs: runs.map(summarize) },
      });
    },
  });

  pi.registerMessageRenderer(
    "workflow-result",
    (message, { expanded }, theme) => {
      const details = message.details as WorkflowDetails | undefined;
      const body =
        typeof message.content === "string"
          ? message.content
          : (message.content
              ?.map((part) => (part.type === "text" ? part.text : ""))
              .join("") ?? "");
      if (!details) return new Text(body, 0, 0);
      const { done, failed } = countStates(details);
      const settled = done + failed;
      let header =
        `${theme.fg(statusColor(details.status), SQUARE)} ${theme.fg("toolTitle", theme.bold("workflow "))}` +
        `${theme.fg("accent", details.name ?? details.runId)} ` +
        theme.fg("dim", `${settled}/${details.agents.length} agents · `) +
        theme.fg(statusColor(details.status), statusWord(details.status));
      if (failed) header += theme.fg("error", ` · ${failed} failed`);
      if (expanded) return new Text(`${header}\n\n${body}`, 0, 0);
      const preview = body.split("\n").slice(0, 8).join("\n");
      return new Text(
        `${header}\n${preview}\n${theme.fg("muted", `(${keyHint("app.tools.expand", "to expand")})`)}`,
        0,
        0,
      );
    },
  );
}
