import assert from "node:assert/strict";
import test from "node:test";
import type { Usage } from "@earendil-works/pi-ai";
import {
  cacheSemanticsForProvider,
  createCacheDiagnosticsTracker,
  fingerprintCacheSurface,
  type CacheTurnIdentity,
} from "../../../extensions/model-info/cache-diagnostics.ts";

const identity: CacheTurnIdentity = {
  provider: "anthropic",
  modelId: "claude-test",
  thinking: "high",
  toolSurfaceFingerprint: fingerprintCacheSurface(["read"]),
  systemPromptFingerprint: fingerprintCacheSurface("prompt"),
};

function usage(overrides: Partial<Usage>): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
    ...overrides,
  };
}

test("classifies provider cache contracts conservatively", () => {
  assert.equal(cacheSemanticsForProvider("anthropic"), "explicit-prefix");
  assert.equal(cacheSemanticsForProvider("openai"), "implicit-best-effort");
  assert.equal(cacheSemanticsForProvider("google"), "implicit-best-effort");
  assert.equal(cacheSemanticsForProvider("custom"), "unknown");
});

test("first and consecutive cold turns do not create an invalidation", () => {
  const tracker = createCacheDiagnosticsTracker();
  const first = tracker.observe({
    turnIndex: 0,
    identity,
    usage: usage({ input: 500 }),
  });
  const second = tracker.observe({
    turnIndex: 1,
    identity,
    usage: usage({ input: 700 }),
  });

  assert.equal(first.kind, "first-turn");
  assert.equal(second.kind, "cold");
  assert.equal(second.reprocessedTokens, null);
  assert.equal(second.verifiedCause, null);
});

test("explicit warm to cold reports reprocessed tokens without inventing a cause", () => {
  const tracker = createCacheDiagnosticsTracker();
  tracker.observe({
    turnIndex: 0,
    identity,
    usage: usage({ cacheRead: 4_096 }),
  });
  tracker.mark("compaction");
  const observation = tracker.observe({
    turnIndex: 1,
    identity: {
      ...identity,
      systemPromptFingerprint: fingerprintCacheSurface("changed"),
    },
    usage: usage({ input: 4_400 }),
  });

  assert.equal(observation.kind, "miss-after-warm-prefix");
  assert.equal(observation.reprocessedTokens, 4_400);
  assert.deepEqual(observation.correlations, [
    "system-prompt-change",
    "compaction",
  ]);
  assert.equal(observation.evidence, "observation");
  assert.equal(observation.verifiedCause, null);
});

test("implicit and unknown providers keep warm-to-cold transitions unknown", () => {
  for (const provider of ["openai", "custom-provider"]) {
    const tracker = createCacheDiagnosticsTracker();
    const current = { ...identity, provider };
    tracker.observe({
      turnIndex: 0,
      identity: current,
      usage: usage({ cacheRead: 3_000 }),
    });
    const observation = tracker.observe({
      turnIndex: 1,
      identity: current,
      usage: usage({ input: 3_200 }),
    });
    assert.equal(observation.kind, "unknown");
    assert.equal(observation.reprocessedTokens, null);
  }
});

test("partial hits and local identity changes are reported separately", () => {
  const tracker = createCacheDiagnosticsTracker();
  tracker.observe({
    turnIndex: 0,
    identity,
    usage: usage({ cacheRead: 6_000 }),
  });
  const observation = tracker.observe({
    turnIndex: 1,
    identity: {
      ...identity,
      modelId: "claude-next",
      thinking: "low",
      toolSurfaceFingerprint: fingerprintCacheSurface(["read", "bash"]),
    },
    usage: usage({ cacheRead: 2_500 }),
  });

  assert.equal(observation.kind, "partial-hit");
  assert.deepEqual(observation.correlations, [
    "model-change",
    "thinking-change",
    "tool-surface-change",
  ]);
});

test("reset removes the prior warm baseline and pending correlations", () => {
  const tracker = createCacheDiagnosticsTracker();
  tracker.observe({
    turnIndex: 0,
    identity,
    usage: usage({ cacheRead: 4_000 }),
  });
  tracker.mark("branch-change");
  tracker.reset();
  const observation = tracker.observe({
    turnIndex: 0,
    identity,
    usage: usage({ input: 4_000 }),
  });

  assert.equal(observation.kind, "first-turn");
  assert.deepEqual(observation.correlations, []);
});
