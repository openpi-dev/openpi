/**
 * Subagents - spawn background pi threads from the parent agent.
 *
 * Tools (for the parent LLM):
 * - subagent_spawn: fire-and-forget spawn (prompt, title, working_dir, model,
 *   provider, reasoning_effort). Max 4 running at once.
 * - subagent_wait: block until the listed subagents settle, return results.
 * - subagent_cancel: stop one or more running subagents.
 * - subagent_check: peek at a subagent's status and recent activity.
 * - subagent_list: list all subagents.
 *
 * Unawaited subagents queue their result as a follow-up message when they
 * settle. `/subagents` opens a picker + full interactive takeover view.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  getMarkdownTheme,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Markdown, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  finalOutput,
  formatElapsed,
  MAX_RUNNING,
  type Subagent,
  SubagentManager,
  type ThinkingLevel,
} from "./manager.ts";
import { openSubagentPicker } from "./takeover.ts";

const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

function describeSubagent(sub: Subagent): string {
  const model = sub.session.model;
  return `${sub.id} [${sub.status}] "${sub.title}" (${model ? `${model.provider}/${model.id}` : "?"}, ${formatElapsed(sub)}, ${sub.cwd})`;
}

function truncatedOutput(sub: Subagent): string {
  const output = finalOutput(sub) || "(no output)";
  const truncation = truncateHead(output, {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  });
  let text = truncation.content;
  if (truncation.truncated) {
    text += `\n\n[Output truncated: ${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)} shown. Full transcript in session file: ${sub.session.sessionFile ?? "?"}]`;
  }
  return text;
}

function buildResultText(sub: Subagent): string {
  const verb = sub.status === "error" ? "failed" : "finished";
  let text = `Subagent ${sub.id} "${sub.title}" ${verb}.`;
  if (sub.errorText) text += `\nError: ${sub.errorText}`;
  text += `\n\n${truncatedOutput(sub)}`;
  return text;
}

function resolveModel(
  ctx: ExtensionContext,
  provider: string | undefined,
  modelId: string | undefined,
): Model<any> {
  if (!provider && !modelId) {
    if (!ctx.model)
      throw new Error("No model is currently active to inherit from.");
    return ctx.model;
  }
  if (!modelId) {
    throw new Error(
      `Provider "${provider}" given without a model. Specify model too.`,
    );
  }
  const preferredProvider = provider ?? ctx.model?.provider;
  if (preferredProvider) {
    const found = ctx.modelRegistry.find(preferredProvider, modelId);
    if (found) return found;
  }
  if (provider) {
    throw new Error(`Unknown model "${provider}/${modelId}".`);
  }
  const matches = ctx.modelRegistry.getAll().filter((m) => m.id === modelId);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error(
      `Model "${modelId}" exists in multiple providers (${matches.map((m) => m.provider).join(", ")}). Specify a provider.`,
    );
  }
  throw new Error(`Unknown model "${modelId}".`);
}

export default function (pi: ExtensionAPI) {
  const manager = new SubagentManager();
  let ui: ExtensionUIContext | undefined;

  const updateStatus = () => {
    if (!ui) return;
    const subs = manager.list();
    if (subs.length === 0) {
      ui.setStatus("subagents", undefined);
      return;
    }
    const running = subs.filter((sub) => sub.status === "running").length;
    const failed = subs.filter((sub) => sub.status === "error").length;
    const done = subs.length - running - failed;
    const theme = ui.theme;
    const parts: string[] = [];
    if (running > 0) parts.push(theme.fg("warning", `* ${running} running`));
    if (done > 0) parts.push(theme.fg("success", `■ ${done} done`));
    if (failed > 0) parts.push(theme.fg("error", `x ${failed} failed`));
    parts.push(theme.fg("dim", "/subagents to view"));
    ui.setStatus(
      "subagents",
      `${theme.fg("muted", "subagents:")} ${parts.join(theme.fg("dim", " · "))}`,
    );
  };

  manager.addChangeListener(updateStatus);

  manager.onSettled = (sub, consumed) => {
    if (consumed) return;
    pi.sendMessage(
      {
        customType: "subagent-result",
        content: buildResultText(sub),
        display: true,
        details: { id: sub.id, title: sub.title, status: sub.status },
      },
      { deliverAs: "followUp", triggerTurn: true },
    );
  };

  pi.on("session_start", (_event, ctx) => {
    if (ctx.hasUI) ui = ctx.ui;
    updateStatus();
  });

  pi.on("session_shutdown", async () => {
    ui?.setStatus("subagents", undefined);
    await manager.disposeAll();
  });

  // --- Tools -------------------------------------------------------------

  pi.registerTool({
    name: "subagent_spawn",
    label: "Spawn Subagent",
    description: [
      "Spawn a background subagent: a fully autonomous pi thread with its own context window and all coding tools.",
      "Fire-and-forget: this returns immediately with an id. The subagent's final output is queued back to you as a message when it settles,",
      "or collect it explicitly with subagent_wait. The subagent cannot see this conversation, so the prompt must be self-contained.",
      `Max ${MAX_RUNNING} subagents can be running at once.`,
    ].join(" "),
    promptSnippet:
      "Spawn a background subagent (own context, all tools) for a self-contained task",
    promptGuidelines: [
      "Use subagent_spawn to delegate self-contained tasks that can run in the background; give it a complete, standalone prompt.",
      "After subagent_spawn, keep working; results arrive automatically. Only call subagent_wait when you cannot proceed without the result.",
    ],
    parameters: Type.Object({
      prompt: Type.String({
        description:
          "Task prompt for the subagent. Must be self-contained: include all needed context, file paths, and what to report back.",
      }),
      title: Type.String({
        description: "Short human-readable title for this subagent",
      }),
      working_dir: Type.Optional(
        Type.String({
          description: "Working directory (default: current working directory)",
        }),
      ),
      model: Type.Optional(
        Type.String({
          description: "Model id (default: inherit the current model)",
        }),
      ),
      provider: Type.Optional(
        Type.String({
          description: "Model provider (default: inherit the current provider)",
        }),
      ),
      reasoning_effort: Type.Optional(
        StringEnum(THINKING_LEVELS, {
          description: "Thinking level (default: inherit the current level)",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const model = resolveModel(ctx, params.provider, params.model);
      const thinkingLevel = (params.reasoning_effort ??
        pi.getThinkingLevel()) as ThinkingLevel;

      const cwd = path.resolve(ctx.cwd, params.working_dir ?? ".");
      if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
        throw new Error(`working_dir is not a directory: ${cwd}`);
      }

      const sub = await manager.spawn({
        prompt: params.prompt,
        title: params.title,
        cwd,
        model,
        thinkingLevel,
      });

      return {
        content: [
          {
            type: "text",
            text:
              `Spawned subagent ${sub.id} "${sub.title}" (${model.provider}/${model.id}, ${cwd}).\n` +
              `It runs in the background. Its result will be delivered to you when it finishes, ` +
              `or use subagent_wait(ids: ["${sub.id}"]) to block for it, subagent_cancel to stop it, subagent_check to peek, subagent_list to see all.`,
          },
        ],
        details: {
          id: sub.id,
          title: sub.title,
          cwd,
          model: `${model.provider}/${model.id}`,
        },
      };
    },
  });

  pi.registerTool({
    name: "subagent_wait",
    label: "Wait for Subagents",
    description:
      "Block until all listed subagents have settled, then return their final outputs. Prefer letting results arrive automatically; use this only when you need a result before continuing.",
    parameters: Type.Object({
      ids: Type.Array(Type.String(), {
        description: 'Subagent ids to wait for, e.g. ["sa-1", "sa-2"]',
      }),
    }),
    async execute(_toolCallId, params, signal, onUpdate) {
      if (params.ids.length === 0)
        throw new Error("Provide at least one subagent id.");
      const known = manager.list().map((sub) => sub.id);
      const unknown = params.ids.filter((id) => !manager.get(id));
      if (unknown.length > 0) {
        throw new Error(
          `Unknown subagent id(s): ${unknown.join(", ")}. Known: ${known.join(", ") || "none"}.`,
        );
      }

      await manager.waitFor(params.ids, signal, (pending) => {
        onUpdate?.({
          content: [
            { type: "text", text: `Waiting for ${pending.join(", ")}...` },
          ],
          details: { pending },
        });
      });

      if (signal?.aborted)
        throw new Error("Wait aborted. Subagents keep running.");

      const sections = params.ids.map((id) => {
        const sub = manager.get(id);
        if (!sub) return `## ${id}\n\n(no longer tracked)`;
        const verb = sub.status === "error" ? "failed" : "finished";
        let section = `## ${sub.id} "${sub.title}" ${verb}`;
        if (sub.errorText) section += `\nError: ${sub.errorText}`;
        section += `\n\n${truncatedOutput(sub)}`;
        return section;
      });

      return {
        content: [{ type: "text", text: sections.join("\n\n---\n\n") }],
        details: {
          results: params.ids.map((id) => {
            const sub = manager.get(id);
            return { id, title: sub?.title, status: sub?.status };
          }),
        },
      };
    },
  });

  pi.registerTool({
    name: "subagent_cancel",
    label: "Cancel Subagents",
    description:
      "Cancel one or more running subagents. This aborts their active model/tool work but preserves their partial session transcripts on disk.",
    parameters: Type.Object({
      ids: Type.Array(Type.String(), {
        description: 'Subagent ids to cancel, e.g. ["sa-1", "sa-2"]',
      }),
    }),
    async execute(_toolCallId, params) {
      const ids = [...new Set(params.ids)];
      if (ids.length === 0)
        throw new Error("Provide at least one subagent id.");

      const known = manager.list().map((sub) => sub.id);
      const unknown = ids.filter((id) => !manager.get(id));
      if (unknown.length > 0) {
        throw new Error(
          `Unknown subagent id(s): ${unknown.join(", ")}. Known: ${known.join(", ") || "none"}.`,
        );
      }

      const running = ids
        .map((id) => manager.get(id))
        .filter((sub): sub is Subagent => sub?.status === "running");

      // Mark these results as consumed before aborting so cancellation does not
      // also enqueue duplicate automatic result messages into the parent.
      const waitForSettled = manager.waitFor(running.map((sub) => sub.id));
      await Promise.all(running.map((sub) => manager.abort(sub)));
      await waitForSettled;

      const lines = ids.map((id) => {
        const sub = manager.get(id)!;
        return running.includes(sub)
          ? `Cancelled ${sub.id} "${sub.title}".`
          : `${sub.id} "${sub.title}" was already ${sub.status}.`;
      });

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          results: ids.map((id) => {
            const sub = manager.get(id)!;
            return { id, title: sub.title, status: sub.status };
          }),
        },
      };
    },
  });

  pi.registerTool({
    name: "subagent_check",
    label: "Check Subagent",
    description:
      "Peek at a subagent's status and recent activity without blocking. Does not consume its result.",
    parameters: Type.Object({
      id: Type.String({ description: "Subagent id" }),
    }),
    async execute(_toolCallId, params) {
      const sub = manager.get(params.id);
      if (!sub) {
        const known = manager.list().map((s) => s.id);
        throw new Error(
          `Unknown subagent id "${params.id}". Known: ${known.join(", ") || "none"}.`,
        );
      }

      const turns = sub.session.messages.filter(
        (msg) => (msg as { role?: string }).role === "assistant",
      ).length;
      let text = `${describeSubagent(sub)}\nTurns: ${turns}`;
      if (sub.errorText) text += `\nError: ${sub.errorText}`;

      const output = finalOutput(sub);
      if (output) {
        const preview = truncateHead(output, { maxBytes: 2048, maxLines: 20 });
        text += `\n\nLatest output:\n${preview.content}`;
        if (preview.truncated) text += "\n[...]";
      } else if (sub.status === "running") {
        text += "\n\n(no text output yet)";
      }

      return {
        content: [{ type: "text", text }],
        details: { id: sub.id, status: sub.status, turns },
      };
    },
  });

  pi.registerTool({
    name: "subagent_list",
    label: "List Subagents",
    description: "List all subagents (running and finished) with their status.",
    parameters: Type.Object({}),
    async execute() {
      const subs = manager.list();
      const text =
        subs.length === 0
          ? "No subagents."
          : subs.map((sub) => describeSubagent(sub)).join("\n");
      return {
        content: [{ type: "text", text }],
        details: {
          subagents: subs.map((sub) => ({
            id: sub.id,
            title: sub.title,
            status: sub.status,
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
      const body = content.split("\n").slice(2).join("\n").trim();

      if (expanded) {
        const md = new Markdown(`${body}`, 0, 0, getMarkdownTheme());
        const container = new Text(header, 0, 0);
        // Text can't hold children; render header + markdown via a simple approach:
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
        text += `\n${theme.fg("dim", "... (ctrl+o to expand)")}`;
      return new Text(text, 0, 0);
    },
  );

  // --- Command ------------------------------------------------------------

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
      if (manager.size() === 0) {
        ctx.ui.notify(
          "No subagents yet. The agent spawns them with subagent_spawn.",
          "info",
        );
        return;
      }
      await openSubagentPicker(ctx, manager);
    },
  });
}
