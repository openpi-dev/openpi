/** All model-facing strings for the subagents tools. */

import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { effectiveChildToolAllowlist } from "../../shared/child-session.ts";
import { SUBAGENT_ROLE_NAMES } from "../../shared/subagent-roles.ts";
import { type AgentType, READ_ONLY_AGENT_TOOLS } from "./agent-types.ts";
import { BACKEND_NAMES, REASONING_EFFORTS } from "./domain.ts";
import { MAX_RUNNING } from "./manager.ts";

export const SUBAGENT_SCHEMA_BUDGETS = Object.freeze({
  rolePurposeBytes: 240,
  roleDirectoryBytes: 4 * 1024,
  defaultSpawnSurfaceBytes: 2.5 * 1024,
  maximumSpawnSurfaceBytes: 16 * 1024,
});

/** Describes subagent_spawn, including the fixed concurrency cap. */
export const SUBAGENT_SPAWN_TOOL_DESCRIPTION =
  "Spawn a background in-process Pi subagent with its own context, child-safe tools, and normal host permissions. Returns immediately; its final result is delivered automatically. The child cannot see this conversation, ask the user, or orchestrate agents/workflows. Use only trusted working directories. " +
  `Max ${MAX_RUNNING} subagents can be running at once.`;

/** UTF-8 bounded, whitespace-normalized text for the parent-facing roster. */
function boundedPurpose(description: string) {
  const normalized = description.trim().replace(/\s+/gu, " ");
  const limit = SUBAGENT_SCHEMA_BUDGETS.rolePurposeBytes;
  if (Buffer.byteLength(normalized, "utf8") <= limit) return normalized;
  const suffix = "…";
  let used = Buffer.byteLength(suffix, "utf8");
  let output = "";
  for (const character of normalized) {
    const bytes = Buffer.byteLength(character, "utf8");
    if (used + bytes > limit) break;
    output += character;
    used += bytes;
  }
  return output.trimEnd() + suffix;
}

