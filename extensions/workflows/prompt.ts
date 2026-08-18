import { sanitizeTerminalText } from "../shared/terminal-text.ts";
import {
  countStates,
  formatElapsed,
  resultJson,
  shortenHome,
  type WorkflowDetails,
} from "./model.ts";

/** Model-facing schema descriptions for workflow source, arguments, and background mode. */
export const WORKFLOW_PARAMETER_DESCRIPTIONS = {
  script:
    "JavaScript workflow script. May start with `export const meta = {...}`, then use phase(), agent(), parallel(), args, and a final `return`.",
  args: "Optional JSON string exposed to the script as `args` (parsed when valid JSON, otherwise passed through as the raw string).",
  background:
    "Run in the background: the tool returns a run id immediately and you receive a follow-up message when the workflow finishes. Defaults to false (blocking with live progress).",
  resumeFromRunId:
    "Optional prior run id or unique suffix for safe read-only replay. See the workflows Skill for matching rules.",
};

/** Describes stopping a running background workflow, mirroring subagent_cancel/bg_kill. */
export const WORKFLOW_STOP_TOOL_DESCRIPTION =
  "Cancel a running background workflow by its run id (from the workflow launch result). This aborts its remaining agents and settles the run; partial results and artifacts are preserved. Only background runs need this — a blocking workflow is already cancelled by interrupting the turn.";

/** Model-facing schema description for the workflow run id to stop. */
export const WORKFLOW_STOP_PARAMETER_DESCRIPTIONS = {
  runId: 'Workflow run id to cancel, e.g. "wf_1a2b3c4d5e6f".',
};

/** Describes nonblocking inspection of workflow runs, mirroring subagent_check/subagent_list. */
export const WORKFLOW_STATUS_TOOL_DESCRIPTION =
  "Peek at background workflow runs without blocking. With a run id, returns that run's phases, per-agent status, and result if finished; without one, lists this session's active and recently finished runs. Does not wait — use background:false when you need the result inline.";

/** Model-facing schema description for the optional workflow run id to inspect. */
export const WORKFLOW_STATUS_PARAMETER_DESCRIPTIONS = {
  runId:
    "Optional workflow run id to inspect. Omit to list active and recently finished runs.",
};

/** Adds workflow lifecycle inspection/cancellation to the parent model's tools prompt. */
export const WORKFLOW_LIFECYCLE_PROMPT_SNIPPET =
  "Inspect (workflow_status) or cancel (workflow_stop) a background workflow by run id";

/** Compact resident contract; the workflows Skill carries the complete guide. */
export const WORKFLOW_TOOL_DESCRIPTION = [
  "Use the workflow tool when the user explicitly requests a workflow run or when the task clearly requires multi-phase dynamic orchestration.",
  "Write an async JavaScript body using optional meta, phase(), log(), usage(), agent(), pipeline(), parallel(), args, and a JSON-serializable return.",
  "agent() returns { ok, output, structured?, ref?, error? }; always check `.ok`, use a schema for branching, and surface failed or null results.",
  "Prefer pipeline() for independent multi-stage items. Use parallel() only for a real barrier where the next step needs every prior result.",
  "For concurrent writers use isolation: 'worktree' and tell each agent to commit. Read-only work should normally stay in the shared checkout.",
  "Read the workflows Skill before a nontrivial script; it covers the restricted sandbox, full DSL, acceptance, result refs, replay, background lifecycle, limits, and examples.",
].join("\n");

/** Adds workflow orchestration primitives and background execution to the model's tool prompt. */
export const WORKFLOW_PROMPT_SNIPPET =
  "Orchestrate subagents from an inline JS script; read the workflows Skill for the complete DSL";

/** Guides the model on appropriate workflow fan-out and mandatory agent result checks. */
export const WORKFLOW_PROMPT_GUIDELINES = [
  "Use workflow when a task needs several subagents with phase dependencies or dynamic fan-out; keep single small delegations in the main session.",
  "select a matching agent_type when available; use its configured model and do not hardcode that role's model.",
  "Read the workflows Skill before a nontrivial script; check every agent result, surface dropped work, and use worktree isolation for concurrent writers.",
];

/** Marks and forwards a workflow script's agent() task as an isolated child-model prompt. */
export function buildWorkflowAgentPrompt(prompt: string) {
  return prompt;
}

/** Instructs structured workflow children to terminate with exactly one structured_output call. */
export const STRUCTURED_OUTPUT_SYSTEM_INSTRUCTION =
  "When your task is complete, call the `structured_output` tool exactly once as your final action, with fields matching the required schema. Do not write any other text after it.";

/** Describes the terminating structured_output tool and its final-action contract. */
export const STRUCTURED_OUTPUT_TOOL_DESCRIPTION =
  "Return your final result as structured data matching the required schema. Call this exactly once, as your last action; do not write any other text after it.";

