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
    'Optional run id of a previous workflow (e.g. "wf_1a2b3c4d5e6f", or a unique suffix) to replay cached read-only agent results. A call replays only when its prompt, resolved agent type/schema/model/provider/effort, canonical cwd, repository state, loaded resources, and trust context match. Unrestricted/no-type agents, writable or unknown tool lists, worktree-isolated agents, failed calls, and calls whose context cannot be fingerprinted always run for real. Matching remains content-based and order-independent. Old or unknown journals simply run everything fresh.',
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

/** Defines the workflow DSL, constraints, reliability guidance, and model-authored task examples. */
export const WORKFLOW_TOOL_DESCRIPTION = [
  "Use when the user explicitly requests a workflow run or the task requires multi-phase dynamic orchestration (research fan-out, per-file review, verify-then-synthesize).",
  "The script runs as an async function body with these primitives:",
  "• export const meta = { name, description, phases: [{ title, detail? }] } — declare all phases up front.",
  "• phase(title) — mark the current phase at runtime.",
  "• log(message) — emit one progress line; the run's narrator (100 latest kept).",
  "• usage() — cumulative token spend { input, output, cacheRead, cacheWrite, total, cost, agents }; total is a LOWER BOUND.",
  "• await agent(prompt, { agent_type?, label?, phase?, schema?, acceptance?, model?, provider?, effort?, isolation?, operator?, inputs? }) — run ONE subagent and wait. agent_type applies the named preset (system prompt, tool allowlist, model, effort); explicit model/provider/effort overrides it. Always resolves to { ok, output, structured?, ref?, acceptance?, error? } — check `ok` before using the result. With `schema`, `structured` holds the validated object; `acceptance` criteria require an evidence ledger (missing/malformed/rejected criteria → ok:false). Children cannot recursively orchestrate or ask the user.",
  "• operator: 'name' reuses one in-memory child Session for serialized follow-ups; model/role/effort frozen by first activation; no per-call worktrees or result replay.",
  "• inputs: [resultRef, ...] — opaque refs from successful calls in THIS run; injected ≤16KiB per conclusion, ≤48KiB total, marked as data; graph is observability, never scheduling authority.",
  "• isolation: 'worktree' — that agent runs in its own git worktree on its own branch; tell it to COMMIT (branch kept for you to merge). Costs a fresh checkout; leave off for read-only agents.",
  "• await parallel([() => agent(...), ...], { concurrency? }) — zero-arg thunks, results in order; a throwing thunk settles to null (filter it out).",
  "• await pipeline(items, stage1, stage2, ...) — each item through every stage independently, NO barrier: item A can be in stage 3 while B is in stage 1. A stage that throws drops that item to null and skips its remaining stages. PREFER pipeline() for multi-stage work.",
  "• args — the parsed value of the `args` tool parameter (or undefined).",
  "Workflow JavaScript runs in a restricted, killable child: no imports, eval, timers, filesystem, network, or process APIs.",
  "Example — each file verified as soon as ITS OWN scan lands:",
  "export const meta = { name: 'reliability-review', description: 'Review modules', phases: [{ title: 'Scan' }, { title: 'Verify' }, { title: 'Report' }] }",
  "const checked = await pipeline(args.files, (f) => agent(`Trace ${f}`, { agent_type: 'explorer', schema: FINDINGS }), (scan, f) => scan.ok ? agent(`Verify ${f}`, { agent_type: 'reviewer', inputs: [scan.ref] }) : null)",
  "const verified = checked.filter((r) => r && r.ok); const dropped = checked.length - verified.length",
  "if (dropped) log(`${dropped}/${checked.length} file(s) dropped`)",
  "phase('Report'); const report = await agent('Synthesize', { agent_type: 'advisor' })",
  "return { verified: verified.length, dropped, report: report.ok ? report.output : report.error }",
].join("\n");

/** Adds workflow orchestration primitives and background execution to the model's tool prompt. */
export const WORKFLOW_PROMPT_SNIPPET =
  "Orchestrate isolated subagents from an inline JS script: phase()/agent()/pipeline()/parallel() with structured outputs, log() progress, usage() token readings, and optional background execution";

/** Guides the model on appropriate workflow fan-out and mandatory agent result checks. */
export const WORKFLOW_PROMPT_GUIDELINES = [
  "Use workflow when a task needs several subagents with phase dependencies or dynamic fan-out; keep single small delegations in the main session.",
  "For each workflow agent() call, select a matching agent_type when one exists (explorer, implementer, reviewer, advisor, or a loaded custom type) so its configured model, prompt, effort, and enforced tools apply; do not hardcode that role's model. Omit agent_type only for genuinely general-purpose work.",
  "Default to pipeline() for multi-stage fan-out so each item advances as soon as its own previous stage lands; use parallel() only when a stage truly needs every prior result at once.",
  "In workflow scripts, agent() never throws — check `.ok` before using `.output`/`.structured`; but parallel() and pipeline() settle a throwing thunk or stage to `null`, so guard those with `r && r.ok`.",
  "A filtered-out or null result is a failed agent, not a clean pass: surface how many dropped (e.g. return a count) so a crashed or timed-out agent never reads as success.",
  "log() anything the reader would want before the run ends — round counts, dropped agents, why a branch was skipped. A long run that narrates nothing is indistinguishable from a stalled one, and the return value only arrives at the end.",
  "When several agents will edit files concurrently, give each one isolation: 'worktree' and tell it to commit; otherwise they share one checkout and one git index and overwrite each other. Read-only agents do not need it.",
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
