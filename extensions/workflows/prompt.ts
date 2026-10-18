import {
  allocateResultBudgets,
  type ParentContextUsage,
} from "../shared/result-budget.ts";
import { sanitizeTerminalText } from "../shared/terminal-text.ts";
import { projectText } from "../shared/text-projection.ts";
import { workflowCompletionLines } from "./agent-completion.ts";
import {
  countStates,
  formatElapsed,
  resultJson,
  shortenHome,
  type WorkflowDetails,
} from "./model.ts";

const COMPLETION_DELIVERY_FACTS_LIMIT_ERROR =
  "Workflow completion delivery facts exceed the transport payload limit";

/** Model-facing schema descriptions for workflow source and launch policy. */
export const WORKFLOW_PARAMETER_DESCRIPTIONS = {
  script:
    "Async JavaScript body; may start with `export const meta = {...}` and must end with `return`.",
  args: "Optional JSON string exposed to the script as `args`.",
  background: "Deprecated alias for wait (true means wait: false). Do not use.",
  wait: "Return the final result in this call. Defaults to false in interactive sessions and true in print/automation.",
  resumeFromRunId:
    "Prior run id (or unique suffix) whose safe read-only calls may be replayed.",
};

/** Describes stopping a running workflow. */
export const WORKFLOW_STOP_TOOL_DESCRIPTION =
  "Cancel a running workflow. Partial results and artifacts are kept.";

/** Model-facing schema description for the workflow run id to stop. */
export const WORKFLOW_STOP_PARAMETER_DESCRIPTIONS = {
  runId: 'Run id, e.g. "wf_1a2b3c4d5e6f".',
};

/** Describes nonblocking inspection of workflow runs. */
export const WORKFLOW_STATUS_TOOL_DESCRIPTION =
  "Show a workflow run's status and artifact location without blocking, or omit runId to list this session's runs.";

/** Model-facing schema description for the optional workflow run id to inspect. */
export const WORKFLOW_STATUS_PARAMETER_DESCRIPTIONS = {
  runId: "Run id; omit to list runs.",
};

/** Adds workflow lifecycle inspection/cancellation to the parent model's tools prompt. */
export const WORKFLOW_LIFECYCLE_PROMPT_SNIPPET =
  "Inspect or cancel workflow runs";

/** Compact resident contract; the workflows Skill carries the complete guide. */
export const WORKFLOW_TOOL_DESCRIPTION =
  "Run a multi-phase subagent orchestration written as an async JavaScript body. DSL: phase(), agent(prompt, opts) returning { ok, output, structured?, ref?, error? }, pipeline(items, ...stages), parallel([() => agent(...)]), log(), usage(), args; return a JSON-serializable result and check every agent result's .ok. Interactive sessions run it in the background and deliver the result later; set wait: true only when this call must return the result. Read the workflows skill before writing a nontrivial script.";

/** Adds workflow orchestration primitives and background execution to the model's tool prompt. */
export const WORKFLOW_PROMPT_SNIPPET =
  "Orchestrate several dependent subagent calls from a JS script";

/** Guides the model on appropriate workflow fan-out and mandatory agent result checks. */
export const WORKFLOW_PROMPT_GUIDELINES = [
  "Use workflow only for several subagent calls with phase dependencies or dynamic fan-out; a single delegation belongs in subagent_spawn.",
];

/** Marks and forwards a workflow script's agent() task as an isolated child-model prompt. */
export function buildWorkflowAgentPrompt(prompt: string) {
  return prompt;
}

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
          (agent.acceptance
            ? ` · deprecated model self-attestation ${agent.acceptance.status}`
            : "") +
          (agent.error ? ` — ${agent.error}` : ""),
      );
    }
  }
  lines.push("", ...workflowCompletionLines(details.runId, details.agents));
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
    throw new Error(COMPLETION_DELIVERY_FACTS_LIMIT_ERROR);
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
  let start = 0;
  while (start < entries.length) {
    let low = start + 1;
    let high = entries.length;
    let selected:
      | {
          entries: (typeof entries)[number][];
          content: string;
        }
      | undefined;
    let firstError: unknown;

    // A candidate only fails when its stable delivery-facts manifest exceeds
    // the transport budget, so prefix feasibility is monotonic.
    while (low <= high) {
      const end = Math.floor((low + high) / 2);
      const candidate = entries.slice(start, end);
      try {
        const content = buildProjectedWorkflowCompletionBatch(candidate, usage);
        selected = { entries: candidate, content };
        low = end + 1;
      } catch (error) {
        if (
          !(error instanceof Error) ||
          error.message !== COMPLETION_DELIVERY_FACTS_LIMIT_ERROR
        ) {
          throw error;
        }
        firstError ??= error;
        high = end - 1;
      }
    }

    if (!selected) throw firstError;
    batches.push(selected);
    start += selected.entries.length;
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
    ...workflowCompletionLines(details.runId, details.agents),
  ]
    .filter(Boolean)
    .join("\n");
}
