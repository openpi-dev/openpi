/**
 * Issue #185: prove child transcript repaint cost tracks viewport height, not
 * transcript length.
 *
 * Counts numeric index reads on the items array, which is the exact quantity the
 * issue objects to: "scans the full history before clipping to the viewport".
 * Wall time is reported too, but the visit count is the load-bearing number
 * because it is deterministic and machine-comparable.
 *
 * Shapes cover both cases the issue names:
 *   sequential  - each call is followed by its own result
 *   separated   - a fan of calls, then all their results (the pairing worst case)
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

function parseList(raw: string | undefined, fallback: number[]) {
  if (!raw) return fallback;
  const values = raw.split(",").map((value) => Number.parseInt(value, 10));
  if (values.some((value) => !Number.isSafeInteger(value) || value <= 0)) {
    throw new Error("expected a comma-separated list of positive integers");
  }
  return values;
}

const SIZES = parseList(readOption("--sizes"), [32, 128, 512]);
const VIEWPORTS = parseList(readOption("--viewports"), [40]);
const REPAINTS = Number.parseInt(readOption("--repaints") ?? "100", 10);
const FAN = Number.parseInt(readOption("--fan") ?? "64", 10);
const WIDTH = Number.parseInt(readOption("--width") ?? "80", 10);
/**
 * window: resolve the row total, then render only the viewport (this change).
 * full:   render every row, then slice the viewport (the behaviour #185 objects
 *         to, reproduced through the same public renderer for comparison).
 */
const MODE = readOption("--mode") ?? "window";
if (MODE !== "window" && MODE !== "full") {
  throw new Error("--mode must be 'window' or 'full'");
}

const ask = (index: number): AgentTranscriptItem => ({
  kind: "user",
  text: `ask ${index}`,
});
const say = (index: number): AgentTranscriptItem => ({
  kind: "assistant",
  parts: [{ type: "text", text: `step ${index}` }],
});
const call = (id: string): AgentTranscriptItem => ({
  kind: "assistant",
  parts: [
    {
      type: "toolCall",
      toolId: id,
      name: "read",
      argsPreview: JSON.stringify({ path: `${id}.ts` }),
    },
  ],
});
const result = (id: string): AgentTranscriptItem => ({
  kind: "toolResult",
  toolId: id,
  name: "read",
  isError: false,
  outputPreview: `out-${id}`,
});

/** Calls immediately followed by their results. */
function sequential(count: number) {
  const items: AgentTranscriptItem[] = [];
  for (let index = 0; items.length < count; index++) {
    items.push(ask(index), say(index), call(`t${index}`), result(`t${index}`));
  }
  return items.slice(0, count);
}

/** A fan of parallel calls, then all of their results. */
function separated(count: number, fan: number) {
  const items: AgentTranscriptItem[] = [];
  let base = 0;
  while (items.length < count) {
    const ids: string[] = [];
    for (let index = 0; index < fan && items.length < count; index++) {
      const id = `p${base + index}`;
      ids.push(id);
      items.push(call(id));
    }
    for (const id of ids) {
      if (items.length >= count) break;
      items.push(result(id));
    }
    base += fan;
  }
  return items.slice(0, count);
}

/** Count numeric index reads: how much of the history each frame touches. */
function instrument(items: AgentTranscriptItem[]) {
  let visits = 0;
  const proxy = new Proxy(items, {
    get(target, property, receiver) {
      if (typeof property === "string" && /^\d+$/.test(property)) visits++;
      return Reflect.get(target, property, receiver);
    },
  });
  return {
    items: proxy as ReadonlyArray<AgentTranscriptItem>,
    visits: () => visits,
    reset: () => {
      visits = 0;
    },
  };
}

for (const shape of ["sequential", "separated"] as const) {
  for (const size of SIZES) {
    for (const viewport of VIEWPORTS) {
      const source =
        shape === "sequential"
          ? sequential(size)
          : separated(size, Math.min(FAN, Math.max(1, size >> 1)));
      const probe = instrument(source);
      // Production documents carry the pairing index built by their producer.
      const document: AgentTranscriptDocument = {
        items: probe.items,
        pairing: buildPairingIndex(source),
      };
      const renderer = new AgentTranscriptRenderer();

      /** One repaint: returns the rows the viewport would show. */
      const repaint = () => {
        if (MODE === "full") {
          // The pre-change path: render everything, then clip.
          const all = renderer.render(document, WIDTH, theme, { now: 0 });
          const top = Math.max(0, all.length - viewport);
          return { rowCount: all.length, rows: all.slice(top, top + viewport) };
        }
        const frame = renderer.beginFrame(document, WIDTH, theme, { now: 0 });
        const top = Math.max(0, frame.rowCount - viewport);
        return { rowCount: frame.rowCount, rows: frame.rows(top, viewport) };
      };

      // Cold: the first frame measures the history once.
      const coldStarted = performance.now();
      const cold = repaint();
      const coldMs = performance.now() - coldStarted;
      const coldVisits = probe.visits();

      // Hot: repaint the same unchanged transcript at the bottom.
      probe.reset();
      const hotStarted = performance.now();
      for (let index = 0; index < REPAINTS; index++) repaint();
      const hotMs = performance.now() - hotStarted;

      console.log(
        JSON.stringify({
          mode: MODE,
          shape,
          items: size,
          viewport,
          rowCount: cold.rowCount,
          renderedRows: cold.rows.length,
          coldVisits,
          coldMs: Number(coldMs.toFixed(2)),
          repaints: REPAINTS,
          hotVisitsPerRepaint: probe.visits() / REPAINTS,
          hotMsPerRepaint: Number((hotMs / REPAINTS).toFixed(4)),
        }),
      );
    }
  }
}
