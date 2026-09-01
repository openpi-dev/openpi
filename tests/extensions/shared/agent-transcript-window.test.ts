import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";

import { initTheme } from "@earendil-works/pi-coding-agent";
import { AgentToolRenderLedger } from "../../../extensions/shared/agent-tool-renderer.ts";
import {
  AgentTranscriptRenderer,
  buildPairingIndex,
} from "../../../extensions/shared/agent-transcript.ts";
import type {
  AgentTranscriptDocument,
  AgentTranscriptItem,
} from "../../../extensions/shared/agent-transcript.ts";

initTheme("dark", false);

/**
 * Viewport-first rendering for #185.
 *
 * `beginFrame().rows(top, height)` must return exactly the rows at those
 * absolute positions while only rendering the window. These tests avoid
 * comparing `rows()` against `render()` alone: both now share one path, so that
 * comparison cannot detect a layout bug that shifts every row consistently.
 * Instead each case pins an expected row count and expected row content.
 *
 * Mutation-checked (measured). Each of these fails at least one case here:
 *   - treating any cached layout as reusable (skipping the front-trim check);
 *   - ignoring native tool revisions in `settleToolRows`;
 *   - dropping the same-frame repair when a visible item changed identity;
 *   - starting the binary search in `findResult` at slot 0.
 */
const theme = new Proxy(
  {},
  {
    get: (_target, prop) =>
      prop === "fg"
        ? (_color: string, text: string) => text
        : (text: string) => text,
  },
) as never;

const call = (toolId: string, name = "read"): AgentTranscriptItem => ({
  kind: "assistant",
  parts: [
    {
      type: "toolCall",
      toolId,
      name,
      argsPreview: JSON.stringify({ path: `${toolId}.ts` }),
    } as never,
  ],
});

const result = (
  toolId: string,
  isError = false,
  name = "read",
): AgentTranscriptItem => ({
  kind: "toolResult",
  toolId,
  name,
  isError,
  outputPreview: `out-${toolId}`,
});

const bash = (toolId: string, command: string): AgentTranscriptItem => ({
  kind: "assistant",
  parts: [
    {
      type: "toolCall",
      toolId,
      name: "bash",
      argsPreview: JSON.stringify({ command }),
    } as never,
  ],
});

const say = (text: string): AgentTranscriptItem => ({
  kind: "assistant",
  parts: [{ type: "text", text }],
});

const ask = (text: string): AgentTranscriptItem => ({ kind: "user", text });

/**
 * Strip colour and the Nerd Font tool icons so expectations read as structure.
 * The icons live in the private-use area and carry no assertion value here.
 */
const plain = (rows: ReadonlyArray<string>) =>
  rows.map((row) =>
    stripVTControlCharacters(row)
      .replace(/[\uE000-\uF8FF]/g, "•")
      .trimEnd(),
  );

function frame(
  document: AgentTranscriptDocument,
  renderer = new AgentTranscriptRenderer(),
  width = 60,
) {
  return renderer.beginFrame(document, width, theme, { now: 0 });
}

/** Interleaved conversation with sequential call/result pairs. */
function sequential(pairs: number) {
  const items: AgentTranscriptItem[] = [];
  for (let index = 0; index < pairs; index++) {
    items.push(ask(`ask ${index}`));
    items.push(say(`step ${index}`));
    items.push(call(`t${index}`));
    items.push(result(`t${index}`));
  }
  return items;
}

/** All calls emitted before any result: the quadratic-pairing shape. */
function separated(width: number) {
  const items: AgentTranscriptItem[] = [];
  for (let index = 0; index < width; index++) items.push(call(`p${index}`));
  for (let index = 0; index < width; index++) items.push(result(`p${index}`));
  return items;
}

/**
 * Every window must be the corresponding slice of one reference transcript
 * assembled row by row from single-row windows. A single-row window shares no
 * offset arithmetic with a wide one, so a broken layout shows up as a diff.
 */
function assertWindowsAgree(
  document: AgentTranscriptDocument,
  expectedRowCount: number,
) {
  const rowByRow = frame(document);
  assert.equal(rowByRow.rowCount, expectedRowCount, "row count");
  const reference: string[] = [];
  for (let row = 0; row < expectedRowCount; row++) {
    const single = rowByRow.rows(row, 1);
    assert.equal(single.length, 1, `row ${row} must exist`);
    reference.push(single[0]!);
  }

  // One renderer across all windows, so a stale cache surfaces as a diff.
  const renderer = new AgentTranscriptRenderer();
  for (const height of [2, 5, 13, expectedRowCount + 4]) {
    for (let top = 0; top <= expectedRowCount; top++) {
      const rows = frame(document, renderer).rows(top, height);
      assert.deepEqual(
        rows,
        reference.slice(top, top + height),
        `window ${top}+${height}`,
      );
    }
  }
  return reference;
}

