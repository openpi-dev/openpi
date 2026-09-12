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

// Synthetic normalized Usage vectors, not captured provider responses.
for (const [provider, semantics] of [
  ["azure-openai-responses", "implicit-best-effort"],
  ["google", "implicit-best-effort"],
  ["google-antigravity", "implicit-best-effort"],
  ["google-gemini-cli", "implicit-best-effort"],
  ["openai", "implicit-best-effort"],
  ["openai-codex", "implicit-best-effort"],
  ["openai-responses", "implicit-best-effort"],
  ["amazon-bedrock", "unknown"],
  ["google-vertex", "unknown"],
  ["openrouter", "unknown"],
  ["custom-provider", "unknown"],
] as const) {
  test(`${provider} synthetic warm/cold replay never claims an explicit-prefix miss`, () => {
    const tracker = createCacheDiagnosticsTracker();
    const observations = [4_096, 0, 0, 4_096, 2_048, 0].map(
      (cacheRead, turnIndex) =>
        tracker.observe({
          turnIndex,
          identity: { ...identity, provider },
          usage: usage({ input: 100, cacheRead, cacheWrite: 500 }),
        }),
    );

    assert.deepEqual(
      observations.map((observation) => observation.kind),
      ["first-turn", "unknown", "cold", "warm", "partial-hit", "unknown"],
    );
    for (const observation of observations) {
      assert.equal(observation.semantics, semantics);
      assert.equal(observation.reprocessedTokens, null);
      assert.equal(observation.verifiedCause, null);
      assert.equal(observation.evidence, "observation");
    }
  });
}

test("the explicit-prefix warm threshold includes exactly 2048 reported read tokens", () => {
  for (const [previousCacheRead, kind] of [
    [2_047, "cold"],
    [2_048, "miss-after-warm-prefix"],
  ] as const) {
    const tracker = createCacheDiagnosticsTracker();
    tracker.observe({
      turnIndex: 0,
      identity,
      usage: usage({ cacheRead: previousCacheRead }),
    });
    const observation = tracker.observe({
      turnIndex: 1,
      identity,
      usage: usage({ input: 100, cacheWrite: 3_000 }),
    });

    assert.equal(observation.kind, kind);
    assert.equal(observation.usage.promptTokens, 3_100);
    assert.equal(observation.reprocessedTokens, kind === "cold" ? null : 100);
  }
});

test("prompt accounting excludes output, reasoning, write subsets, totals and cost", () => {
  const reported = usage({
    input: 100,
    cacheRead: 2_000,
    cacheWrite: 500,
    cacheWrite1h: 300,
    output: 90,
    reasoning: 40,
    totalTokens: 2_690,
    cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
  });
  const before = structuredClone(reported);
  const observation = createCacheDiagnosticsTracker().observe({
    turnIndex: 0,
    identity,
    usage: reported,
  });

  assert.deepEqual(observation.usage, {
    input: 100,
    cacheRead: 2_000,
    cacheWrite: 500,
    promptTokens: 2_600,
  });
  assert.deepEqual(reported, before);
});

test("non-finite and negative prompt counters cannot establish a warm baseline", () => {
  for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    const tracker = createCacheDiagnosticsTracker();
    const first = tracker.observe({
      turnIndex: 0,
      identity,
      usage: usage({ input: invalid, cacheRead: invalid, cacheWrite: invalid }),
    });
    assert.deepEqual(first.usage, {
      input: 0,
      cacheRead: 0,
      cacheWrite: 0,
      promptTokens: 0,
    });
    assert.equal(
      tracker.observe({ turnIndex: 1, identity, usage: usage({ input: 100 }) })
        .kind,
      "cold",
    );
  }
});
