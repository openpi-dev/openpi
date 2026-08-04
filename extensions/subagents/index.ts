/**
 * Subagents — spawn background subagents as in-process pi sessions, behind a
 * single Effect service interface.
 *
 * Tools (for the parent LLM):
 * - subagent_spawn: fire-and-forget spawn (prompt, name, optional harness,
 *   working_dir, model, reasoning_effort, and agent_type when this environment
 *   defines any). Model-spawned subagents and user /btw asides run in separate
 *   pools (MAX_RUNNING and MAX_RUNNING_BTW).
 * - subagent_wait: block until the listed subagents settle, return results.
 * - subagent_cancel: stop one or more running subagents.
 * - subagent_check: peek at a subagent's status and recent activity.
 * - subagent_list: list all subagents.
 *
 * Unawaited subagents queue their result as a follow-up message when they
 * settle. `/subagents` opens a picker + full interactive takeover view.
 *
 * Agent types (`src/agent-types.ts`) are optional named presets that fix a
 * child's system prompt, model, and tool allowlist; see `docs/agent-types.md`.
 *
 * Architecture: Effect v4 generators throughout (backend -> manager ->
 * runtime); this file is the async boundary where tool handlers run effects
 * against one shared ManagedRuntime.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  getAgentDir,
  getMarkdownTheme,
  keyHint,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Markdown, Text } from "@earendil-works/pi-tui";
import { Type, type TProperties } from "typebox";
import {
  formatAgentTypeDiagnostics,
  loadAgentTypes,
  type AgentType,
} from "./src/agent-types.ts";
import { deriveBtwTitle, isModelVisible } from "./src/by-the-way.ts";
import {
  BACKEND_NAMES,
  formatElapsed,
  latestText,
  REASONING_EFFORTS,
  type SubagentSnapshot,
} from "./src/domain.ts";
import {
  formatActivityStatus,
  hasActivity,
  unreadActivityCounts,
} from "../shared/activity-status.ts";
import { formatContextUtilization } from "./src/format.ts";
import { SubagentManager, type SubagentManagerShape } from "./src/manager.ts";
import {
  buildAgentTypeParameterDescription,
  buildSubagentResultMessage,
  buildSubagentSendResult,
  buildSubagentSpawnResult,
  buildSubagentSpawnToolDescription,
  SUBAGENT_CANCEL_PARAMETER_DESCRIPTIONS,
  SUBAGENT_CANCEL_TOOL_DESCRIPTION,
  SUBAGENT_CHECK_PARAMETER_DESCRIPTIONS,
  SUBAGENT_CHECK_TOOL_DESCRIPTION,
  SUBAGENT_LIST_TOOL_DESCRIPTION,
  SUBAGENT_SEND_PARAMETER_DESCRIPTIONS,
  SUBAGENT_SEND_TOOL_DESCRIPTION,
  SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS,
  SUBAGENT_SPAWN_PROMPT_GUIDELINES,
  SUBAGENT_SPAWN_PROMPT_SNIPPET,
  SUBAGENT_SPAWN_TOOL_DESCRIPTION,
  SUBAGENT_WAIT_PARAMETER_DESCRIPTIONS,
  SUBAGENT_WAIT_TOOL_DESCRIPTION,
} from "./src/prompt.ts";
import { createDeferredResultDelivery } from "./src/result-delivery.ts";
import { resultDeliveryOptions } from "../background-terminals/src/result-delivery.ts";
import {
  isProjectTrustedOnDisk,
  resolveStandaloneChildProjectTrust,
} from "../shared/child-session.ts";
import { loadSetupConfig } from "../shared/setup-config.ts";
import {
  createWorktree,
  reclaimWorktree,
  type Worktree,
} from "../shared/worktree.ts";
import {
  createSubagentRuntime,
  runTool,
  type SubagentRuntime,
} from "./src/runtime.ts";
import { openSubagentPicker, openSubagentTakeover } from "./src/ui/takeover.ts";
import {
  renderWaitResult,
  type WaitResultDetails,
} from "./src/ui/wait-result.ts";

const SUBAGENT_OUTPUT_MAX_BYTES = 24 * 1024;
const WAIT_OUTPUT_MAX_BYTES = 48 * 1024;
const WAIT_PER_AGENT_MAX_BYTES = 16 * 1024;

interface SpawnResultDetails {
  readonly id?: string;
  readonly title?: string;
  readonly harness?: string;
  readonly model?: string;
  readonly agentType?: string;
}

interface SubagentFinishedData {
  readonly id: string;
  readonly title: string;
  readonly status: SubagentSnapshot["status"];
  readonly elapsed: string;
}

interface BtwResultData {
  readonly id: string;
  readonly title: string;
  readonly status: SubagentSnapshot["status"];
  readonly errorText?: string;
  readonly prompt: string;
  readonly answer: string;
  readonly sessionFilePath?: string;
}

function describeSubagent(snap: SubagentSnapshot) {
  const details = [
    `${snap.backend}: ${snap.meta.modelLabel ?? "?"}`,
    formatContextUtilization(snap.usage),
    formatElapsed(snap),
    snap.cwd,
  ].filter(Boolean);
  return `${snap.id} [${snap.status}] "${snap.title}" (${details.join(", ")})`;
}

function truncatedOutput(
  snap: SubagentSnapshot,
  maxBytes = SUBAGENT_OUTPUT_MAX_BYTES,
): string {
  const output = snap.finalText || "(no output)";
  const truncation = truncateHead(output, {
    maxBytes: Math.min(maxBytes, DEFAULT_MAX_BYTES),
    maxLines: Math.min(600, DEFAULT_MAX_LINES),
  });
  let text = truncation.content;
  if (truncation.truncated) {
    text += `\n\n[Output truncated: ${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)} shown. Full transcript in session file: ${snap.meta.sessionFilePath ?? "?"}]`;
  }
  return text;
}

export default function (pi: ExtensionAPI) {
  let runtime: SubagentRuntime | undefined;
  let managerPromise: Promise<SubagentManagerShape> | undefined;
  let sessionContext: ExtensionContext | undefined;
  let ui: ExtensionUIContext | undefined;
  let unsubStatus: (() => void) | undefined;
  /**
   * Settled subagents are an unread notice: the user's next explicit request
   * acknowledges everything that had already finished.
   */
  let settledAcknowledgedAt = 0;
  /** Ticks the elapsed time on the live rows while subagents are running. */
  let statusTicker: ReturnType<typeof setInterval> | undefined;
  const resultDelivery = createDeferredResultDelivery<SubagentSnapshot>();

  const getRuntime = () => (runtime ??= createSubagentRuntime());

  /** Resolve the manager service once per runtime and wire the extension hooks. */
  const getManager = () => {
    managerPromise ??= getRuntime()
      .runPromise(SubagentManager)
      .then((manager) => {
        manager.view.setOnSettled(onSettled);
        unsubStatus?.();
        unsubStatus = manager.view.subscribe(() => updateStatus(manager));
        updateStatus(manager);
        return manager;
      });
    return managerPromise;
  };

  /** Live rows beyond this crowd out the conversation. */
  const MAX_STATUS_ROWS = 5;

  const startStatusTicker = (manager: SubagentManagerShape) => {
    if (statusTicker) return;
    // Elapsed time advances without any manager event, so redraw on a timer.
    statusTicker = setInterval(() => updateStatus(manager), 1_000);
    statusTicker.unref?.();
  };

  const stopStatusTicker = () => {
    if (!statusTicker) return;
    clearInterval(statusTicker);
    statusTicker = undefined;
  };

  const updateStatus = (manager: SubagentManagerShape) => {
    if (!ui) return;
    const theme = ui.theme;
    const subs = manager.view.list();
    const counts = unreadActivityCounts(subs, settledAcknowledgedAt);
    if (!hasActivity(counts)) {
      stopStatusTicker();
      ui.setStatus("subagents", undefined);
      return;
    }

    const lines = [formatActivityStatus(theme, "subagents", counts)];
    const running = subs.filter((snap) => snap.status === "running");
    for (const snap of running.slice(0, MAX_STATUS_ROWS)) {
      lines.push(
        `  ${theme.fg("warning", "\u25cb")} ${snap.title} ${theme.fg("dim", formatElapsed(snap))}`,
      );
    }
    if (running.length > MAX_STATUS_ROWS) {
      lines.push(
        theme.fg("dim", `  \u2026 +${running.length - MAX_STATUS_ROWS} more`),
      );
    }
    ui.setStatus("subagents", lines.join("\n"));

    if (running.length > 0) startStatusTicker(manager);
    else stopStatusTicker();
  };

  /**
   * `wake` decides whether this costs the model a turn. A subagent that
   * settled while the model sits idle is the result it is waiting on. A
   * backlog that piled up while it worked is not: waking once per stale
   * subagent forces a turn each, and the model can only answer "that one
   * already finished". `nextTurn` still enters context with the user's next
   * message, without demanding a reply.
   */
  const deliverResults = (
    snaps: readonly SubagentSnapshot[],
    wake: boolean,
  ) => {
    if (snaps.length === 0) return;
    pi.sendMessage(
      {
        customType: "subagent-result",
        // One message per flush, not per subagent.
        content: snaps
          .map((snap) =>
            buildSubagentResultMessage({
              id: snap.id,
              title: snap.title,
              status: snap.status,
              errorText: snap.errorText,
              output: truncatedOutput(snap),
            }),
          )
          .join("\n\n"),
        display: true,
        details:
          snaps.length === 1
            ? {
                id: snaps[0]!.id,
                title: snaps[0]!.title,
                status: snaps[0]!.status,
              }
            : {
                count: snaps.length,
                results: snaps.map((snap) => ({
                  id: snap.id,
                  title: snap.title,
                  status: snap.status,
                })),
              },
      },
      resultDeliveryOptions(wake),
    );
  };

  const flushResults = (wake: boolean) => {
    deliverResults(resultDelivery.drain(), wake);
  };

  const deliverBtwResult = (snap: SubagentSnapshot) => {
    // appendEntry is a synchronous SessionManager operation and emits an
    // entry_appended event, so it is safe while the parent is streaming and
    // never enters the model's context or follow-up queue.
    pi.appendEntry<BtwResultData>("btw-result", {
      id: snap.id,
      title: snap.title,
      status: snap.status,
      errorText: snap.errorText,
      prompt: snap.prompt,
      answer: truncatedOutput(snap),
      sessionFilePath: snap.meta.sessionFilePath,
    });
    ui?.notify(
      snap.status === "error"
        ? `by the way “${snap.title}” failed — reopen it with /subagents`
        : `by the way “${snap.title}” answered — reopen it with /subagents`,
      snap.status === "error" ? "error" : "info",
    );
  };

  const onSettled = (snap: SubagentSnapshot, consumed: boolean) => {
    // A shutdown can settle children while disposing their scopes. Never
    // append into a session whose extension runtime is already closing.
    if (!sessionContext) return;
    if (snap.origin === "btw") {
      deliverBtwResult({ ...snap, meta: { ...snap.meta } });
      return;
    }
    // Mark the finish in the transcript. The result itself reaches the model
    // separately; this line is for the reader watching the run.
    pi.appendEntry<SubagentFinishedData>("subagent-finished", {
      id: snap.id,
      title: snap.title,
      status: snap.status,
      elapsed: formatElapsed(snap),
    });
    if (consumed) {
      resultDelivery.consume([snap.id]);
      return;
    }
    // Keep the result retractable while the parent is working. A later
    // subagent_wait can consume it before agent_settled flushes follow-ups.
    // Defer a copy: the live snapshot keeps mutating if the subagent is
    // restarted before the deferred result flushes.
    resultDelivery.defer({ ...snap, meta: { ...snap.meta } });
    // Settled while the model sits idle: it has nothing else in flight, so
    // this is the result it is waiting on — wake it.
    if (sessionContext?.isIdle()) flushResults(true);
  };

  pi.on("session_start", (_event, ctx) => {
    sessionContext = ctx;
    settledAcknowledgedAt = 0;
    if (ctx.hasUI) ui = ctx.ui;
    // A malformed agent type is silently missing from the roster otherwise, so
    // report it once the UI exists. Never fatal: the rest still loaded.
    const notice = formatAgentTypeDiagnostics(agentTypeDiagnostics);
    if (notice && ctx.hasUI) ctx.ui.notify(notice, "warning");
  });

  // A new explicit request starts a fresh unread window: previously finished
  // subagents stop being reported, running ones keep reporting.
  pi.on("input", (event) => {
    if (event.source === "extension") return;
    settledAcknowledgedAt = Date.now();
    managerPromise?.then(updateStatus).catch(() => undefined);
  });

  // These settled while the model was working on something else, so they go
  // into context without forcing a turn per stale subagent.
  pi.on("agent_settled", () => flushResults(false));

  pi.on("session_shutdown", async () => {
    sessionContext = undefined;
    stopStatusTicker();
    resultDelivery.clear();
    unsubStatus?.();
    unsubStatus = undefined;
    ui?.setStatus("subagents", undefined);
    ui = undefined;
    const closing = runtime;
    runtime = undefined;
    managerPromise = undefined;
    // Disposing the runtime runs the manager finalizer, which tears down all
    // subagent scopes (and, later, their real child processes).
    await closing?.dispose();
  });

  // --- Agent types ---------------------------------------------------------

  /**
   * Discovered once, here, because a tool's description is a static string
   * fixed at registration — the roster has to be known before the model ever
   * sees the tool. Registration runs before session_start, so there is no
   * `ctx.cwd` yet and no resolved trust; use the process cwd and consult the
   * persisted trust store directly, exactly as a standalone child would.
   * Consequence: edits to `agents/*.md` take effect on `/reload`, like skills.
   */
  const { agentTypes, diagnostics: agentTypeDiagnostics } = loadAgentTypes({
    agentDir: getAgentDir(),
    cwd: process.cwd(),
    projectTrusted: isProjectTrustedOnDisk(process.cwd()),
  });
  const agentTypeList = [...agentTypes.values()];
  /**
   * Disambiguates worktree directory/branch names. The subagent id is only
   * assigned inside the manager, after the worktree already has to exist, and
   * two children with the same title would otherwise collide on the branch.
   */
  let worktreeCounter = 0;
  /** Only add the parameter when types exist, so a bare install is unchanged. */
  const agentTypeParameters: TProperties =
    agentTypeList.length > 0
      ? {
          agent_type: Type.Optional(
            StringEnum(
              agentTypeList.map((agentType) => agentType.name) as [
                string,
                ...string[],
              ],
              {
                description: buildAgentTypeParameterDescription(agentTypeList),
              },
            ),
          ),
        }
      : {};

  // --- Tools -------------------------------------------------------------

  pi.registerTool({
    name: "subagent_spawn",
    label: "Spawn Subagent",
    description: buildSubagentSpawnToolDescription(agentTypeList),
    promptSnippet: SUBAGENT_SPAWN_PROMPT_SNIPPET,
    promptGuidelines: SUBAGENT_SPAWN_PROMPT_GUIDELINES,
    parameters: Type.Object({
      ...agentTypeParameters,
      prompt: Type.String({
        description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.prompt,
      }),
      name: Type.String({
        description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.name,
      }),
      harness: Type.Optional(
        StringEnum(BACKEND_NAMES, {
          description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.harness,
        }),
      ),
      working_dir: Type.Optional(
        Type.String({
          description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.workingDir,
        }),
      ),
      isolation: Type.Optional(
        StringEnum(["worktree"] as const, {
          description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.isolation,
        }),
      ),
      model: Type.Optional(
        Type.String({
          description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.model,
        }),
      ),
      reasoning_effort: Type.Optional(
        StringEnum(REASONING_EFFORTS, {
          description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.reasoningEffort,
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const manager = await getManager();
      // Only one backend exists; harness is optional and defaults to it.
      const harness = params.harness ?? BACKEND_NAMES[0];

      const cwd = path.resolve(ctx.cwd, params.working_dir ?? ".");
      if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
        throw new Error(`working_dir is not a directory: ${cwd}`);
      }

      // Present only when types were discovered, so this is absent on a bare
      // install; the enum already rejects an unknown name.
      const requestedType = (params as { agent_type?: string }).agent_type;
      const agentType = requestedType
        ? agentTypes.get(requestedType)
        : undefined;

      const title = params.name.trim().slice(0, 160) || "subagent";

      /**
       * Isolation is requested, not best-effort: a caller asks for a worktree
       * precisely because a shared checkout would let this child collide with
       * its siblings, so quietly falling back to `cwd` would deliver the
       * hazard they were avoiding. Fail loudly with git's own reason instead.
       */
      let worktree: Worktree | undefined;
      if (params.isolation === "worktree") {
        const created = await createWorktree({
          cwd,
          label: title,
          id: String(++worktreeCounter),
        });
        if (!created.ok) {
          throw new Error(
            `isolation: "worktree" requested but could not be created (${created.reason}). Omit isolation to run in ${cwd}.`,
          );
        }
        worktree = created.worktree;
      }
      const childCwd = worktree?.path ?? cwd;

      /**
       * Trust follows the directory the worktree was branched from, not the
       * worktree path. It is the same project at the same commit, so a live
       * "trusted" decision that was never persisted must not be downgraded
       * just because the checkout moved into `.git/`.
       */
      const projectTrusted = resolveStandaloneChildProjectTrust({
        parentCwd: ctx.cwd,
        childCwd: cwd,
        parentTrusted: ctx.isProjectTrusted(),
      });

      const spawn = manager.spawn(harness, {
        prompt: params.prompt,
        title,
        cwd: childCwd,
        // An explicit argument beats the type's own preference.
        model: params.model ?? agentType?.model,
        reasoningEffort: params.reasoning_effort ?? agentType?.reasoningEffort,
        ...(agentType?.body ? { appendSystemPrompt: [agentType.body] } : {}),
        ...(agentType?.tools ? { tools: agentType.tools } : {}),
        ...(agentType ? { agentTypeName: agentType.name } : {}),
        ...(worktree ? { worktree: { ...worktree, repoCwd: cwd } } : {}),
        parent: {
          parentCwd: ctx.cwd,
          projectTrusted,
          inheritedModel: ctx.model
            ? { provider: ctx.model.provider, id: ctx.model.id }
            : undefined,
          inheritedThinkingLevel: pi.getThinkingLevel(),
          modelRegistry: ctx.modelRegistry,
        },
      });

      let snap;
      try {
        snap = await runTool(getRuntime(), spawn, {
          signal,
          interruptMessage: "Subagent spawn aborted.",
        });
      } catch (error) {
        // The session scope owns reclamation, but it never opened, so this
        // worktree would otherwise be orphaned on disk.
        if (worktree) await reclaimWorktree(cwd, worktree).catch(() => {});
        throw error;
      }

      return {
        content: [
          {
            type: "text",
            text: buildSubagentSpawnResult({
              id: snap.id,
              title: snap.title,
              harness,
              modelLabel: snap.meta.modelLabel ?? "?",
              cwd: childCwd,
              ...(worktree ? { worktreeBranch: worktree.branch } : {}),
              ...(agentType
                ? {
                    agentTypeName: agentType.name,
                    ...(agentType.tools ? { tools: agentType.tools } : {}),
                  }
                : {}),
            }),
          },
        ],
        details: {
          id: snap.id,
          title: snap.title,
          cwd: childCwd,
          harness,
          model: snap.meta.modelLabel,
          ...(agentType ? { agentType: agentType.name } : {}),
        },
      };
    },
    renderCall() {
      // The result line already names the agent; a bare tool header adds nothing.
      return new Text("");
    },
    renderResult(result, _options, theme) {
      const details = result.details as SpawnResultDetails | undefined;
      if (!details?.id) {
        const first = result.content[0];
        return new Text(
          first?.type === "text" ? first.text : "(no output)",
          0,
          0,
        );
      }
      const meta = [details.harness, details.model]
        .filter(Boolean)
        .join(" \u00b7 ");
      return new Text(
        `${theme.fg("success", "\u25cf")} ${theme.bold(details.title ?? details.id)} ${theme.fg("dim", meta)}`,
        0,
        0,
      );
    },
  });

  pi.registerTool({
    name: "subagent_wait",
    label: "Wait for Subagents",
    description: SUBAGENT_WAIT_TOOL_DESCRIPTION,
    parameters: Type.Object({
      ids: Type.Array(Type.String(), {
        maxItems: 64,
        description: SUBAGENT_WAIT_PARAMETER_DESCRIPTIONS.ids,
      }),
    }),
    async execute(_toolCallId, params, signal, onUpdate) {
      const manager = await getManager();
      const ids = [...new Set(params.ids)];
      if (ids.length === 0)
        throw new Error("Provide at least one subagent id.");
      const known = manager.view
        .list()
        .filter(isModelVisible)
        .map((snap) => snap.id);
      const unknown = ids.filter((id) => {
        const snap = manager.view.get(id);
        return !snap || !isModelVisible(snap);
      });
      if (unknown.length > 0) {
        throw new Error(
          `Unknown subagent id(s): ${unknown.join(", ")}. Known: ${known.join(", ") || "none"}.`,
        );
      }

      await runTool(
        getRuntime(),
        manager.waitFor(ids, (pending) => {
          onUpdate?.({
            content: [
              { type: "text", text: `Waiting for ${pending.join(", ")}...` },
            ],
            details: { pending },
          });
        }),
        { signal, interruptMessage: "Wait aborted. Subagents keep running." },
      );

      // Settlement may have happened before this wait began. Remove any
      // deferred automatic delivery now that the tool is returning the result.
      resultDelivery.consume(ids);

      const sections: string[] = [];
      let remainingBytes = WAIT_OUTPUT_MAX_BYTES;
      for (const id of ids) {
        const snap = manager.view.get(id);
        if (!snap) {
          sections.push(`## ${id}\n\n(no longer tracked)`);
          continue;
        }
        const verb = snap.status === "error" ? "failed" : "finished";
        let section = `## ${snap.id} "${snap.title}" ${verb}`;
        if (snap.errorText) section += `\nError: ${snap.errorText}`;
        const headerBytes = Buffer.byteLength(section, "utf8") + 2;
        const outputBudget = Math.max(
          512,
          Math.min(WAIT_PER_AGENT_MAX_BYTES, remainingBytes - headerBytes),
        );
        section += `\n\n${truncatedOutput(snap, outputBudget)}`;
        const sectionBytes = Buffer.byteLength(section, "utf8");
        if (sectionBytes > remainingBytes) {
          sections.push(
            `## ${snap.id} "${snap.title}"\n\n[omitted: total wait output limit reached]`,
          );
          break;
        }
        sections.push(section);
        remainingBytes -= sectionBytes;
      }

      const combined = sections.join("\n\n---\n\n");
      const bounded = truncateHead(combined, {
        maxBytes: WAIT_OUTPUT_MAX_BYTES - 128,
        maxLines: DEFAULT_MAX_LINES,
      });
      const text = bounded.truncated
        ? `${bounded.content}\n\n[wait output truncated at the total output limit]`
        : bounded.content;
      return {
        content: [{ type: "text", text }],
        details: {
          results: ids.map((id) => {
            const snap = manager.view.get(id);
            return { id, title: snap?.title, status: snap?.status };
          }),
        },
      };
    },
    renderResult(result, { expanded, isPartial }, theme) {
      const first = result.content[0];
      const content = first?.type === "text" ? first.text : "(no output)";
      if (isPartial) {
        const pending = (result.details as { pending?: string[] } | undefined)
          ?.pending?.length;
        return new Text(
          theme.fg(
            "warning",
            pending
              ? `\u273b Waiting for ${pending} subagent${pending === 1 ? "" : "s"} to finish`
              : content,
          ),
          0,
          0,
        );
      }
      return renderWaitResult(
        content,
        result.details as WaitResultDetails | undefined,
        expanded || loadSetupConfig().ui.subagentResultDisplay === "full",
        theme,
      );
    },
  });

  pi.registerTool({
    name: "subagent_cancel",
    label: "Cancel Subagents",
    description: SUBAGENT_CANCEL_TOOL_DESCRIPTION,
    parameters: Type.Object({
      ids: Type.Array(Type.String(), {
        description: SUBAGENT_CANCEL_PARAMETER_DESCRIPTIONS.ids,
      }),
    }),
    async execute(_toolCallId, params, signal) {
      const manager = await getManager();
      const ids = [...new Set(params.ids)];
      if (ids.length === 0)
        throw new Error("Provide at least one subagent id.");

      const known = manager.view
        .list()
        .filter(isModelVisible)
        .map((snap) => snap.id);
      const unknown = ids.filter((id) => {
        const snap = manager.view.get(id);
        return !snap || !isModelVisible(snap);
      });
      if (unknown.length > 0) {
        throw new Error(
          `Unknown subagent id(s): ${unknown.join(", ")}. Known: ${known.join(", ") || "none"}.`,
        );
      }

      const report = await runTool(getRuntime(), manager.cancel(ids), {
        signal,
        interruptMessage: "Subagent cancellation aborted.",
      });

      const lines = report.map((entry) =>
        entry.cancelled
          ? `Cancelled ${entry.id} "${entry.title}".`
          : `${entry.id} "${entry.title}" was already ${entry.status}.`,
      );

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          results: report.map((entry) => ({
            id: entry.id,
            title: entry.title,
            status: entry.status,
          })),
        },
      };
    },
  });

  pi.registerTool({
    name: "subagent_send",
    label: "Send to Subagent",
    description: SUBAGENT_SEND_TOOL_DESCRIPTION,
    parameters: Type.Object({
      id: Type.String({
        description: SUBAGENT_SEND_PARAMETER_DESCRIPTIONS.id,
      }),
      text: Type.String({
        description: SUBAGENT_SEND_PARAMETER_DESCRIPTIONS.text,
      }),
    }),
    async execute(_toolCallId, params, signal) {
      const manager = await getManager();
      const snap = manager.view.get(params.id);
      if (!snap || !isModelVisible(snap)) {
        const known = manager.view
          .list()
          .filter(isModelVisible)
          .map((s) => s.id);
        throw new Error(
          `Unknown subagent id "${params.id}". Known: ${known.join(", ") || "none"}.`,
        );
      }
      const text = params.text.trim();
      if (!text) throw new Error("Provide a non-empty message.");

      // Captured before the send: a settled subagent restarts, a running one
      // is steered, and the result message must say which happened.
      const wasRunning = snap.status === "running";
      await runTool(getRuntime(), manager.send(params.id, text), {
        signal,
        interruptMessage: "Subagent send aborted.",
      });
      // A settled subagent may already have an undelivered result buffered;
      // the restart supersedes it, so drop it and let the new run deliver.
      resultDelivery.consume([params.id]);

      return {
        content: [
          {
            type: "text",
            text: buildSubagentSendResult({
              id: snap.id,
              title: snap.title,
              wasRunning,
            }),
          },
        ],
        details: {
          id: snap.id,
          title: snap.title,
          status: manager.view.get(params.id)?.status ?? snap.status,
        },
      };
    },
  });

  pi.registerTool({
    name: "subagent_check",
    label: "Check Subagent",
    description: SUBAGENT_CHECK_TOOL_DESCRIPTION,
    parameters: Type.Object({
      id: Type.String({
        description: SUBAGENT_CHECK_PARAMETER_DESCRIPTIONS.id,
      }),
    }),
    async execute(_toolCallId, params) {
      const manager = await getManager();
      const snap = manager.view.get(params.id);
      if (!snap || !isModelVisible(snap)) {
        const known = manager.view
          .list()
          .filter(isModelVisible)
          .map((s) => s.id);
        throw new Error(
          `Unknown subagent id "${params.id}". Known: ${known.join(", ") || "none"}.`,
        );
      }

      let text = `${describeSubagent(snap)}\nTurns: ${snap.turns}`;
      if (snap.errorText) text += `\nError: ${snap.errorText}`;

      const output = latestText(snap);
      if (output) {
        const preview = truncateHead(output, { maxBytes: 2048, maxLines: 20 });
        text += `\n\nLatest output:\n${preview.content}`;
        if (preview.truncated) text += "\n[...]";
      } else if (snap.status === "running") {
        text += "\n\n(no text output yet)";
      }

      return {
        content: [{ type: "text", text }],
        details: { id: snap.id, status: snap.status, turns: snap.turns },
      };
    },
  });

  pi.registerTool({
    name: "subagent_list",
    label: "List Subagents",
    description: SUBAGENT_LIST_TOOL_DESCRIPTION,
    parameters: Type.Object({}),
    async execute() {
      const manager = await getManager();
      const subs = manager.view.list().filter(isModelVisible);
      const text =
        subs.length === 0
          ? "No subagents."
          : subs.map((snap) => describeSubagent(snap)).join("\n");
      return {
        content: [{ type: "text", text }],
        details: {
          subagents: subs.map((snap) => ({
            id: snap.id,
            title: snap.title,
            harness: snap.backend,
            status: snap.status,
          })),
        },
      };
    },
  });

  // --- Result message rendering ------------------------------------------

  pi.registerMessageRenderer(
    "subagent-result",
    (message, { expanded }, theme) => {
      const details = (message.details ?? {}) as {
        id?: string;
        title?: string;
        status?: string;
      };
      const failed = details.status === "error";
      const icon = failed ? theme.fg("error", "x") : theme.fg("success", "■");
      const header =
        `${icon} ` +
        theme.fg("accent", theme.bold(`subagent ${details.id ?? "?"}`)) +
        theme.fg(
          "muted",
          ` · ${details.title ?? ""} · ${failed ? "failed" : "finished"}`,
        );

      const content =
        typeof message.content === "string" ? message.content : "";
      // Remove only the summary line. The following Error line (when present)
      // is part of the actual result and must remain visible.
      const body = content.split("\n").slice(1).join("\n").trim();

      if (expanded || loadSetupConfig().ui.subagentResultDisplay === "full") {
        const md = new Markdown(`${body}`, 0, 0, getMarkdownTheme());
        const container = new Text(header, 0, 0);
        return {
          render: (width: number) => [
            ...container.render(width),
            ...md.render(width),
          ],
          invalidate: () => {
            container.invalidate();
            md.invalidate();
          },
        };
      }

      const previewLines = body.split("\n").slice(0, 8);
      let text = header;
      for (const line of previewLines)
        text += `\n${theme.fg("toolOutput", line)}`;
      if (body.split("\n").length > 8)
        text += `\n${theme.fg("dim", `... (${keyHint("app.tools.expand", "to expand")})`)}`;
      return new Text(text, 0, 0);
    },
  );

  pi.registerEntryRenderer<SubagentFinishedData>(
    "subagent-finished",
    (entry, _options, theme) => {
      const data = entry.data;
      const failed = data?.status === "error";
      return new Text(
        `${theme.fg(failed ? "error" : "success", "\u25cf")} ` +
          theme.fg(
            "muted",
            `Agent "${data?.title ?? "?"}" ${failed ? "failed" : "finished"} \u00b7 ${data?.elapsed ?? "?"}`,
          ),
        1,
        0,
      );
    },
  );

  pi.registerEntryRenderer<BtwResultData>(
    "btw-result",
    (entry, { expanded }, theme) => {
      const data = entry.data;
      const failed = data?.status === "error";
      const icon = failed ? theme.fg("error", "x") : theme.fg("success", "■");
      const header =
        `${icon} ` +
        theme.fg("accent", theme.bold(`by the way · ${data?.title ?? "?"}`)) +
        theme.fg(
          "muted",
          ` · ${failed ? "failed" : "answered"} · ${data?.id ?? "?"}`,
        );
      const body = [
        data?.errorText ? `Error: ${data.errorText}` : "",
        data?.answer ?? "(no answer)",
      ]
        .filter(Boolean)
        .join("\n\n");

      if (expanded || loadSetupConfig().ui.subagentResultDisplay === "full") {
        const md = new Markdown(body, 0, 0, getMarkdownTheme());
        const container = new Text(header, 0, 0);
        return {
          render: (width: number) => [
            ...container.render(width),
            ...md.render(width),
          ],
          invalidate: () => {
            container.invalidate();
            md.invalidate();
          },
        };
      }

      const lines = body.split("\n");
      let text = header;
      for (const line of lines.slice(0, 8))
        text += `\n${theme.fg("toolOutput", line)}`;
      if (lines.length > 8)
        text += `\n${theme.fg("dim", `... (${keyHint("app.tools.expand", "to expand")})`)}`;
      return new Text(text, 0, 0);
    },
  );

  // --- Commands -----------------------------------------------------------

  const runByTheWay = async (rawArgs: string, ctx: ExtensionCommandContext) => {
    if (ctx.mode !== "tui") {
      if (ctx.hasUI)
        ctx.ui.notify("by the way is only available in the TUI", "error");
      return;
    }

    let prompt = rawArgs.trim();
    if (!prompt) {
      const input = await ctx.ui.input("by the way", "Ask a one-off question…");
      prompt = input?.trim() ?? "";
      if (!prompt) return;
    }

    const manager = await getManager();
    let snap: SubagentSnapshot;
    try {
      snap = await runTool(
        getRuntime(),
        manager.spawn("pi", {
          origin: "btw",
          prompt,
          title: deriveBtwTitle(prompt),
          cwd: ctx.cwd,
          parent: {
            parentCwd: ctx.cwd,
            projectTrusted: ctx.isProjectTrusted(),
            inheritedModel: ctx.model
              ? { provider: ctx.model.provider, id: ctx.model.id }
              : undefined,
            inheritedThinkingLevel: pi.getThinkingLevel(),
            modelRegistry: ctx.modelRegistry,
          },
        }),
      );
    } catch (error) {
      ctx.ui.notify(
        error instanceof Error ? error.message : String(error),
        "error",
      );
      return;
    }

    await openSubagentTakeover(ctx, manager.view, snap.id, {
      badge: "by the way",
    });
  };

  pi.registerCommand("btw", {
    description:
      "Ask a one-off side question while the main agent keeps working",
    handler: runByTheWay,
  });

  pi.registerCommand("subagents", {
    description: "List, inspect, and take over subagents",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        if (ctx.hasUI)
          ctx.ui.notify(
            "Subagent takeover is only available in the TUI",
            "error",
          );
        return;
      }
      const manager = await getManager();
      if (manager.view.size() === 0) {
        ctx.ui.notify(
          "No subagents yet. The agent spawns them with subagent_spawn.",
          "info",
        );
        return;
      }
      await openSubagentPicker(ctx, manager.view);
    },
  });
}
