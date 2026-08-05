/** All model-facing strings for the subagents tools. */

import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { effectiveChildToolAllowlist } from "../../shared/child-session.ts";
import type { AgentType } from "./agent-types.ts";
import { MAX_RUNNING } from "./manager.ts";

/** Describes subagent_spawn, including the fixed concurrency cap. */
export const SUBAGENT_SPAWN_TOOL_DESCRIPTION =
  "Spawn a background subagent: a fully autonomous, headless pi session with its own context window, this environment's tools and config, and normal host permissions. Fire-and-forget: this returns immediately with an id. The subagent's final output is queued back to you as a message when it settles, or collect it explicitly with subagent_wait. Children cannot orchestrate more agents/workflows or ask the user, and cannot see this conversation, so the prompt must be self-contained. Only use trusted working directories. " +
  `Max ${MAX_RUNNING} subagents can be running at once.`;

/**
 * Appends the configured agent types, if any. They are a runtime resource, so
 * the roster has to be baked into the description at registration time.
 */
export function buildSubagentSpawnToolDescription(
  agentTypes: readonly AgentType[],
) {
  if (agentTypes.length === 0) return SUBAGENT_SPAWN_TOOL_DESCRIPTION;
  return `${SUBAGENT_SPAWN_TOOL_DESCRIPTION} This environment also defines agent types (see agent_type): named presets that fix a child's system prompt, and often restrict it to a subset of tools. Prefer one when it matches the task — a type's tool restriction is enforced, not advisory.`;
}

/** Lists each agent type's enforced capabilities and reasoning default. */
export function buildAgentTypeParameterDescription(
  agentTypes: readonly AgentType[],
) {
  const entries = agentTypes.map((agentType) => {
    const tools = agentType.tools
      ? (() => {
          const effectiveTools = effectiveChildToolAllowlist(agentType.tools);
          return effectiveTools?.length
            ? ` [only: ${effectiveTools.join(", ")}]`
            : " [only: no child-safe tools]";
        })()
      : "";
    const effort = agentType.reasoningEffort
      ? ` [default reasoning_effort: ${agentType.reasoningEffort}]`
      : " [reasoning_effort: inherits parent]";
    return `"${agentType.name}" — ${agentType.description}${tools}${effort}`;
  });
  return `Optional agent type: a preset that gives the child a specialized system prompt and, when listed, restricts it to exactly those child-safe tools. Omit for a general-purpose subagent with the normal tool set. Available: ${entries.join("; ")}. Model precedence: explicit spawn model > selected type file model > configured built-in role model > parent model. Reasoning precedence: explicit spawn reasoning_effort > selected type default > parent reasoning effort.`;
}

/** Generated schema for the dynamic agent-type roster. */
export function createAgentTypeParameterSchema(
  agentTypes: readonly AgentType[],
) {
  return Type.Optional(
    StringEnum(
      agentTypes.map((agentType) => agentType.name) as [string, ...string[]],
      { description: buildAgentTypeParameterDescription(agentTypes) },
    ),
  );
}

/** Adds background subagent delegation to the parent model's available-tools prompt. */
export const SUBAGENT_SPAWN_PROMPT_SNIPPET =
  "Spawn a background subagent (own context, normal tools) for a self-contained task";

/** Guides the parent model to delegate standalone tasks and avoid unnecessary blocking waits. */
export const SUBAGENT_SPAWN_PROMPT_GUIDELINES = [
  "Reserve subagent_spawn for substantial, self-contained work; give it a complete, standalone prompt. For a single lookup or edit you can do inline, just do it — each subagent spends a fresh context window and cannot see this conversation.",
  "After subagent_spawn, keep working on other things; results arrive automatically and you are re-invoked when a subagent settles. Do not poll with subagent_check and do not subagent_wait just to sit idle — wait only when your next step genuinely cannot proceed without the result, and never answer from a guessed result before it arrives.",
];

/** Model-facing schema descriptions for subagent_spawn task and execution options. */
export const SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS = {
  prompt:
    "Task prompt for the subagent. Must be self-contained: include all needed context, file paths, and what to report back.",
  name: "Short human-readable name for this subagent, shown in listings and the UI",
  harness:
    'Optional. The only harness is "pi" (an in-process Pi session that inherits this environment), which is the default; you can omit this.',
  workingDir:
    "Trusted working directory for the autonomous child (default: current working directory)",
  isolation:
    'Set to "worktree" to run this child in its own git worktree on its own branch, branched from HEAD. Use it whenever children may edit the same files or stage changes concurrently — without it, parallel children share one checkout and one git index, so their edits and `git add`s overwrite each other. The child should COMMIT its work; on teardown the worktree directory is reclaimed and the branch is kept for you to inspect or merge (an empty branch is deleted, and uncommitted changes keep the directory instead). Requires a git repository, and the checkout starts clean, so anything gitignored (build output, .env) will not be there.',
  model:
    'Optional model override, as "provider/model-id" or a bare id resolved against the current provider. Precedence: explicit spawn model > selected type file model > configured built-in role model > parent model. Never guess a model name.',
  reasoningEffort:
    "Optional thinking level for the child. Precedence: explicit spawn reasoning_effort > selected type default > parent reasoning effort.",
};