function compareNames(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Built-ins stay familiar; project/global additions are stable by name. */
function orderedAgentTypes(agentTypes: readonly AgentType[]) {
  const builtInOrder = new Map<string, number>(
    SUBAGENT_ROLE_NAMES.map((name, index) => [name, index]),
  );
  return [...agentTypes].sort((left, right) => {
    const leftIndex = builtInOrder.get(left.name);
    const rightIndex = builtInOrder.get(right.name);
    if (leftIndex !== undefined || rightIndex !== undefined) {
      if (leftIndex === undefined) return 1;
      if (rightIndex === undefined) return -1;
      return leftIndex - rightIndex;
    }
    return compareNames(left.name, right.name);
  });
}

function capabilityClass(agentType: AgentType) {
  if (agentType.tools === undefined) return "inherited-tools";
  const tools = effectiveChildToolAllowlist(agentType.tools) ?? [];
  if (tools.length === 0) return "no-tools";
  if (tools.every((tool) => READ_ONLY_AGENT_TOOLS.includes(tool))) {
    return "read-only";
  }
  if (
    tools.some((tool) => tool === "bash" || tool === "edit" || tool === "write")
  ) {
    return "workspace-write";
  }
  // Third-party child-safe tools may still have side effects, so only claim
  // the enforceable fact: this preset has a restricted tool set.
  return "restricted";
}

function agentTypeSummary(agentType: AgentType) {
  const effort = agentType.reasoningEffort
    ? ` [default reasoning_effort: ${agentType.reasoningEffort}]`
    : "";
  return `"${agentType.name}" — ${boundedPurpose(agentType.description)} [${capabilityClass(agentType)}]${effort}`;
}

/** A deterministic, bounded selection index; execution details stay in Skill. */
export function buildAgentTypeParameterDescription(
  agentTypes: readonly AgentType[],
) {
  const ordered = orderedAgentTypes(agentTypes);
  const intro =
    "Optional named preset for the child prompt and capability boundary. Omit for a general-purpose child. Available: ";
  const outro =
    " Preset restrictions are enforced; read the Subagents Skill or role file for full details.";
  const entries: string[] = [];
  for (const agentType of ordered) {
    const summary = agentTypeSummary(agentType);
    const next = [...entries, summary];
    const omitted = ordered.length - next.length;
    const omission = omitted
      ? `; ${omitted} presets omitted from this summary; their exact enum names remain valid.`
      : ".";
    const candidate = `${intro}${next.join("; ")}${omission}${outro}`;
    if (
      Buffer.byteLength(candidate, "utf8") >
      SUBAGENT_SCHEMA_BUDGETS.roleDirectoryBytes
    ) {
      break;
    }
    entries.push(summary);
  }
  const omitted = ordered.length - entries.length;
  const omission = omitted
    ? `; ${omitted} presets omitted from this summary; their exact enum names remain valid.`
    : ".";
  return `${intro}${entries.join("; ")}${omission}${outro}`;
}

/** Generated schema for the dynamic agent-type roster. */
export function createAgentTypeParameterSchema(
  agentTypes: readonly AgentType[],
) {
  const ordered = orderedAgentTypes(agentTypes);
  return Type.Optional(
    StringEnum(
      ordered.map((agentType) => agentType.name) as [string, ...string[]],
      { description: buildAgentTypeParameterDescription(ordered) },
    ),
  );
}

/** Adds background subagent delegation to the parent model's available-tools prompt. */
export const SUBAGENT_SPAWN_PROMPT_SNIPPET =
  "Spawn a background subagent (own context, normal tools) for a self-contained task";

/** Guides the parent model to delegate standalone tasks and avoid unnecessary blocking waits. */
export const SUBAGENT_SPAWN_PROMPT_GUIDELINES = [
  "Delegate substantial independent work; do a single lookup or edit inline.",
  "After spawning, continue independent work. In an interactive session, end your turn when none remains; automatic delivery will re-invoke you. Do not call subagent_wait merely because the next step depends on the result; use it only when the user explicitly asks to keep the response open, or the same non-interactive invocation must return the result. Never poll or guess the result.",
];

/** Model-facing schema descriptions for subagent_spawn task and execution options. */
export const SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS = {
  prompt:
    "Task prompt for the subagent. Must be self-contained: include all needed context, file paths, and what to report back.",
  name: "Short human-readable name shown in listings and the UI",
  harness: 'Optional; "pi" is the only harness and the default.',
  workingDir:
    "Trusted child working directory; defaults to the current directory",
  isolation:
    'Use "worktree" for concurrent writers and tell the child to commit. See the Subagents Skill for lifecycle details.',
  model:
    'Optional "provider/model-id" or current-provider model override. Omit to use the preset, configured role, or parent default. Never guess a model name.',
  reasoningEffort:
    "Optional child thinking level. Honor the user's requested level. Otherwise choose a level supported by the resolved child model based on the selected role and task difficulty. An explicit value overrides a role default.",
};

/** The exact name/description/wire-schema source used by registration/tests. */
export function createSubagentSpawnToolSurface(
  agentTypes: readonly AgentType[],
) {
  return {
    description: SUBAGENT_SPAWN_TOOL_DESCRIPTION,
    parameters: Type.Object({
      agent_type: createAgentTypeParameterSchema(agentTypes),
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
  };
}

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
  // Direct child sessions can be steered after settling, so their checkout is
  // retained until the session retires; fail-closed cleanup preserves work.
  const worktreeNote = options.worktreeBranch
    ? ` Isolated in its own worktree on branch "${options.worktreeBranch}" — its edits are invisible here until you merge that branch. The checkout stays available for later send/review and is reclaimed on Session retirement only when bounded inspection proves it empty.`
    : "";
  return (
    `Spawned subagent ${options.id} "${options.title}" (${options.harness}: ${options.modelLabel}, ${options.cwd}).${typeNote}${toolNote}${worktreeNote}\n` +
    `It runs in the background — keep working on independent work. If none remains in an interactive session, briefly tell the user it is still running and end your turn; its result is delivered automatically and you are automatically re-invoked when it finishes. Do not poll or call subagent_wait merely because a later step depends on it. ` +
    `Use subagent_wait(ids: ["${options.id}"]) only if the user explicitly asked you to keep the current response open for this result, or a non-interactive automation must return it in the same invocation; subagent_cancel stops it, subagent_check peeks at a running one, subagent_list shows all.`
  );
}

/** Describes explicit blocking collection of one or more subagent results. */
export const SUBAGENT_WAIT_TOOL_DESCRIPTION =
  "Block until all listed subagents have settled, then return their final outputs. This is an explicit synchronous barrier, not the default. In an interactive session, call it only when the user explicitly asks you to keep the current response open for these results. A dependent next step or having nothing else to do is not sufficient: end your turn and let automatic result delivery re-invoke you while the user remains free to interact. In a non-interactive automation, use it only when the same invocation must return the completed results. Never poll for completion and never answer from a guessed result before it arrives.";

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
    : `Restarted ${options.id} "${options.title}" for another turn on its existing transcript. The result is delivered automatically when it settles.`;
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

const SUBAGENT_RESULT_TRANSPORT_INSTRUCTION =
  "(This result is already shown to the user. Act on it and relay only the decisions or next steps — do not repeat it verbatim.)";

/** Builds the user-visible child completion/failure projection. */
export function buildSubagentResultDisplayMessage(options: {
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
  return text;
}

/** Builds the child completion/failure wrapper injected into the parent model's context. */
export function buildSubagentResultMessage(options: {
  id: string;
  title: string;
  status: "running" | "done" | "error";
  errorText?: string;
  output: string;
}) {
  let text = buildSubagentResultDisplayMessage(options);
  // This message is already displayed to the user, so tell the parent to act on
  // it rather than reprint it verbatim.
  text += `\n\n${SUBAGENT_RESULT_TRANSPORT_INSTRUCTION}`;
  return text;
}

/** Remove the transport-only suffix from results persisted before the split. */
export function stripSubagentResultTransportInstruction(content: string) {
  const separator = `\n\n${SUBAGENT_RESULT_TRANSPORT_INSTRUCTION}`;
  const withoutBatchedSeparators = content.replaceAll(
    `${separator}\n\nSubagent `,
    "\n\nSubagent ",
  );
  return (
    withoutBatchedSeparators.endsWith(separator)
      ? withoutBatchedSeparators.slice(0, -separator.length)
      : withoutBatchedSeparators
  ).trimEnd();
}