/** Builds the workflow completion report returned to the parent model. */
export function buildWorkflowResultMessage(
  details: WorkflowDetails,
  runDir: string,
) {
  const { done, failed } = countStates(details);
  const elapsed = formatElapsed(details.startedAt, details.finishedAt);
  const lines = [
    `Workflow ${details.name ? `"${details.name}"` : details.runId} ${details.status} — ` +
      `${done}/${details.agents.length} agents ok${failed ? `, ${failed} failed` : ""} ` +
      `across ${details.phases.length} phase(s) in ${elapsed}.`,
    `Run dir: ${shortenHome(runDir)}`,
  ];
  // State the hit rate out loud: it is the only way to tell a resume that
  // worked from one that silently replayed nothing.
  const replayed = details.agents.filter((agent) => agent.replayed).length;
  if (details.resumedFrom) {
    lines.push(
      `Resumed from ${details.resumedFrom}: replayed ${replayed}/${details.agents.length} agent call(s), ran ${details.agents.length - replayed} for real.`,
    );
  }
  if (details.resumeNote) lines.push(`Resume: ${details.resumeNote}`);
  if (details.error) lines.push(`Error: ${details.error}`);
  // The script's own narration of what happened, which is often the only
  // record of work that did not make it into the return value.
  if (details.logs && details.logs.length > 0) {
    lines.push("", "Log:");
    if (details.logsDropped) {
      lines.push(`  (${details.logsDropped} earlier line(s) dropped)`);
    }
    for (const entry of details.logs) lines.push(`  ${entry.text}`);
  }
  // Isolated work lives on a branch or in a kept directory, not in the working
  // tree, so an unreported one is work the parent cannot find.
  const isolated = details.agents.filter(
    (agent) => agent.worktreeBranch || agent.worktreePath,
  );
  if (isolated.length > 0) {
    lines.push("", "Isolated worktrees:");
    for (const agent of isolated) {
      const cleanup = agent.worktreeCleanup;
      const work = cleanup?.commits
        ? `${cleanup.commits} commit${cleanup.commits === 1 ? "" : "s"} on ${cleanup.branch}`
        : agent.worktreeBranch
          ? `committed to branch ${agent.worktreeBranch}`
          : "no commits";
      lines.push(
        `- [${agent.label}] ${work}${
          agent.worktreePath
            ? `; kept at ${shortenHome(agent.worktreePath)} (${cleanup?.reason ?? "uncommitted changes"})`
            : cleanup?.branchDeleted
              ? "; empty branch deleted"
              : cleanup?.reason
                ? `; cleanup warning: ${cleanup.reason}`
                : ""
        }${agent.worktreeHandoffArtifact ? `; handoff ${agent.worktreeHandoffArtifact}` : ""}`,
      );
    }
  }
  if (details.agents.length > 0) {
    lines.push("", "Agents:");
    for (const agent of details.agents) {
      const status =
        agent.state === "done"
          ? agent.replayed
            ? "ok (replayed)"
            : "ok"
          : agent.state === "error"
            ? "FAILED"
            : "running";
      lines.push(
        `- [${agent.label}]${agent.phase ? ` (${agent.phase})` : ""} ${status}` +
          (agent.acceptance ? ` · acceptance ${agent.acceptance.status}` : "") +
          (agent.error ? ` — ${agent.error}` : ""),
      );
    }
  }
  if (details.result !== undefined)
    lines.push("", "Result:", resultJson(details.result));
  return sanitizeTerminalText(lines.join("\n"));
}

/** Builds the follow-up message that delivers a settled background workflow to the parent model. */
export function buildBackgroundWorkflowFollowUp(options: {
  runId: string;
  name?: string;
  status: WorkflowDetails["status"];
  result: string;
}) {
  // Sentence lead-in matching the subagent/terminal completion messages.
  const label = options.name ? `"${options.name}"` : options.runId;
  const verb = options.status === "completed" ? "finished" : options.status;
  return `Background workflow ${label} (${options.runId}) ${verb}.\n\n${options.result}`;
}

/** Builds the background-launch result and tells the parent model how to inspect or stop the run. */
export function buildBackgroundWorkflowLaunchResult(options: {
  runId: string;
  name?: string;
  runDir: string;
}) {
  return [
    `Workflow ${options.name ? `"${options.name}"` : options.runId} launched in background (run ${options.runId}).`,
    `Artifacts: ${shortenHome(options.runDir)}`,
    `Its result will be delivered to you when it finishes, or use workflow_status(runId: "${options.runId}") to peek and workflow_stop(runId: "${options.runId}") to cancel; /workflows shows progress.`,
  ].join("\n");
}