/** Builds the subagent_spawn result that tells the parent model how to continue or inspect the child. */
export function buildSubagentSpawnResult(options: {
  id: string;
  title: string;
  harness: string;
  modelLabel: string;
  cwd: string;
  agentTypeName?: string;
  tools?: readonly string[];
  worktreeBranch?: string;
}) {
  const typeNote = options.agentTypeName
    ? ` Agent type "${options.agentTypeName}" applied.`
    : "";
  // Report the effective allowlist independently of agent type: plan mode can
  // narrow a general child too, and the parent must not expect work the child
  // structurally cannot do. Defend this presentation boundary as well as the
  // child-session boundary, so a future caller cannot advertise parent tools.
  const effectiveTools = effectiveChildToolAllowlist(options.tools);
  const toolNote = effectiveTools
    ? effectiveTools.length > 0
      ? ` It can only use: ${effectiveTools.join(", ")}.`
      : " It has no tools available."
    : "";
  // Without the branch name the parent has no way to find committed work after
  // the isolated directory is reclaimed.
  const worktreeNote = options.worktreeBranch
    ? ` Isolated in its own worktree on branch "${options.worktreeBranch}" — its edits are invisible here until you merge that branch, and the directory is reclaimed when it finishes.`
    : "";
  return (
    `Spawned subagent ${options.id} "${options.title}" (${options.harness}: ${options.modelLabel}, ${options.cwd}).${typeNote}${toolNote}${worktreeNote}\n` +
    `It runs in the background — keep working on other things; its result is delivered to you automatically when it finishes, so do not poll or wait for it. ` +
    `Only if your next step truly cannot proceed without it, subagent_wait(ids: ["${options.id}"]) blocks for it; subagent_cancel stops it, subagent_check peeks at a running one, subagent_list shows all.`
  );
}

/** Describes explicit blocking collection of one or more subagent results. */
export const SUBAGENT_WAIT_TOOL_DESCRIPTION =
  "Block until all listed subagents have settled, then return their final outputs. This is the EXCEPTION, not the default: after spawning, keep doing other useful work — each subagent's result is delivered to you automatically when it settles, and you'll be re-invoked then. Call subagent_wait only when your very next step cannot proceed without the result (e.g. you must synthesize several children's outputs and have nothing else to do first). Never poll for completion and never answer from a guessed result before it arrives.";

/** Model-facing schema description for the subagent ids to await. */
export const SUBAGENT_WAIT_PARAMETER_DESCRIPTIONS = {
  ids: 'Subagent ids to wait for, e.g. ["sa-1", "sa-2"]',
};

/** Describes aborting running subagents while retaining their partial transcripts. */
export const SUBAGENT_CANCEL_TOOL_DESCRIPTION =
  "Cancel one or more running subagents. This aborts their active work but preserves their partial session transcripts on disk.";

/** Model-facing schema description for the subagent ids to cancel. */
export const SUBAGENT_CANCEL_PARAMETER_DESCRIPTIONS = {
  ids: 'Subagent ids to cancel, e.g. ["sa-1", "sa-2"]',
};

/** Describes sending a follow-up to one subagent: steer a running one or restart a settled one. */
export const SUBAGENT_SEND_TOOL_DESCRIPTION =
  "Send a message to one subagent: steer a running one mid-run, or restart a finished/failed one for another turn with its transcript and context intact. Use this to correct course, add missing context, or ask a follow-up on the SAME subagent instead of cancelling and respawning it. Spawn a fresh subagent for unrelated work. Restarting a settled subagent re-occupies a running slot, so it fails when the concurrency cap is full — wait for one to finish first. The subagent still cannot see this conversation, so make the message self-contained. Its result is delivered back to you when it next settles, exactly like subagent_spawn.";

/** Model-facing schema descriptions for the subagent id and follow-up message. */
export const SUBAGENT_SEND_PARAMETER_DESCRIPTIONS = {
  id: 'Subagent id to send to, e.g. "sa-1"',
  text: "Message for the subagent: steering guidance for a running one, or the next instruction for a finished one. Must be self-contained — it cannot see this conversation.",
};

/** Builds the subagent_send result, distinguishing a live steer from a restart. */
export function buildSubagentSendResult(options: {
  id: string;
  title: string;
  wasRunning: boolean;
}) {
  return options.wasRunning
    ? `Steered ${options.id} "${options.title}". It is queued into the active run; the result is delivered when it settles.`
    : `Restarted ${options.id} "${options.title}" for another turn on its existing transcript. The result is delivered when it settles, or use subagent_wait(ids: ["${options.id}"]) to block for it.`;
}

/** Describes nonblocking inspection of a subagent without consuming its result. */
export const SUBAGENT_CHECK_TOOL_DESCRIPTION =
  "Peek at a subagent's status and recent activity without blocking. Does not consume its result. Do NOT poll with it to wait for completion — a settled subagent's result is delivered to you automatically. Use it only when you need a running subagent's current partial state right now (e.g. to decide whether to steer it).";

/** Model-facing schema description for the subagent id to inspect. */
export const SUBAGENT_CHECK_PARAMETER_DESCRIPTIONS = {
  id: "Subagent id",
};

/** Describes listing all tracked running and settled subagents. */
export const SUBAGENT_LIST_TOOL_DESCRIPTION =
  "List all subagents (running and finished) with their status.";

/** Builds the child completion/failure wrapper injected into the parent model's context. */
export function buildSubagentResultMessage(options: {
  id: string;
  title: string;
  status: "running" | "done" | "error";
  errorText?: string;
  output: string;
}) {
  const verb = options.status === "error" ? "failed" : "finished";
  let text = `Subagent ${options.id} "${options.title}" ${verb}.`;
  if (options.errorText) text += `\nError: ${options.errorText}`;
  text += `\n\n${options.output}`;
  // This message is already displayed to the user, so tell the parent to act on
  // it rather than reprint it verbatim.
  text +=
    "\n\n(This result is already shown to the user. Act on it and relay only the decisions or next steps — do not repeat it verbatim.)";
  return text;
}
