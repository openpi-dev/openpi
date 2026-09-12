import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";

import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
  AgentTranscriptRenderer,
  buildPairingIndex,
  type AgentTranscriptDocument,
  type AgentTranscriptItem,
} from "../../../extensions/shared/agent-transcript.ts";

initTheme("dark", false);

/**
 * Regression cover for the tool-call/tool-result pairing lookup (#185).
 *
 * `findResult` binary searches the ascending result indices for a tool id. The
 * cases that a wrong search boundary gets wrong are: a result BEFORE its call
 * (must not pair), duplicate ids where the correct match is the first result
 * AFTER the call rather than the globally first one, and a wide fan of parallel
 * calls whose results all arrive later.
 *
 */
const theme = new Proxy(
  {},
  {
    get: (_target, prop) =>
      prop === "fg"
        ? (_color: string, text: string) => text
        : (text: string) => text,
  },
) as Theme;

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

const result = (toolId: string, isError = false): AgentTranscriptItem => ({
  kind: "toolResult",
  toolId,
  name: "read",
  isError,
  outputPreview: `out-${toolId}`,
});

/** Strip colour and the Nerd Font icons so assertions read as structure. */
const plain = (rows: ReadonlyArray<string>) =>
  rows
    .map((row) =>
      stripVTControlCharacters(row)
        .replace(/[\uE000-\uF8FF]/g, "•")
        .trimEnd(),
    )
    .join("\n");

/** Render with the pairing index the production document producers supply. */
function render(items: AgentTranscriptItem[], width = 60) {
  const document = {
    items,
    pairing: buildPairingIndex(items),
  } satisfies AgentTranscriptDocument;
  const renderer = new AgentTranscriptRenderer();
  return plain(renderer.render(document, width, theme, { now: 0 }));
}

test("a call pairs with the first result after it, not the globally first", () => {
  // The edge case a wrong search boundary gets wrong: an error result for the
  // same id lands BEFORE the call, and the real result lands after.
  const out = render([result("dup", true), call("dup"), result("dup", false)]);

  assert.match(out, /Failed/, "the leading orphan error result still renders");
  assert.match(out, /Read(?!ing)/, "the call pairs with the result after it");
  assert.doesNotMatch(out, /Reading/, "the call must not stay pending");
});

test("a result before its call is not paired; both still render", () => {
  const out = render([result("c"), call("c")]);
  assert.match(out, /Read(?!ing)/, "the unpaired result renders");
  assert.match(out, /Reading/, "the later call stays pending");
});

test("many results for one id pick the nearest one after each call", () => {
  // Several calls and results interleave for a single tool id, so each call
  // must land on its own nearest following result.
  const items: AgentTranscriptItem[] = [];
  for (let round = 0; round < 8; round++) {
    items.push(call("shared"));
    items.push(result("shared", round % 2 === 1));
  }
  const out = render(items);
  // Every call is paired, so no call renders as pending and each result is
  // suppressed in favour of its call's settled row.
  assert.doesNotMatch(out, /Reading/, "no call may stay pending");
  assert.equal(
    out.split("\n").filter((row) => /Read(?!ing)|Failed/.test(row)).length,
    8,
    "each of the 8 calls contributes exactly one settled row",
  );
});

test("64 parallel calls followed by 64 results all pair correctly", () => {
  // The shape #185 names: a full fan of calls, then every result. Each call
  // must find its own result rather than the first one in the array.
  const FAN = 64;
  const items: AgentTranscriptItem[] = [];
  for (let index = 0; index < FAN; index++) items.push(call(`p${index}`));
  for (let index = 0; index < FAN; index++) {
    items.push(result(`p${index}`, index === 7));
  }
  const out = render(items);

  assert.doesNotMatch(out, /Reading/, "every call must be paired");
  assert.equal(
    out.split("\n").filter((row) => /Read(?!ing)/.test(row)).length,
    FAN - 1,
    "63 calls settle as successful reads",
  );
  assert.equal(
    out.split("\n").filter((row) => /Failed/.test(row)).length,
    1,
    "the one errored result settles its own call, not another",
  );
  assert.match(out, /• Read {5}p0\.ts/, "the first call keeps its own args");
  assert.match(out, /p63\.ts/, "the last call keeps its own args");
});

test("an errored result settles its own call and no other", () => {
  const out = render([
    call("ok1"),
    call("bad"),
    call("ok2"),
    result("ok1", false),
    result("bad", true),
    result("ok2", false),
  ]);
  assert.equal(
    out.split("\n").filter((row) => /Failed/.test(row)).length,
    1,
    "exactly one call renders as failed",
  );
  assert.match(out, /Failed.*bad\.ts/, "the failed row belongs to bad");
});

test("a long per-id result index still pairs each call with its own result", () => {
  // The lookup accepts repeated IDs in transcript documents. Exercise that
  // supported input directly without depending on a provider or adapter to
  // generate it, and ensure pairing work stays bounded as its index grows.
  const ROUNDS = 40;
  const items: AgentTranscriptItem[] = [];
  for (let round = 0; round < ROUNDS; round++) {
    items.push(call("retry"));
    items.push(result("retry", round === ROUNDS - 1));
  }
  const index = buildPairingIndex(items);
  assert.equal(
    index.resultsById.get("retry")?.length,
    ROUNDS,
    "the fixture must actually build a long per-id index",
  );

  let reads = 0;
  const indices = index.resultsById.get("retry")!;
  const counted = new Proxy(indices, {
    get(target, property, receiver) {
      if (typeof property === "string" && /^\d+$/.test(property)) reads++;
      return Reflect.get(target, property, receiver);
    },
  });
  const out = plain(
    new AgentTranscriptRenderer().render(
      {
        items,
        pairing: { ...index, resultsById: new Map([["retry", counted]]) },
      },
      60,
      theme,
      { now: 0 },
    ),
  );
  assert.ok(
    reads <= ROUNDS * (Math.ceil(Math.log2(ROUNDS)) + 1),
    `result lookup must stay logarithmic per call, observed ${reads} reads`,
  );
  assert.doesNotMatch(out, /Reading/, "every call must find a result");
  assert.equal(
    out.split("\n").filter((row) => /Failed/.test(row)).length,
    1,
    "only the final call pairs with the errored result",
  );
  assert.equal(
    out.split("\n").filter((row) => /• Read(?!ing)/.test(row)).length,
    ROUNDS - 1,
    "the other calls pair with their own successful results",
  );
});

test("a call with no result stays pending while its neighbours settle", () => {
  const out = render([
    call("done"),
    result("done"),
    call("pending"),
    call("later"),
    result("later"),
  ]);
  assert.match(
    out,
    /Reading {2}pending\.ts/,
    "the unmatched call stays pending",
  );
  assert.match(out, /• Read {5}done\.ts/, "the matched call settles");
  assert.match(out, /• Read {5}later\.ts/, "a call after the gap still pairs");
});
