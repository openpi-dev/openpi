/**
 * Issue #185: a human-readable side-by-side of repaint cost, using realistic
 * child-session content at the production transcript ceiling.
 *
 * Reports three regimes separately, because the change only helps one of them:
 *
 *   cold open        first paint of a page; both paths must measure every item
 *                    to know the row total, so this is NOT improved
 *   warm repaint     nothing changed (spinner tick, stream delta elsewhere);
 *                    this is the hot path an operator hits continuously
 *   after invalidate theme change or resize drops every cached row; both paths
 *                    must re-render, so this is NOT improved
 *
 * Wall time here is indicative only; benchmarks/child-transcript-viewport.ts
 * reports the deterministic item-visit counts.
 */

import { performance } from "node:perf_hooks";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
  AgentTranscriptRenderer,
  buildPairingIndex,
  type AgentTranscriptDocument,
  type AgentTranscriptItem,
} from "../extensions/shared/agent-transcript.ts";

initTheme("dark", false);

const theme = new Proxy(
  {},
  {
    get: (_target, prop) =>
      prop === "fg"
        ? (_color: string, text: string) => text
        : (text: string) => text,
  },
) as Theme;

function readOption(name: string) {
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1];
  return process.argv
    .find((argument) => argument.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

/** MAX_TRANSCRIPT_ITEMS in the Direct subagent manager. */
const CEILING = 512;
const SIZES = (readOption("--sizes") ?? `128,${CEILING}`)
  .split(",")
  .map((value) => Number.parseInt(value, 10));
const WIDTH = Number.parseInt(readOption("--width") ?? "100", 10);
const VIEWPORT = Number.parseInt(readOption("--viewport") ?? "40", 10);

/** Markdown-heavy turns, like a real coding child session. */
const PROSE = `Looking at the failure, the root cause is that \`resolveConfig\`
reads the cached value before the watcher fires. Two options:

1. Invalidate the cache in the watcher callback
2. Read through a getter that checks mtime

Option 1 is smaller but races with concurrent readers.`;

function realistic(count: number) {
  const items: AgentTranscriptItem[] = [];
  for (let turn = 0; items.length < count; turn++) {
    items.push({
      kind: "user",
      text: `Fix the failing test in module ${turn}`,
    });
    items.push({
      kind: "assistant",
      parts: [{ type: "thinking", text: `Considering approach ${turn}...` }],
    });
    items.push({ kind: "assistant", parts: [{ type: "text", text: PROSE }] });
    items.push({
      kind: "assistant",
      parts: [
        {
          type: "toolCall",
          toolId: `t${turn}`,
          name: "read",
          argsPreview: JSON.stringify({ path: `src/module-${turn}/config.ts` }),
        },
      ],
    });
    items.push({
      kind: "toolResult",
      toolId: `t${turn}`,
      name: "read",
      isError: false,
      outputPreview: `export const config = { retries: ${turn} };`,
    });
  }
  return items.slice(0, count);
}

type Mode = "before" | "after";

function paint(
  renderer: AgentTranscriptRenderer,
  document: AgentTranscriptDocument,
  mode: Mode,
) {
  if (mode === "before") {
    // The pre-change path: render every row, then clip to the viewport.
    const all = renderer.render(document, WIDTH, theme, { now: 0 });
    return all.slice(Math.max(0, all.length - VIEWPORT));
  }
  const frame = renderer.beginFrame(document, WIDTH, theme, { now: 0 });
  return frame.rows(Math.max(0, frame.rowCount - VIEWPORT), VIEWPORT);
}

function averageMs(run: () => void, iterations: number) {
  const started = performance.now();
  for (let index = 0; index < iterations; index++) run();
  return (performance.now() - started) / iterations;
}

function bar(ms: number, scale: number) {
  return "█".repeat(Math.max(1, Math.round((ms / scale) * 40)));
}

for (const size of SIZES) {
  const items = realistic(size);
  const document: AgentTranscriptDocument = {
    items,
    pairing: buildPairingIndex(items),
  };
  const rows = new AgentTranscriptRenderer().beginFrame(
    document,
    WIDTH,
    theme,
    { now: 0 },
  ).rowCount;

  const measured: Record<Mode, Record<string, number>> = {
    before: {},
    after: {},
  };
  for (const mode of ["before", "after"] as Mode[]) {
    measured[mode].coldOpen = averageMs(
      () => paint(new AgentTranscriptRenderer(), document, mode),
      20,
    );

    const warm = new AgentTranscriptRenderer();
    paint(warm, document, mode);
    measured[mode].warmRepaint = averageMs(
      () => paint(warm, document, mode),
      500,
    );

    const dirty = new AgentTranscriptRenderer();
    paint(dirty, document, mode);
    measured[mode].afterInvalidate = averageMs(() => {
      dirty.invalidate();
      paint(dirty, document, mode);
    }, 20);
  }

  const label = size === CEILING ? ` (transcript ceiling)` : "";
  console.log(
    `\n${size} items${label} -> ${rows} rows, showing ${VIEWPORT} at width ${WIDTH}`,
  );
  console.log(`  ${"-".repeat(64)}`);
  for (const [key, title, improves] of [
    ["coldOpen", "cold open       ", false],
    ["warmRepaint", "warm repaint    ", true],
    ["afterInvalidate", "after invalidate", false],
  ] as [string, string, boolean][]) {
    const before = measured.before[key]!;
    const after = measured.after[key]!;
    const scale = Math.max(before, after);
    const note = improves
      ? `${(before / after).toFixed(0)}x faster`
      : "unchanged by design";
    console.log(
      `  ${title}   before  ${before.toFixed(3)} ms  ${bar(before, scale)}`,
    );
    console.log(
      `  ${" ".repeat(16)}   after   ${after.toFixed(3)} ms  ${bar(after, scale)}`,
    );
    console.log(`  ${" ".repeat(16)}   ${note}`);
    console.log(`  ${"-".repeat(64)}`);
  }
}

console.log(`
How to read this:

  warm repaint is the hot path. An open child page repaints on every spinner
  tick and every stream delta, so this cost is paid continuously for as long
  as an operator watches a run. That is what this change removes.

  cold open and after-invalidate are unchanged on purpose: a scrollable view
  must know its total row count, and knowing that means measuring every item
  once. Both paths pay that, and the result is then cached.

  All figures are well under a 16 ms frame budget, so this is a scaling fix,
  not a fix for visible lag today: before the change the warm cost grew with
  history length, after it is flat.
`);
