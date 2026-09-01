/**
 * Idle repaint cost of the below-editor Workflow and Subagent strips.
 *
 * Both strips used to hold an unconditional `setInterval` that called
 * `tui.requestRender()` for as long as they were visible — and a settled
 * unread entry stays visible until the user's next explicit request. So a
 * finished run left the terminal repainting at 120 ms (Workflow) and 500 ms
 * (Subagent) forever, drawing a line that never changed.
 *
 * Each arm runs for real wall-clock time and reports the render requests plus
 * the process CPU it burned. Scope note: this measures the strips' own timers
 * and their render work, not the rest of the frame a real `requestRender()`
 * would repaint downstream — the true idle saving is larger than the delta
 * printed here, never smaller.
 *
 *   node --experimental-strip-types benchmarks/strip-idle-render.ts
 *   node --experimental-strip-types benchmarks/strip-idle-render.ts --seconds 10
 */

import { performance } from "node:perf_hooks";
import type { TUI } from "@earendil-works/pi-tui";
import { BelowEditorStripState } from "../extensions/shared/below-editor-navigation.ts";
import { SPINNER_INTERVAL_MS } from "../extensions/shared/spinner.ts";
import {
  SubagentStripWidget,
  type SubagentStripEntry,
} from "../extensions/subagents/navigation.ts";
import type { SubagentSnapshot } from "../extensions/subagents/src/domain.ts";
import type { Theme, WorkflowDetails } from "../extensions/workflows/model.ts";
import {
  WorkflowStripWidget,
  type WorkflowStripEntry,
} from "../extensions/workflows/navigation.ts";

/** The 500 ms subagent cadence, mirrored here because it stays module-private. */
const SUBAGENT_STRIP_INTERVAL_MS = 500;
const WIDTH = 120;

function readOption(name: string) {
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1];
  return process.argv
    .find((argument) => argument.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

function parseSeconds(raw: string | undefined) {
  const seconds = Number.parseFloat(raw ?? "60");
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error("--seconds must be a positive number");
  }
  return seconds;
}

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  underline: (text: string) => text,
  strikethrough: (text: string) => text,
  inverse: (text: string) => text,
} as unknown as Theme;

function workflowEntry(status: WorkflowDetails["status"]): WorkflowStripEntry {
  const startedAt = Date.now() - 30_000;
  const details: WorkflowDetails = {
    runId: "wf_bench",
    name: "review-changes",
    description: "Review the working tree across dimensions",
    background: true,
    status,
    startedAt,
    ...(status === "running" ? {} : { finishedAt: startedAt + 20_000 }),
    currentPhase: "Verify",
    phases: [{ title: "Review" }, { title: "Verify" }],
    agents: [
      {
        index: 1,
        label: "review:bugs",
        phase: "Review",
        state: status === "running" ? "running" : "done",
        startedAt,
        preview: "",
        usage: {
          input: 12_000,
          output: 3_400,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
          turns: 2,
        },
        transcript: [],
      },
    ],
  };
  return { runId: details.runId, details };
}

function subagentEntry(status: SubagentSnapshot["status"]): SubagentStripEntry {
  const createdAt = Date.now() - 30_000;
  const snapshot: SubagentSnapshot = {
    id: "sa-1",
    origin: "model",
    backend: "pi",
    title: "investigate idle repaints",
    prompt: "inspect",
    cwd: process.cwd(),
    status,
    createdAt,
    ...(status === "running" ? {} : { settledAt: createdAt + 20_000 }),
    meta: { backend: "pi", modelLabel: "bench-model" },
    usage: { tokens: 24_000, contextWindow: 200_000 },
    transcript: [],
    transcriptVersion: 0,
    liveTools: [],
    queued: [],
    finalText: status === "running" ? "" : "done",
    turns: 1,
  };
  return {
    snapshot,
    counts:
      status === "running"
        ? { running: 1, done: 0, failed: 0 }
        : { running: 0, done: 1, failed: 0 },
  };
}

interface Arm {
  readonly renders: () => number;
  readonly dispose: () => void;
}

