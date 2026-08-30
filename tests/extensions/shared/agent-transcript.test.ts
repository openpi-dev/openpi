import assert from "node:assert/strict";
import test from "node:test";

import { AgentTranscriptRenderer } from "../../../extensions/shared/agent-transcript.ts";
import type {
  AgentTranscriptDocument,
  AgentTranscriptItem,
} from "../../../extensions/shared/agent-transcript.ts";

/**
 * Baseline tests for the #185 pairing-scan refactor.
 *
 * Written against the UNMODIFIED implementation first and confirmed green
 * there, then re-run after the refactor. They describe current observable
 * behaviour, not desired new behaviour.
 *
 * Observable signals (established by probing the renderer):
 *   - `renderToolResultItem` returns [] when `paired === true`, so a paired
 *     toolResult adds no rows; pairing shows up as a row-count difference.
 *   - A toolCall phase shows up as a verb: completed -> "Read",
 *     pending -> "Reading" (spinner), errored -> "Failed".
 *
 * `itemContext` / `hasEarlierToolCall` / `findResult` are module-private, so
 * these assert indirectly through `AgentTranscriptRenderer.render`. That is
 * also why the refactor must keep output identical: the public surface does
 * not expose pairing itself.
 *
 * Mutation-checked (measured): changing `findResult` start from
 * `callIndex + 1` to `0`, or flipping `hasEarlierToolCall` to a full forward
 * scan, fails the out-of-order and duplicate-tool-id cases below. The suite
 * is not vacuously green.
 */
/** Minimal Theme stub: identity color fns so assertions see structure only. */
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
      argsPreview: toolId,
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

/** Fresh renderer per call so itemCache never leaks between cases. */
const render = (items: AgentTranscriptItem[], width = 60) =>
  new AgentTranscriptRenderer().render(
    { items } satisfies AgentTranscriptDocument,
    width,
    theme,
  );

const joined = (items: AgentTranscriptItem[]) => render(items).join("\n");

/** Completed verb, distinct from the pending "Reading". */
const COMPLETED = /Read(?!ing)/;

test("a paired toolResult is suppressed and adds no rows", () => {
  const withPair = render([call("a"), result("a")]);
  const callOnly = render([call("a")]);

  // Paired results return [], so total rows match the call-only case.
  assert.equal(
    withPair.length,
    callOnly.length,
    "paired result must not add rows",
  );
  // And the call renders as completed, not pending.
  assert.match(joined([call("a"), result("a")]), COMPLETED);
  assert.doesNotMatch(joined([call("a"), result("a")]), /Reading/);
});

test("an orphan toolResult (no earlier toolCall) still renders", () => {
  const orphan = render([result("zzz")]);
  assert.ok(orphan.length > 0, "orphan result must render");
  assert.match(orphan.join("\n"), COMPLETED);
});

test("a lone toolCall renders as pending", () => {
  assert.match(joined([call("b")]), /Reading/);
});

test("out-of-order: a result before its call is not paired, both render", () => {
  // hasEarlierToolCall scans backwards only: no call precedes this result,
  // so paired=false. findResult scans forwards only: no result follows this
  // call, so it stays pending.
  const out = joined([result("c"), call("c")]);
  assert.match(out, COMPLETED, "unpaired result still renders");
  assert.match(out, /Reading/, "later call stays pending");
});

test("an errored paired result renders differently from an ok one", () => {
  const ok = joined([call("d"), result("d", false)]);
  const bad = joined([call("e"), result("e", true)]);
  assert.notEqual(ok, bad, "error phase must differ from ok phase");
});

test("a duplicated toolId pairs with the result AFTER the call, not the global first", () => {
  // The edge case index implementations get wrong: findResult wants the
  // first result AFTER callIndex, not the global first. This input puts an
  // error result before the call and an ok result after it:
  //   correct -> the call pairs with the ok result after it
  //   global-first -> it would pair with the error before it.
  // A Map<toolId, single index> would fail here.
  const out = joined([result("dup", true), call("dup"), result("dup", false)]);

  // The leading orphan error result still renders (no call before it).
  assert.match(out, /Failed/, "leading orphan error result still renders");
  // Key assertion: the call takes the result AFTER it, not the error before.
  assert.match(out, COMPLETED, "call must pair with the result AFTER it");
  assert.doesNotMatch(out, /Reading/, "call must not stay pending");
});

test("a live toolId overrides result lookup with the live phase", () => {
  const items = [call("f"), result("f")];
  const live = new AgentTranscriptRenderer().render(
    {
      items,
      liveTools: [{ toolId: "f", name: "read" }],
    } satisfies AgentTranscriptDocument,
    60,
    theme,
  );
  const settled = render(items);
  assert.notEqual(
    live.join("\n"),
    settled.join("\n"),
    "live phase must differ from settled phase",
  );
});

test("neighbour changes alter output (context.token participates in the cache key)", () => {
  // The same item object must render differently in two neighbour contexts;
  // otherwise the cache key lacks context and the refactor would serve stale
  // glyphs.
  const shared = call("g");
  const renderer = new AgentTranscriptRenderer();

  const pending = renderer
    .render({ items: [shared] } satisfies AgentTranscriptDocument, 60, theme)
    .join("\n");
  const completed = renderer
    .render(
      { items: [shared, result("g")] } satisfies AgentTranscriptDocument,
      60,
      theme,
    )
    .join("\n");

  assert.match(pending, /Reading/);
  assert.match(completed, COMPLETED);
  assert.notEqual(pending, completed, "cache must not serve a stale phase");
});