test("a window is the transcript's rows at absolute positions", () => {
  const items = [ask("hi"), say("## Result\n\nbody")];
  const rows = assertWindowsAgree({ items }, 7);
  assert.deepEqual(plain(rows), ["", " hi", "", "", " Result", "", " body"]);
  // A window past the end must stay empty rather than exposing untrimmed rows.
  assert.deepEqual(frame({ items }).rows(7, 3), []);
});

test("a settled tool block keeps its leading separator row", () => {
  // A settled tool block is ["", row]: the blank is a separator between the
  // assistant text and the tool row, and both are addressable rows.
  const items = [say("done"), call("z"), result("z")];
  const rows = assertWindowsAgree({ items }, 4);
  assert.deepEqual(plain(rows), ["", " done", "", "  • Read     z.ts"]);
});

test("every window equals the row-by-row transcript for a long history", () => {
  // 6 turns x (blank + user + blank + blank + assistant + blank + tool row).
  assertWindowsAgree({ items: sequential(6) }, 42);
});

test("64-way separated calls and results keep window equivalence", () => {
  const items = separated(64);
  // Each of the 64 calls pairs with a result, so only the calls render, and
  // each renders as a [blank, row] block.
  const rows = assertWindowsAgree({ items }, 128);
  const text = plain(rows).join("\n");
  assert.match(text, /• Read {5}p0\.ts/);
  assert.doesNotMatch(text, /Reading/, "a paired call must not stay pending");
});

test("a late result repaginates without leaving stale offsets", () => {
  const items = [ask("go"), call("late")];
  const renderer = new AgentTranscriptRenderer();
  const pending = frame({ items }, renderer);
  assert.match(plain(pending.rows(0, pending.rowCount)).join("\n"), /Reading/);

  // The manager appends in place, so the items array keeps its identity.
  items.push(result("late"));
  const settled = frame({ items }, renderer);
  assert.equal(settled.rowCount, 5);
  assert.deepEqual(plain(settled.rows(0, settled.rowCount)), [
    "",
    " go",
    "",
    "",
    "  • Read     late.ts",
  ]);
});

test("legacy items with no matching call id keep their rows", () => {
  // Workflow history predating call ids: orphan results must still render, and
  // a result with no args preview falls back to the bare relative path.
  const items = [ask("go"), result("orphan-1"), result("orphan-2")];
  const rows = assertWindowsAgree({ items }, 7);
  assert.deepEqual(plain(rows), [
    "",
    " go",
    "",
    "",
    "  • Read     .",
    "",
    "  • Read     .",
  ]);
});

test("front trimming from compaction shifts every window", () => {
  const items = sequential(8);
  const renderer = new AgentTranscriptRenderer();
  const before = frame({ items }, renderer);
  assert.equal(before.rowCount, 56);
  const tailBefore = before.rows(before.rowCount - 4, 4);

  // MAX_TRANSCRIPT_ITEMS trimming splices the front in place: the array
  // identity survives while every cached offset shifts. Replace the trimmed
  // items with the same COUNT of taller ones, so length alone cannot reveal
  // the change and a layout that trusts its cache keeps the old offsets.
  items.splice(0, 4, ask("replaced\n\nwith\n\nmore rows"));
  items.splice(1, 0, say("a"), say("b"), say("c"));
  const after = frame({ items }, renderer);
  assert.equal(items.length, 32, "item count is unchanged by design");
  assert.equal(after.rowCount, 62, "taller replacement must repaginate");
  assert.deepEqual(
    after.rows(after.rowCount - 4, 4),
    tailBefore,
    "surviving tail rows must be unchanged",
  );
  assert.deepEqual(plain(after.rows(0, 3)), ["", " replaced", ""]);
});

test("a live call renders in the tail, not twice", () => {
  const items = [call("live-1")];
  const live = frame({
    items,
    liveTools: [
      {
        toolId: "live-1",
        name: "read",
        argsPreview: JSON.stringify({ path: "live-1.ts" }),
      },
    ],
  });
  const rows = plain(live.rows(0, live.rowCount));
  assert.equal(live.rowCount, 2, "the live block replaces the call's rows");
  assert.equal(
    rows.filter((row) => row.includes("live-1.ts")).length,
    1,
    "a live call must not appear in both the items block and the tail",
  );
  assert.match(rows.join("\n"), /Reading/);
});

