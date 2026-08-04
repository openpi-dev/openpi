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
  "Use the workflow tool when the user explicitly requests a workflow run or when the task clearly requires multi-phase dynamic orchestration.",
  "Run a multi-agent workflow from a JavaScript orchestration script you write inline. Use this when a task benefits from fanning work out across several isolated subagents in ordered phases (research fan-out, per-file review, verify-then-synthesize pipelines).",
  "The script runs as an async function body with these primitives:",
  "• export const meta = { name, description, phases: [{ title, detail? }] } — metadata for the progress UI. Declare all phases up front.",
  "• phase(title) — mark the current phase at runtime (use titles from meta.phases).",
  "• await agent(prompt, { label?, phase?, schema?, model?, provider?, effort? }) — run ONE subagent in an isolated context and wait for it. Always resolves to { ok, output, structured?, error? }. Check `ok` before using the result. When you pass a JSON `schema`, `structured` holds the validated object on success. `model`/`provider` override the session model; `effort` sets the thinking level (off|minimal|low|medium|high|xhigh|max). Children receive normal built-ins and trust-appropriate extensions, settings, skills, and AGENTS.md context, but cannot recursively orchestrate or ask the user.",
  "• await parallel([() => agent(...), () => agent(...)], { concurrency? }) — run zero-argument agent thunks concurrently and return results in order. This is a BARRIER: nothing after it starts until every thunk settles. A thunk that throws settles to null (filter it out) rather than failing the whole batch, so one bad item never discards the others' results. The package default is 8 concurrent agents per workflow and can be changed with /my-pi-setup (hard maximum 64).",
  "• await pipeline(items, stage1, stage2, ...) — run each item through every stage independently, with NO barrier between stages: item A can be in stage 3 while item B is still in stage 1. Results come back in input order. Each stage receives (previousResult, originalItem, index), so a later stage can label its work without threading context through the earlier stage's return value. A stage that throws drops that item to null and skips its remaining stages, leaving siblings untouched.",
  "PREFER pipeline() for multi-stage work. parallel() forces every item to wait for the slowest one in each stage, so wall-clock becomes the sum of per-stage worst cases (max stage1 + max stage2) instead of the slowest single chain. The gap is widest when different items are slow in different stages; when one item is slowest everywhere it is the critical path either way. Reach for a barrier only when a stage genuinely needs cross-item context from ALL of the previous one: deduping or merging the full result set, exiting early when the total count is zero, or a prompt that compares one finding against the others. Needing to flatten/map/filter in between is NOT a reason — do that inside a pipeline stage.",

  "• args — the parsed value of the `args` tool parameter (or undefined).",
  "Workflow JavaScript runs in a restricted, killable child with no imports, eval, timers, filesystem, network, or process APIs. The package default permits 128 agent calls per run and can be changed with /my-pi-setup (hard maximum 1024); there is no overall deadline. Each agent must receive its first assistant response event within 45 seconds so silent provider requests fail clearly; after that, agent() has no wall-clock deadline. Each individual child tool call times out independently after 3 minutes, becomes an error tool result, and leaves the agent loop free to recover. Use map/filter/if/await/template strings to orchestrate, and `return` a JSON-serializable aggregate.",
  "Pass a `schema` to agent() whenever a later step branches on the result, so you get typed fields instead of prose. There is no resume: a failed run is simply re-run. Artifacts are saved under ~/.pi/agent/workflows/<runId>/ for inspection.",
  "Example — each file is verified as soon as ITS OWN scan lands, instead of waiting for every scan:",
  "export const meta = { name: 'reliability-review', description: 'Review modules for reliability risks, then report', phases: [{ title: 'Scan' }, { title: 'Verify' }, { title: 'Report' }] }",
  "const FINDINGS = { type: 'object', properties: { issues: { type: 'array', items: { type: 'string' } }, ok: { type: 'boolean' } }, required: ['issues', 'ok'] }",
  "phase('Scan')",
  "const checked = await pipeline(args.files,",
  "  (f) => agent(`Review ${f} for correctness and reliability risks.`, { label: `scan:${f}`, phase: 'Scan', schema: FINDINGS }),",
  "  (scan, f) => scan.ok ? agent(`Confirm these issues in ${f} are real: ${JSON.stringify(scan.structured.issues)}`, { label: `verify:${f}`, phase: 'Verify' }) : null)",
  "const verified = checked.filter((r) => r && r.ok)",
  "const dropped = checked.length - verified.length // agents that failed/dropped: surface, never silently swallow",
  "phase('Report')",
  "const report = await agent(`Summarize these verified findings: ${JSON.stringify(verified.map((r) => r.output))}`, { label: 'report', phase: 'Report' })",
  "return { verified: verified.length, dropped, report: report.ok ? report.output : report.error }",
].join("\n");

/** Adds workflow orchestration primitives and background execution to the model's tool prompt. */
export const WORKFLOW_PROMPT_SNIPPET =
  "Orchestrate isolated subagents from an inline JS script: phase()/agent()/pipeline()/parallel() with structured outputs and optional background execution";

/** Guides the model on appropriate workflow fan-out and mandatory agent result checks. */
export const WORKFLOW_PROMPT_GUIDELINES = [
  "Use workflow when a task needs several subagents with phase dependencies or dynamic fan-out; keep single small delegations in the main session.",
  "Default to pipeline() for multi-stage fan-out so each item advances as soon as its own previous stage lands; use parallel() only when a stage truly needs every prior result at once.",
  "In workflow scripts, agent() never throws — check `.ok` before using `.output`/`.structured`; but parallel() and pipeline() settle a throwing thunk or stage to `null`, so guard those with `r && r.ok`.",
  "A filtered-out or null result is a failed agent, not a clean pass: surface how many dropped (e.g. return a count) so a crashed or timed-out agent never reads as success.",
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
  if (details.error) lines.push(`Error: ${details.error}`);
  if (details.agents.length > 0) {
    lines.push("", "Agents:");
    for (const agent of details.agents) {
      const status =
        agent.state === "done"
          ? "ok"
          : agent.state === "error"
            ? "FAILED"
            : "running";
      lines.push(
        `- [${agent.label}]${agent.phase ? ` (${agent.phase})` : ""} ${status}` +
          (agent.error ? ` — ${agent.error}` : ""),
      );
    }
  }
  if (details.result !== undefined)
    lines.push("", "Result:", resultJson(details.result));
  return lines.join("\n");
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