/** The shipped widgets, driven exactly as the TUI drives them. */
function currentStrips(status: "running" | "settled"): Arm {
  let renders = 0;
  const workflow = workflowEntry(
    status === "running" ? "running" : "completed",
  );
  const subagent = subagentEntry(status === "running" ? "running" : "done");
  // A real requestRender repaints the frame, which re-renders the strip. Doing
  // the same here keeps the CPU number attributable rather than counting bare
  // callback invocations.
  const tui = {
    requestRender() {
      renders += 1;
      workflowWidget.render(WIDTH);
      subagentWidget.render(WIDTH);
    },
  } as unknown as TUI;
  const workflowWidget = new WorkflowStripWidget(
    tui,
    theme,
    new BelowEditorStripState(),
    () => workflow,
  );
  const subagentWidget = new SubagentStripWidget(
    tui,
    theme,
    new BelowEditorStripState(),
    () => subagent,
  );
  // First paint: the widgets start their timers from render(), as the TUI does.
  workflowWidget.render(WIDTH);
  subagentWidget.render(WIDTH);
  return {
    renders: () => renders,
    dispose() {
      workflowWidget.dispose();
      subagentWidget.dispose();
    },
  };
}

/** Pre-fix behavior: visible means ticking, whatever the entry's status. */
function unconditionalStrips(status: "running" | "settled"): Arm {
  let renders = 0;
  const workflow = workflowEntry(
    status === "running" ? "running" : "completed",
  );
  const subagent = subagentEntry(status === "running" ? "running" : "done");
  const strip = new BelowEditorStripState();
  const workflowWidget = new WorkflowStripWidget(
    { requestRender() {} } as unknown as TUI,
    theme,
    strip,
    () => workflow,
  );
  const subagentWidget = new SubagentStripWidget(
    { requestRender() {} } as unknown as TUI,
    theme,
    strip,
    () => subagent,
  );
  workflowWidget.dispose();
  subagentWidget.dispose();
  const tick = () => {
    renders += 1;
    workflowWidget.render(WIDTH);
    subagentWidget.render(WIDTH);
  };
  const timers = [
    setInterval(tick, SPINNER_INTERVAL_MS),
    setInterval(tick, SUBAGENT_STRIP_INTERVAL_MS),
  ];
  for (const timer of timers) timer.unref?.();
  return {
    renders: () => renders,
    dispose() {
      for (const timer of timers) clearInterval(timer);
      workflowWidget.dispose();
      subagentWidget.dispose();
    },
  };
}

async function measure(
  phase: string,
  seconds: number,
  build: () => Arm,
): Promise<number> {
  const arm = build();
  const cpuBefore = process.cpuUsage();
  const started = performance.now();
  await new Promise((resolve) => setTimeout(resolve, seconds * 1_000));
  const wallMs = performance.now() - started;
  const cpu = process.cpuUsage(cpuBefore);
  arm.dispose();
  const renders = arm.renders();
  const cpuMs = (cpu.user + cpu.system) / 1_000;
  console.log(
    JSON.stringify({
      phase,
      seconds,
      renderRequests: renders,
      rendersPerSecond: Number((renders / (wallMs / 1_000)).toFixed(2)),
      cpuMs: Number(cpuMs.toFixed(1)),
      cpuPercent: Number(((cpuMs / wallMs) * 100).toFixed(3)),
      wallMs: Number(wallMs.toFixed(1)),
    }),
  );
  return renders;
}

const seconds = parseSeconds(readOption("--seconds"));

// Warm up first: whichever arm runs first otherwise pays the module's JIT and
// first-render cost, which would inflate the reported saving.
for (const build of [
  () => unconditionalStrips("settled"),
  () => currentStrips("running"),
]) {
  const arm = build();
  await new Promise((resolve) => setTimeout(resolve, 500));
  arm.dispose();
}

// A bare sleeping Node process is not free, so measure the floor first: the
// per-arm CPU numbers below only mean something relative to it.
await measure("process-floor", seconds, () => ({
  renders: () => 0,
  dispose() {},
}));

// Idle is the case #189 is about: nothing is running, the strips only hold an
// unread settled notice.
const before = await measure("settled-idle-before", seconds, () =>
  unconditionalStrips("settled"),
);
const after = await measure("settled-idle-after", seconds, () =>
  currentStrips("settled"),
);
// Control: the spinner must still animate at its old cadence while work runs,
// so the idle saving is not bought by dropping live feedback.
await measure("running-after", seconds, () => currentStrips("running"));

console.log(
  JSON.stringify({
    phase: "summary",
    seconds,
    idleRenderRequestsBefore: before,
    idleRenderRequestsAfter: after,
    eliminated: before - after,
  }),
);