test("streaming native tool output repaginates its own rows", () => {
  const toolRenderer = new AgentToolRenderLedger();
  // bash output grows the native block, so a stale height shifts every row
  // after it rather than only recolouring in place.
  const items = [say("running"), bash("n1", "ls"), say("after the tool")];
  const document = { items, toolRenderer } satisfies AgentTranscriptDocument;
  const renderer = new AgentTranscriptRenderer();

  toolRenderer.start("n1", "bash", { command: "ls" });
  const pending = frame(document, renderer);
  assert.equal(pending.rowCount, 8);
  const pendingRows = pending.rows(0, pending.rowCount);
  const trailing = plain(pendingRows).at(-1);
  assert.equal(trailing, " after the tool");

  toolRenderer.end(
    "n1",
    "bash",
    { content: [{ type: "text", text: "a\nb\nc\nd\ne\nf" }] },
    false,
  );
  const settled = frame(document, renderer);
  assert.ok(
    settled.rowCount > pending.rowCount,
    `settled native output must add rows, got ${settled.rowCount}`,
  );
  const settledRows = plain(settled.rows(0, settled.rowCount));
  assert.deepEqual(
    settledRows.slice(0, 2),
    ["", " running"],
    "rows before the tool must not move",
  );
  assert.equal(
    settledRows.at(-1),
    " after the tool",
    "the item after the tool must still be the last row",
  );
  // The grown output must be reachable by window, not just counted.
  assert.match(settledRows.join("\n"), /\bf\b/);
});

test("queued and live tail rows are addressable by window", () => {
  const items = [say("body")];
  const document = {
    items,
    liveAssistant: { text: "thinking out loud", thinking: "" },
    liveTools: [
      { toolId: "tail-1", name: "bash", argsPreview: '{"command":"ls"}' },
    ],
    queued: [{ text: "next please", kind: "follow-up" as const }],
  } satisfies AgentTranscriptDocument;
  const rows = assertWindowsAgree(document, 8);
  assert.deepEqual(plain(rows), [
    "",
    " body",
    "",
    " thinking out loud",
    "",
    "  ⠋ Running  ls",
    "",
    " Follow-up: next please",
  ]);
});

test("cwd participates in the cache key", () => {
  // Absolute paths are relativized against cwd, so the same item renders
  // differently per child. A key without cwd would serve one child's row to
  // another. Reuse ONE renderer so a stale key would surface.
  const items = [
    {
      kind: "assistant" as const,
      parts: [
        {
          type: "toolCall",
          toolId: "c1",
          name: "read",
          argsPreview: JSON.stringify({ path: "D:/works/openpi/deep/file.ts" }),
        } as never,
      ],
    },
  ];
  const renderer = new AgentTranscriptRenderer();
  const inRepo = frame({ items, cwd: "D:/works/openpi" }, renderer);
  const inRepoRows = plain(inRepo.rows(0, inRepo.rowCount)).join("\n");
  const outside = frame({ items, cwd: "C:/other" }, renderer);
  const outsideRows = plain(outside.rows(0, outside.rowCount)).join("\n");

  assert.notEqual(inRepoRows, outsideRows, "cwd must change the rendered path");
  const cold = frame({ items, cwd: "C:/other" });
  assert.equal(
    outsideRows,
    plain(cold.rows(0, cold.rowCount)).join("\n"),
    "a warm cache must not serve another cwd's row",
  );
});

test("tool expansion participates in the cache key", () => {
  // The native ledger reports revisions, so tool items are cacheable; the key
  // must still separate collapsed from expanded evidence.
  const toolRenderer = new AgentToolRenderLedger();
  toolRenderer.start("t1", "bash", { command: "ls" });
  toolRenderer.end(
    "t1",
    "bash",
    { content: [{ type: "text", text: "a\nb\nc\nd\ne\nf" }] },
    false,
  );
  const document = {
    items: [bash("t1", "ls")],
    toolRenderer,
  } satisfies AgentTranscriptDocument;
  const renderer = new AgentTranscriptRenderer();

  const collapsed = renderer.beginFrame(document, 60, theme, {
    now: 0,
    expanded: false,
  });
  const collapsedRows = plain(collapsed.rows(0, collapsed.rowCount)).join("\n");
  const expanded = renderer.beginFrame(document, 60, theme, {
    now: 0,
    expanded: true,
  });
  const expandedRows = plain(expanded.rows(0, expanded.rowCount)).join("\n");

  assert.match(collapsedRows, /earlier lines/, "collapsed elides output");
  assert.doesNotMatch(expandedRows, /earlier lines/, "expanded shows output");
  const cold = new AgentTranscriptRenderer().beginFrame(document, 60, theme, {
    now: 0,
    expanded: true,
  });
  assert.equal(
    expandedRows,
    plain(cold.rows(0, cold.rowCount)).join("\n"),
    "a warm collapsed cache must not survive into the expanded view",
  );
});

