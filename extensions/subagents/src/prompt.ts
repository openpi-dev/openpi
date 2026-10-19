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
  "Start a background Pi subagent with its own context. Returns an id immediately; the result is delivered to you automatically when it finishes. The child cannot see this conversation or ask the user. " +
  `Max ${MAX_RUNNING} running at once.`;

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
    "Role preset (prompt plus enforced tool limits). Omit for a general child. Roles: ";
  const outro = "";
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
  "Delegate a self-contained task to a background subagent";

/** Guides the parent model to delegate standalone tasks and avoid unnecessary blocking waits. */
export const SUBAGENT_SPAWN_PROMPT_GUIDELINES = [
  "Delegate only substantial, independent work. After spawning, keep working or end your turn: results arrive automatically, so never poll or wait just because a later step depends on them.",
];

/** Model-facing schema descriptions for subagent_spawn task and execution options. */
export const SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS = {
  prompt:
    "Complete standalone task: context, file paths, constraints, and the expected report.",
  name: "Short label for listings.",
  harness: 'Only "pi" (the default).',
  workingDir: "Child working directory, absolute or relative to this one.",
  isolation:
    '"worktree" gives the child its own git worktree; use it for concurrent writers and tell the child to commit.',
  model:
    '"provider/model-id" override. Omit to inherit. Never guess a model name.',
  reasoningEffort:
    "Child thinking level. Omit to use the role default or the parent level; honor any level the user requested.",
  outputSchema: "JSON Schema the child's final result must match.",
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
      output_schema: Type.Optional(
        Type.Object(
          {},
          {
            additionalProperties: true,
            description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.outputSchema,
          },
        ),
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
  structured?: boolean;
  exitsAfterTurn?: boolean;
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
  const structuredNote = options.structured
    ? " This run must finish with the requested validated structured result."
    : "";
  const continuation = options.exitsAfterTurn
    ? `It runs in the background. This is a non-interactive run: the process exits when your turn ends, which stops any running subagent and discards its result. Before your final answer, call subagent_wait(ids: ["${options.id}"]) for every result you need; subagent_cancel stops it, subagent_check peeks at a running one or lists all.`
    : `It runs in the background — keep working on independent work. If none remains in an interactive session, briefly tell the user it is still running and end your turn; its result is delivered automatically and you are automatically re-invoked when it finishes. Do not poll or call subagent_wait merely because a later step depends on it. ` +
      `Use subagent_wait(ids: ["${options.id}"]) only if the user explicitly asked you to keep the current response open for this result, or a non-interactive automation must return it in the same invocation; subagent_cancel stops it, subagent_check peeks at a running one or lists all.`;
  return (
    `Spawned subagent ${options.id} "${options.title}" (${options.harness}: ${options.modelLabel}, ${options.cwd}).${typeNote}${toolNote}${worktreeNote}${structuredNote}\n` +
    continuation
  );
}

/** Describes explicit blocking collection of one or more subagent results. */
export const SUBAGENT_WAIT_TOOL_DESCRIPTION =
  "Block until the listed subagents finish and return their results. Use only when the user explicitly asks to keep this response open for them, or a non-interactive run must return them now; otherwise end your turn and the results arrive automatically.";

/** Model-facing schema description for the subagent ids to await. */
export const SUBAGENT_WAIT_PARAMETER_DESCRIPTIONS = {
  ids: 'Subagent ids, e.g. ["sa-1"].',
};

/** Describes aborting running subagents while retaining their partial transcripts. */
export const SUBAGENT_CANCEL_TOOL_DESCRIPTION =
  "Stop running subagents. Their partial transcripts are kept.";

/** Model-facing schema description for the subagent ids to cancel. */
export const SUBAGENT_CANCEL_PARAMETER_DESCRIPTIONS = {
  ids: 'Subagent ids, e.g. ["sa-1"].',
};

/** Describes sending a follow-up to one subagent: steer a running one or restart a settled one. */
export const SUBAGENT_SEND_TOOL_DESCRIPTION =
  "Send a message to an existing subagent: steers it if it is running, or starts another turn on its transcript if it has finished. Prefer this over respawning for follow-ups on the same task. The result is delivered automatically.";

/** Model-facing schema descriptions for the subagent id and follow-up message. */
export const SUBAGENT_SEND_PARAMETER_DESCRIPTIONS = {
  id: 'Subagent id, e.g. "sa-1".',
  text: "Self-contained message; the child cannot see this conversation.",
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
  "Show one subagent's status and latest output without blocking, or omit id to list all subagents. Not for waiting: results arrive automatically. Set evidence to page through a finished subagent's transcript, final output, or structured result.";

/** Model-facing schema description for the subagent id to inspect. */
export const SUBAGENT_CHECK_PARAMETER_DESCRIPTIONS = {
  id: "Subagent id; omit to list all.",
};

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
