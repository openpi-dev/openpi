import {
  allocateResultBudgets,
  type ParentContextUsage,
} from "../shared/result-budget.ts";
import { sanitizeTerminalText } from "../shared/terminal-text.ts";
import { projectText } from "../shared/text-projection.ts";
import {
  countStates,
  formatElapsed,
  resultJson,
  shortenHome,
  type WorkflowDetails,
} from "./model.ts";

/** Model-facing schema descriptions for workflow source and launch policy. */
export const WORKFLOW_PARAMETER_DESCRIPTIONS = {
  script:
    "JavaScript workflow script. May start with `export const meta = {...}`, then use phase(), agent(), parallel(), args, and a final `return`.",
  args: "Optional JSON string exposed to the script as `args` (parsed when valid JSON, otherwise passed through as the raw string).",
  background:
    "Deprecated compatibility alias: true means wait=false; false means wait=true. Do not provide both background and wait.",
  wait: "Wait for the final result in this tool call. Interactive sessions default to false and deliver completion later; print/automation defaults to true. Interrupting the wait does not cancel the workflow.",
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
  "Peek at workflow runs without blocking. With a run id, returns a bounded status and coverage summary plus the artifact location; without one, lists this session's active and recently finished runs. Does not wait, consume a completion, or repeat the full final result.";

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
  "Write an async JavaScript body using optional meta, phase(), log(), usage(), agent(), pipeline(), parallel(), args, and a JSON-serializable return. usage().limits reports the resolved concurrency and remaining call capacity.",
  "agent() returns { ok, output, structured?, ref?, error? }; always check `.ok`, use a schema for branching, and surface failed or null results.",
  "Prefer pipeline() for independent multi-stage items. Use parallel() only for a real barrier where the next step needs every prior result.",
  "Interactive sessions launch in the background by default and deliver completion later. Set wait: true only when this tool call must return the final result inline.",
  "Derive fan-out from independent verifiable work items and task difficulty. Concurrency is a runtime ceiling, not a target or the total-call limit; user cost, count, model, and effort constraints take precedence.",
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
  const { done, failed, uncertain } = countStates(details);
  const elapsed = formatElapsed(details.startedAt, details.finishedAt);
  const lines = [
    `Workflow ${details.name ? `"${details.name}"` : details.runId} ${details.status} — ` +
      `${done}/${details.agents.length} agents ok${failed ? `, ${failed} failed` : ""}${uncertain ? `, ${uncertain} uncertain` : ""} ` +
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
            : agent.state === "uncertain"
              ? "UNCERTAIN"
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

/** One bounded model projection; exact run/agent results remain in artifacts. */
export function buildProjectedWorkflowResultMessage(
  details: WorkflowDetails,
  runDir: string,
  usage?: ParentContextUsage | null,
) {
  const full = buildWorkflowResultMessage(details, runDir);
  const allocation = allocateResultBudgets(
    [Buffer.byteLength(full, "utf8")],
    usage,
    {
      maxBatchBytes: 48 * 1024,
      maxResultBytes: 48 * 1024,
      minResultBytes: 8 * 1024,
      headroomShare: 0.25,
      estimatedBytesPerToken: 4,
    },
  );
  return projectText(full, {
    maxBytes: allocation.budgets[0] ?? 8 * 1024,
    maxLines: 400,
    recovery: `Full workflow evidence is available in ${shortenHome(runDir)}.`,
  });
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
  return `Background workflow ${label} (${options.runId}) ${verb}.\n\n${options.result}\n\n(This result is already shown to the user. Act on it and relay only the decisions or next steps — do not repeat it verbatim.)`;
}

/** Fairly project one transport batch against the parent's current headroom. */
export function buildProjectedWorkflowCompletionBatch(
  entries: readonly {
    deliveryId: string;
    details: WorkflowDetails;
    runDir: string;
  }[],
  usage?: ParentContextUsage | null,
) {
  const deliveryFacts = JSON.stringify(
    entries.map(({ deliveryId, details, runDir }) => ({
      deliveryId,
      runId: details.runId,
      evidence: shortenHome(runDir),
    })),
  );
  const manifest =
    "Workflow completion delivery facts (stable across retries; deduplicate by deliveryId):\n" +
    deliveryFacts;
  const full = entries.map(({ deliveryId, details, runDir }) =>
    buildBackgroundWorkflowFollowUp({
      runId: details.runId,
      name: details.name,
      status: details.status,
      result: `${buildWorkflowResultMessage(details, runDir)}\n\nDelivery id: ${deliveryId}`,
    }),
  );
  const separatorBytes = Math.max(0, entries.length - 1) * 2;
  const manifestSeparatorBytes = entries.length > 0 ? 2 : 0;
  const fixedBytes =
    Buffer.byteLength(manifest, "utf8") +
    separatorBytes +
    manifestSeparatorBytes;
  const bodyBudget = 48 * 1024 - fixedBytes;
  if (bodyBudget < 0) {
    throw new Error(
      "Workflow completion delivery facts exceed the transport payload limit",
    );
  }
  const allocation = allocateResultBudgets(
    full.map((message) => Buffer.byteLength(message, "utf8")),
    usage,
    {
      maxBatchBytes: bodyBudget,
      maxResultBytes: 48 * 1024,
      minResultBytes: 1024,
      headroomShare: 0.25,
      estimatedBytesPerToken: 4,
      fixedBytes,
    },
  );
  const projected = full
    .map((message, index) =>
      projectText(message, {
        maxBytes: allocation.budgets[index] ?? 1024,
        maxLines: 400,
        recovery: `Full workflow evidence is available in ${shortenHome(entries[index]!.runDir)}; duplicate deliveries carry the same delivery id.`,
      }),
    )
    .join("\n\n");
  return projected ? `${manifest}\n\n${projected}` : manifest;
}

/** Split transport batches so every manifest and projected body fit together. */
export function buildProjectedWorkflowCompletionBatches(
  entries: readonly {
    deliveryId: string;
    details: WorkflowDetails;
    runDir: string;
  }[],
  usage?: ParentContextUsage | null,
) {
  const batches: Array<{
    entries: (typeof entries)[number][];
    content: string;
  }> = [];
  let current: (typeof entries)[number][] = [];
  for (const entry of entries) {
    const candidate = [...current, entry];
    try {
      buildProjectedWorkflowCompletionBatch(candidate, usage);
      current = candidate;
    } catch (error) {
      if (current.length === 0) throw error;
      batches.push({
        entries: current,
        content: buildProjectedWorkflowCompletionBatch(current, usage),
      });
      current = [entry];
    }
  }
  if (current.length > 0) {
    batches.push({
      entries: current,
      content: buildProjectedWorkflowCompletionBatch(current, usage),
    });
  }
  return batches;
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

/** Pure observation: bounded status/coverage without replaying final output. */
export function buildWorkflowStatusSummary(
  details: WorkflowDetails,
  runDir: string,
) {
  const { done, failed, uncertain } = countStates(details);
  const settled = done + failed;
  return [
    `Workflow ${details.name ? `"${details.name}"` : details.runId} ${details.status}.`,
    details.status === "uncertain"
      ? "Recovery warning: the prior owner disappeared without terminal evidence; some external effects may have occurred."
      : undefined,
    `Coverage: ${settled}/${details.agents.length} agents settled (${done} ok, ${failed} failed)${uncertain ? `; ${uncertain} uncertain` : ""}.`,
    details.currentPhase ? `Current phase: ${details.currentPhase}` : undefined,
    details.delivery ? `Delivery: ${details.delivery.state}.` : undefined,
    `Artifacts: ${shortenHome(runDir)}`,
  ]
    .filter(Boolean)
    .join("\n");
}