test("a same-length in-place replacement republishes the row total", () => {
  // Endpoint checks catch appends and front trimming, but replacing a middle
  // item keeps the length and both endpoints. rowCount is published before any
  // slice is cut, so a layout that trusts its endpoints reports a stale total
  // and the operator loses the rows past the replacement for one frame.
  const items = [ask("a"), say("b"), say("c")];
  const renderer = new AgentTranscriptRenderer();
  const before = frame({ items }, renderer);
  assert.equal(before.rowCount, 7);
  before.rows(0, before.rowCount);

  items[1] = say("b1\n\nb2\n\nb3\n\nb4");
  const after = frame({ items }, renderer);
  const cold = frame({ items });
  assert.equal(
    after.rowCount,
    cold.rowCount,
    "the row total must reflect the replacement in the same frame",
  );
  assert.deepEqual(
    after.rows(0, after.rowCount),
    cold.rows(0, cold.rowCount),
    "every row must match a cold render of the replaced document",
  );
  assert.equal(plain(after.rows(after.rowCount - 1, 1))[0], " c");
});

test("a renderer without revisions republishes the row total every frame", () => {
  // revision() is optional on AgentToolRenderer. Without it the native output
  // can change with no cache-key movement at all, so those heights must be
  // re-measured before the row total is published.
  let tall = false;
  const legacy = {
    renderTool: () => (tall ? ["n1", "n2", "n3", "n4"] : ["n1"]),
  };
  const items = [say("head"), call("t1"), say("tail")];
  const document = {
    items,
    toolRenderer: legacy,
  } satisfies AgentTranscriptDocument;
  const renderer = new AgentTranscriptRenderer();

  const short = frame(document, renderer);
  assert.equal(short.rowCount, 5);
  assert.deepEqual(plain(short.rows(0, short.rowCount)).at(-1), " tail");

  tall = true;
  const grown = frame(document, renderer);
  const cold = frame(document);
  assert.equal(
    grown.rowCount,
    cold.rowCount,
    "the row total must follow unrevisioned native output in the same frame",
  );
  assert.deepEqual(
    grown.rows(0, grown.rowCount),
    cold.rows(0, cold.rowCount),
    "every row must match a cold render",
  );
  assert.deepEqual(
    plain(grown.rows(0, grown.rowCount)).at(-1),
    " tail",
    "the item after the tool must not fall off the end",
  );
});

test("a rebuilt pairing index invalidates the cached layout", () => {
  // Production documents carry a pairing index that their producer rebuilds on
  // every transcript mutation, so layout reuse keys on its identity instead of
  // walking the items. A mutation that keeps the length and both endpoints must
  // still repaginate once the index is rebuilt.
  const items = [ask("a"), say("b"), say("c")];
  const renderer = new AgentTranscriptRenderer();
  const before = frame({ items, pairing: buildPairingIndex(items) }, renderer);
  assert.equal(before.rowCount, 7);
  before.rows(0, before.rowCount);

  items[1] = say("b1\n\nb2\n\nb3\n\nb4");
  const document = { items, pairing: buildPairingIndex(items) };
  const after = frame(document, renderer);
  const cold = frame(document);
  assert.equal(
    after.rowCount,
    cold.rowCount,
    "a rebuilt index must not reuse the previous layout",
  );
  assert.deepEqual(after.rows(0, after.rowCount), cold.rows(0, cold.rowCount));
  assert.equal(plain(after.rows(after.rowCount - 1, 1))[0], " c");
});

test("invalidate() drops cached rows and heights", () => {
  const items = sequential(4);
  const renderer = new AgentTranscriptRenderer();
  const before = frame({ items }, renderer);
  const beforeRows = before.rows(0, before.rowCount);
  renderer.invalidate();
  const after = frame({ items }, renderer);
  assert.equal(after.rowCount, before.rowCount);
  assert.deepEqual(after.rows(0, after.rowCount), beforeRows);
});
