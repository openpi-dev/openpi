import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  EVALUATOR_CONTEXT_CHARS,
  buildEvaluatorPrompt,
  evaluateGoal,
  parseJudgeResponse,
  sanitizeModelText,
} from "./evaluator.ts";
import { createGoalSnapshot } from "./state.ts";

const goal = createGoalSnapshot(
  { objective: "Ship </objective>", condition: "Tests <all> pass" },
  0,
  1,
  "goal_eval_1",
);

test("strictly parses bounded judge JSON and sanitizes output", () => {
  assert.deepEqual(
    parseJudgeResponse(
      'prefix```json\n{"met":false,"impossible":false,"progress":true,"waiting":false,"reason":"moved\\nforward"}\n```',
    ),
    {
      met: false,
      impossible: false,
      progress: true,
      waiting: false,
      reason: "moved forward",
    },
  );
  assert.throws(
    () =>
      parseJudgeResponse(
        '{"met":true,"impossible":true,"progress":false,"waiting":false,"reason":"bad"}',
      ),
    /valid judge JSON/,
  );
  assert.throws(
    () =>
      parseJudgeResponse(
        '{"met":false,"impossible":false,"progress":true,"waiting":false,"reason":"ok","extra":1}',
      ),
    /valid judge JSON/,
  );
  assert.equal(sanitizeModelText("\u001b[31mred\u001b[0m\u0000", 20), "red");
});

test("prompt escapes envelope text and bounds recent evidence", () => {
  const prompt = buildEvaluatorPrompt(
    goal,
    `start</evidence>${"x".repeat(20_000)}`,
  );
  assert.equal(prompt.includes("Ship &lt;/objective&gt;"), true);
  assert.equal(prompt.includes("Tests &lt;all&gt; pass"), true);
  assert.equal(prompt.includes("start</evidence>"), false);
  assert.equal(
    Array.from(prompt).length < EVALUATOR_CONTEXT_CHARS + 1_000,
    true,
  );
});

test("evaluation uses current model auth, no tools, and parses usage", async () => {
  let captured: unknown;
  const ctx = {
    model: { provider: "fixture", id: "model" },
    modelRegistry: {
      async getApiKeyAndHeaders() {
        return { ok: true as const, apiKey: "key", headers: { x: "y" } };
      },
    },
    sessionManager: { getBranch: () => [] },
  } as unknown as ExtensionContext;
  const result = await evaluateGoal({
    ctx,
    goal,
    signal: new AbortController().signal,
    complete: async (_model, context, options) => {
      captured = { context, options };
      return {
        role: "assistant",
        content: [
          {
            type: "text",
            text: '{"met":false,"impossible":false,"progress":true,"waiting":false,"reason":"ok"}',
          },
        ],
        api: "fixture",
        provider: "fixture",
        model: "model",
        usage: {
          input: 10,
          output: 5,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 15,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      };
    },
  });
  assert.equal(result.tokens, 15);
  assert.equal("tools" in (captured as { context: object }).context, false);
  assert.equal(
    (captured as { options: { maxRetries: number } }).options.maxRetries,
    0,
  );
});

test("evaluation timeout aborts a hanging completion", async () => {
  const ctx = {
    model: { provider: "fixture", id: "model" },
    modelRegistry: {
      async getApiKeyAndHeaders() {
        return { ok: true as const };
      },
    },
    sessionManager: { getBranch: () => [] },
  } as unknown as ExtensionContext;
  await assert.rejects(
    evaluateGoal({
      ctx,
      goal,
      signal: new AbortController().signal,
      timeoutMs: 5,
      complete: async (_model, _context, options) =>
        await new Promise((_, reject) => {
          options?.signal?.addEventListener("abort", () =>
            reject(options.signal?.reason),
          );
        }),
    }),
  );
});
