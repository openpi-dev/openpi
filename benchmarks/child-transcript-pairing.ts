/**
 * Issue #185: measure the tool-call/tool-result pairing lookup.
 *
 * `findResult` resolves each call to the first result after it. With a linear
 * walk that is O(results for this id) per call, so a transcript where many
 * calls share few ids costs O(n * results) in pairing lookups. Binary searching
 * the ascending indices makes those lookups O(n * log results). Parallel calls
 * with distinct ids have constant-size per-id indices under either algorithm.
 *
 * Shapes:
 *   sequential  each call is immediately followed by its own result
 *   separated   a fan of parallel calls, then all of their results
 *   shared-id   many calls and results reuse ONE tool id, which is the case
 *               that makes the per-id index long and the linear walk expensive
 *
 * Reports the render wall time for one cold render, plus a deterministic count
 * of array reads from the per-id index so the shape of the cost is visible
 * independently of machine noise.
 */

import { performance } from "node:perf_hooks";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
  AgentTranscriptRenderer,
  buildPairingIndex,
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

/** MAX_TRANSCRIPT_ITEMS in the Direct subagent manager. */
const SIZES = parseList(readOption("--sizes"), [128, 512]);
const FAN = Number.parseInt(readOption("--fan") ?? "64", 10);
const WIDTH = Number.parseInt(readOption("--width") ?? "80", 10);
if (
  !Number.isSafeInteger(FAN) ||
  FAN <= 0 ||
  !Number.isSafeInteger(WIDTH) ||
  WIDTH <= 0
) {
  throw new Error("fan and width must be positive integers");
}

const call = (toolId: string): AgentTranscriptItem => ({
  kind: "assistant",
  parts: [
    {
      type: "toolCall",
      toolId,
      name: "read",
      argsPreview: JSON.stringify({ path: `${toolId}.ts` }),
    },
  ],
});

const result = (toolId: string): AgentTranscriptItem => ({
  kind: "toolResult",
  toolId,
  name: "read",
  isError: false,
  outputPreview: `out-${toolId}`,
});

function sequential(count: number) {
  const items: AgentTranscriptItem[] = [];
  for (let index = 0; items.length < count; index++) {
    items.push(call(`t${index}`), result(`t${index}`));
  }
  return items.slice(0, count);
}

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

/** One reused id: the per-id result index grows with the transcript. */
function sharedId(count: number) {
  const items: AgentTranscriptItem[] = [];
  while (items.length < count) {
    items.push(call("shared"));
    if (items.length < count) items.push(result("shared"));
  }
  return items.slice(0, count);
}

/**
 * Count array reads from a per-id index by wrapping the arrays the pairing
 * index hands to findResult. This is deterministic, unlike wall time.
 */
function instrumentedPairing(items: ReadonlyArray<AgentTranscriptItem>) {
  const base = buildPairingIndex(items);
  let reads = 0;
  const resultsById = new Map<string, ReadonlyArray<number>>();
  for (const [id, indices] of base.resultsById) {
    resultsById.set(
      id,
      new Proxy(indices as number[], {
        get(target, property, receiver) {
          if (typeof property === "string" && /^\d+$/.test(property)) reads++;
          return Reflect.get(target, property, receiver);
        },
      }),
    );
  }
  return { pairing: { ...base, resultsById }, reads: () => reads };
}

for (const shape of ["sequential", "separated", "shared-id"] as const) {
  for (const size of SIZES) {
    const items =
      shape === "sequential"
        ? sequential(size)
        : shape === "separated"
          ? separated(size, Math.min(FAN, Math.max(1, size >> 1)))
          : sharedId(size);

    const probe = instrumentedPairing(items);
    const document = { items, pairing: probe.pairing };
    const started = performance.now();
    const rows = new AgentTranscriptRenderer().render(document, WIDTH, theme, {
      now: 0,
    }).length;
    const ms = performance.now() - started;

    const longestIndex = Math.max(
      0,
      ...[...probe.pairing.resultsById.values()].map((v) => v.length),
    );

    console.log(
      JSON.stringify({
        shape,
        items: size,
        rows,
        longestPerIdIndex: longestIndex,
        indexReads: probe.reads(),
        renderMs: Number(ms.toFixed(2)),
      }),
    );
  }
}
