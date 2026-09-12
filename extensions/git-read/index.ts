/**
 * git-read — read-only git inspection tools for pi.
 *
 * Registers git_show, git_diff, and git_log: the minimal surface a review or
 * exploration agent needs from git history without any write path. All three
 * share the file-search output discipline (bounded preview, complete output
 * persisted up to 10 MiB) and every user-controlled argument is validated
 * before it reaches a child process, so a revision or path can never inject
 * flags or escape the repository. The tools are child-safe by design and are
 * classified in CHILD_SAFE_PACKAGE_TOOL_NAMES so review/advisor subagents can
 * read diffs their tool boundary otherwise excludes (issue #61).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type {
  AgentToolResult,
  ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Cause, Effect, Exit } from "effect";
import { Type } from "typebox";
import { formatCapturedOutput } from "../file-search/src/output.ts";
import { sanitizeTerminalText } from "../shared/terminal-text.ts";
import {
  OPENPI_TOOL_SURFACE,
  patchOwnedTools,
} from "../shared/tool-surface.ts";
import {
  buildDiffArgs,
  buildLogArgs,
  buildShowArgs,
  type GitDiffParams,
  type GitLogParams,
  type GitShowParams,
  InvalidPathError,
  InvalidRevisionError,
} from "./src/args.ts";
import { type GitOutcome, runGit } from "./src/process.ts";
import {
  GIT_DIFF_PARAMETER_DESCRIPTIONS,
  GIT_DIFF_PROMPT_GUIDELINES,
  GIT_DIFF_PROMPT_SNIPPET,
  GIT_DIFF_TOOL_DESCRIPTION,
  GIT_LOG_PARAMETER_DESCRIPTIONS,
  GIT_LOG_PROMPT_GUIDELINES,
  GIT_LOG_PROMPT_SNIPPET,
  GIT_LOG_TOOL_DESCRIPTION,
  GIT_SHOW_PARAMETER_DESCRIPTIONS,
  GIT_SHOW_PROMPT_GUIDELINES,
  GIT_SHOW_PROMPT_SNIPPET,
  GIT_SHOW_TOOL_DESCRIPTION,
} from "./src/prompt.ts";

interface GitToolDetails {
  readonly command: string;
  readonly truncated: boolean;
  readonly lineCount?: number;
  readonly fullOutputPath?: string;
}

function causeMessage(cause: unknown): string {
  if (
    cause instanceof InvalidRevisionError ||
    cause instanceof InvalidPathError
  ) {
    return cause.message;
  }
  if (cause instanceof Error) return cause.message;
  return String(cause);
}

function unwrapToolExit<A, E>(exit: Exit.Exit<A, E>, tool: string) {
  if (Exit.isSuccess(exit)) return exit.value;
  if (Cause.hasInterruptsOnly(exit.cause)) {
    throw new Error(`${tool} was cancelled.`);
  }
  throw new Error(causeMessage(Cause.squash(exit.cause)));
}

function gitResult(
  outcome: GitOutcome,
  command: string,
): AgentToolResult<GitToolDetails> {
  const formatted = formatCapturedOutput(outcome.output);
  return {
    content: [
      {
        type: "text",
        text: sanitizeTerminalText(formatted.text) || "(no output)",
      },
    ],
    details: {
      command,
      truncated: formatted.truncated,
      lineCount: formatted.lineCount,
      fullOutputPath: formatted.fullOutputPath,
    },
  };
}

function showParameters() {
  return Type.Object({
    revision: Type.String({
      description: GIT_SHOW_PARAMETER_DESCRIPTIONS.revision,
    }),
    path: Type.Optional(
      Type.String({ description: GIT_SHOW_PARAMETER_DESCRIPTIONS.path }),
    ),
  });
}

function diffParameters() {
  return Type.Object({
    from: Type.Optional(
      Type.String({ description: GIT_DIFF_PARAMETER_DESCRIPTIONS.from }),
    ),
    to: Type.Optional(
      Type.String({ description: GIT_DIFF_PARAMETER_DESCRIPTIONS.to }),
    ),
    staged: Type.Optional(
      Type.Boolean({ description: GIT_DIFF_PARAMETER_DESCRIPTIONS.staged }),
    ),
    stat: Type.Optional(
      Type.Boolean({ description: GIT_DIFF_PARAMETER_DESCRIPTIONS.stat }),
    ),
    path: Type.Optional(
      Type.String({ description: GIT_DIFF_PARAMETER_DESCRIPTIONS.path }),
    ),
  });
}

function logParameters() {
  return Type.Object({
    revision: Type.Optional(
      Type.String({ description: GIT_LOG_PARAMETER_DESCRIPTIONS.revision }),
    ),
    file: Type.Optional(
      Type.String({ description: GIT_LOG_PARAMETER_DESCRIPTIONS.file }),
    ),
    limit: Type.Optional(
      Type.Integer({
        description: GIT_LOG_PARAMETER_DESCRIPTIONS.limit,
        minimum: 1,
        maximum: 1000,
      }),
    ),
    oneline: Type.Optional(
      Type.Boolean({ description: GIT_LOG_PARAMETER_DESCRIPTIONS.oneline }),
    ),
  });
}

function displayRevision(value: string | undefined, fallback = "HEAD") {
  return value === undefined || value.trim() === "" ? fallback : value.trim();
}

export default function gitReadTools(pi: ExtensionAPI) {
  const resultDirectories = new Set<string>();
  const rememberOutput = (outcome: GitOutcome) => {
    if (outcome.output.fullOutputPath) {
      resultDirectories.add(path.dirname(outcome.output.fullOutputPath));
    }
  };

  pi.on("session_start", () => {
    patchOwnedTools(pi, "gitRead", {
      enable: OPENPI_TOOL_SURFACE.gitRead.entry,
    });
  });

  pi.on("session_shutdown", () => {
    for (const directory of resultDirectories) {
      try {
        fs.rmSync(directory, { recursive: true, force: true });
      } catch {
        // Temporary git artifacts are best-effort cleanup.
      }
    }
    resultDirectories.clear();
  });

  pi.registerTool<ReturnType<typeof showParameters>, GitToolDetails>({
    name: "git_show",
    label: "Git Show",
    description: GIT_SHOW_TOOL_DESCRIPTION,
    promptSnippet: GIT_SHOW_PROMPT_SNIPPET,
    promptGuidelines: GIT_SHOW_PROMPT_GUIDELINES,
    parameters: showParameters(),

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const exit = await Effect.runPromiseExit(
        Effect.gen(function* () {
          const args = buildShowArgs(params as GitShowParams);
          const outcome = yield* runGit(args, ctx.cwd);
          rememberOutput(outcome);
          return gitResult(outcome, args.join(" "));
        }),
        signal ? { signal } : undefined,
      );
      return unwrapToolExit(exit, "git_show");
    },

    renderCall(args) {
      return new Text(`git show ${displayRevision(args.revision)}`, 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      const details = result.details;
      let text = details?.command
        ? `showed ${details.lineCount ?? 0} lines`
        : "shown";
      if (details?.truncated) text += " (truncated)";
      if (expanded)
        text += expandedResultPreview(result, details?.fullOutputPath, theme);
      return new Text(text, 0, 0);
    },
  });

  pi.registerTool<ReturnType<typeof diffParameters>, GitToolDetails>({
    name: "git_diff",
    label: "Git Diff",
    description: GIT_DIFF_TOOL_DESCRIPTION,
    promptSnippet: GIT_DIFF_PROMPT_SNIPPET,
    promptGuidelines: GIT_DIFF_PROMPT_GUIDELINES,
    parameters: diffParameters(),

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const exit = await Effect.runPromiseExit(
        Effect.gen(function* () {
          const args = buildDiffArgs(params as GitDiffParams);
          const outcome = yield* runGit(args, ctx.cwd);
          rememberOutput(outcome);
          return gitResult(outcome, args.join(" "));
        }),
        signal ? { signal } : undefined,
      );
      return unwrapToolExit(exit, "git_diff");
    },

    renderCall(args) {
      const from = displayRevision(
        args.from,
        args.staged ? "HEAD (staged)" : "index",
      );
      const to = args.to ? displayRevision(args.to) : "worktree";
      let text = `git diff ${from} → ${to}`;
      if (args.stat) text += " (stat)";
      if (args.path) text += ` ${args.path}`;
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      const details = result.details;
      let text = details?.command
        ? `${details.lineCount ?? 0} diff lines`
        : "diffed";
      if (details?.truncated) text += " (truncated)";
      if (expanded)
        text += expandedResultPreview(result, details?.fullOutputPath, theme);
      return new Text(text, 0, 0);
    },
  });

  pi.registerTool<ReturnType<typeof logParameters>, GitToolDetails>({
    name: "git_log",
    label: "Git Log",
    description: GIT_LOG_TOOL_DESCRIPTION,
    promptSnippet: GIT_LOG_PROMPT_SNIPPET,
    promptGuidelines: GIT_LOG_PROMPT_GUIDELINES,
    parameters: logParameters(),

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const exit = await Effect.runPromiseExit(
        Effect.gen(function* () {
          const args = buildLogArgs(params as GitLogParams);
          const outcome = yield* runGit(args, ctx.cwd);
          rememberOutput(outcome);
          return gitResult(outcome, args.join(" "));
        }),
        signal ? { signal } : undefined,
      );
      return unwrapToolExit(exit, "git_log");
    },

    renderCall(args) {
      let text = `git log ${displayRevision(args.revision)}`;
      if (args.file) text += ` -- ${args.file}`;
      if (args.limit !== undefined) text += ` -n ${args.limit}`;
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      const details = result.details;
      let text = details?.command
        ? `${details.lineCount ?? 0} output lines`
        : "logged";
      if (details?.truncated) text += " (truncated)";
      if (expanded)
        text += expandedResultPreview(result, details?.fullOutputPath, theme);
      return new Text(text, 0, 0);
    },
  });
}

const EXPANDED_PREVIEW_LINES = 20;

export function expandedResultPreview(
  result: { content: { type: string; text?: string }[] },
  fullOutputPath: string | undefined,
  theme: { fg(color: string, text: string): string },
) {
  let text = "";
  const content = result.content[0];
  if (content?.type === "text" && content.text) {
    const lines = sanitizeTerminalText(content.text).split("\n");
    for (const line of lines.slice(0, EXPANDED_PREVIEW_LINES)) {
      text += `\n${theme.fg("dim", line)}`;
    }
    if (lines.length > EXPANDED_PREVIEW_LINES) {
      text += `\n${theme.fg("muted", `... ${lines.length - EXPANDED_PREVIEW_LINES} more lines`)}`;
    }
  }
  if (fullOutputPath) {
    text += `\n${theme.fg("dim", `Full output: ${sanitizeTerminalText(fullOutputPath)}`)}`;
  }
  return text;
}
