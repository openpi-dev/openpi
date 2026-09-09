import assert from "node:assert/strict";
import test from "node:test";
import { getAntigravityUserAgent } from "../../../extensions/ai-providers/antigravity/oauth.ts";
import {
  cursorAdapter,
  extractCursorUserId,
} from "../../../extensions/usage/providers/cursor.ts";
import { googleAntigravityAdapter } from "../../../extensions/usage/providers/google-antigravity.ts";
import { openaiCodexAdapter } from "../../../extensions/usage/providers/openai-codex.ts";
import { DEFAULT_ADAPTERS } from "../../../extensions/usage/providers/registry.ts";
import {
  computeUsageStatus,
  parseTimestamp,
} from "../../../extensions/usage/providers/utils.ts";

function jwt(payload: Record<string, unknown>) {
  return `e30.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;
}
const cursorToken = jwt({ sub: "auth0|cursor-user" });
const antiAuth = {
  apiKey: JSON.stringify({ token: "fake-antigravity", projectId: "project-a" }),
};

function payloadFetch(payload: unknown): typeof fetch {
  return async () => Response.json(payload);
}

test("Cursor uses its session cookie, authoritative percentages and independent account metadata", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const report = await cursorAdapter.fetchUsage(
    { apiKey: cursorToken },
    {
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        if (String(url).endsWith("auth/me"))
          return new Response("private invalid response");
        return Response.json({
          individualUsage: {
            plan: {
              used: 1504,
              limit: 7000,
              autoPercentUsed: 12.5,
              apiPercentUsed: 45,
            },
            onDemand: { used: 250, limit: 2000 },
          },
          billingCycleEnd: 1788973200,
        });
      },
    },
  );
  assert.deepEqual(
    calls.map((call) => call.url),
    ["https://cursor.com/api/usage-summary", "https://cursor.com/api/auth/me"],
  );
  for (const call of calls) {
    assert.equal(
      new Headers(call.init?.headers).get("Cookie"),
      `WorkosCursorSessionToken=${encodeURIComponent(`cursor-user::${cursorToken}`)}`,
    );
    assert.equal(call.init?.redirect, "error");
    assert.ok(call.init?.signal);
  }
  assert.equal(report.error, undefined);
  assert.deepEqual(
    report.meters.map((m) => m.usedPercent),
    [12.5, 45, 12.5],
  );
  assert.equal(report.meters[2].usedText, "$2.50");
  assert.equal(report.meters[2].limitText, "$20.00");
  assert.equal(report.meters[0].resetsAt, 1788973200000);
  assert.equal(extractCursorUserId(cursorToken), "cursor-user");
  assert.equal(extractCursorUserId("invalid"), undefined);
});

test("Cursor retains on-demand spending with no denominator and never invents a percentage", async () => {
  const report = await cursorAdapter.fetchUsage(
    { apiKey: cursorToken },
    {
      fetch: payloadFetch({
        individualUsage: { onDemand: { used: 350, limit: null } },
      }),
    },
  );
  assert.equal(report.meters[0].usedText, "$3.50");
  assert.equal(report.meters[0].usedPercent, undefined);
  assert.equal(report.meters[0].status, "unknown");
});

test("Antigravity reuses resolved token/project, preserves groups and retries a transient endpoint", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const report = await googleAntigravityAdapter.fetchUsage(antiAuth, {
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      if (calls.length === 1) return new Response("failed", { status: 503 });
      return Response.json({
        groups: [
          {
            displayName: "Gemini Models",
            buckets: [
              { bucketId: "gemini-5h", window: "5h", remainingFraction: 0.4 },
            ],
          },
          {
            displayName: "Claude and GPT models",
            buckets: [
              {
                bucketId: "3p-weekly",
                window: "weekly",
                remainingFraction: 0.1,
              },
            ],
          },
        ],
      });
    },
  });
  assert.deepEqual(
    calls.map((call) => call.url),
    [
      "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
      "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
    ],
  );
  for (const { init } of calls) {
    assert.equal(init?.method, "POST");
    assert.equal(
      new Headers(init?.headers).get("User-Agent"),
      getAntigravityUserAgent(),
    );
    assert.equal(
      new Headers(init?.headers).get("Authorization"),
      "Bearer fake-antigravity",
    );
    assert.equal(init?.body, JSON.stringify({ project: "project-a" }));
  }
  assert.deepEqual(
    report.meters.map((m) => m.usedPercent),
    [60, 90],
  );
  assert.match(report.meters[1].name, /Claude and GPT/);
});

test("Antigravity handles empty groups, disabled buckets, absolute remaining and tiny positive fractions", async () => {
  const report = await googleAntigravityAdapter.fetchUsage(antiAuth, {
    fetch: payloadFetch({
      groups: [],
      buckets: [
        { bucketId: "disabled", disabled: true, remainingFraction: 0 },
        { bucketId: "absolute-zero", remainingAmount: "0" },
        { bucketId: "absolute", remainingAmount: 4 },
        { bucketId: "tiny", remainingFraction: 0.004 },
        { bucketId: "unknown", remainingFraction: "invalid" },
      ],
    }),
  });
  assert.equal(report.meters.length, 4);
  assert.equal(report.meters[0].usedPercent, undefined);
  assert.equal(report.meters[0].status, "exhausted");
  assert.match(report.meters[0].remainingText ?? "", /^0/);
  assert.equal(report.meters[1].status, "unknown");
  assert.equal(report.meters[2].usedPercent, 99.6);
  assert.equal(report.meters[2].status, "warning");
  assert.equal(report.meters[3].status, "unknown");
  assert.ok(report.warning);
});

test("Antigravity does not retry rejected credentials or query without a project", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls++;
    return new Response("secret", { status: 401, statusText: "private" });
  };
  const rejected = await googleAntigravityAdapter.fetchUsage(antiAuth, {
    fetch: fetcher,
  });
  assert.equal(calls, 1);
  assert.equal(rejected.error, "HTTP 401");
  const missing = await googleAntigravityAdapter.fetchUsage(
    { apiKey: "bare-token" },
    { fetch: fetcher },
  );
  assert.ok(missing.error);
  assert.equal(calls, 1);
});

test("Codex retains every additional window and uses explicit duration, seconds and account header", async () => {
  const token = jwt({
    "https://api.openai.com/auth": { chatgpt_account_id: "jwt-account" },
    "https://api.openai.com/profile": { email: "codex@example.test" },
  });
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const report = await openaiCodexAdapter.fetchUsage(
    { apiKey: token, headers: { "chatgpt-account-id": "selected-account" } },
    {
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        return Response.json({
          plan_type: "pro",
          rate_limit: {
            primary_window: {
              used_percent: 20,
              reset_at: 1788973200,
              limit_window_seconds: 604800,
            },
          },
          additional_rate_limits: [
            {
              metered_feature: "codex_bengalfox",
              rate_limit: {
                primary_window: {
                  used_percent: 5,
                  limit_window_seconds: 18000,
                },
                secondary_window: {
                  used_percent: 100,
                  limit_window_seconds: 604800,
                },
              },
            },
            {
              metered_feature: "secondary-only",
              rate_limit: { secondary_window: { used_percent: 95 } },
            },
          ],
        });
      },
    },
  );
  assert.equal(calls[0].url, "https://chatgpt.com/backend-api/wham/usage");
  assert.equal(
    new Headers(calls[0].init?.headers).get("Authorization"),
    `Bearer ${token}`,
  );
  assert.equal(
    new Headers(calls[0].init?.headers).get("ChatGPT-Account-Id"),
    "selected-account",
  );
  assert.equal(report.accountIdentifier, "codex@example.test");
  assert.equal(report.meters.length, 4);
  assert.match(report.meters[0].name, /7d/);
  assert.equal(report.meters[0].resetsAt, 1788973200000);
  assert.match(report.meters[1].name, /5h/);
  assert.equal(report.meters[2].status, "exhausted");
  assert.match(report.meters[3].name, /Secondary Window/);
});

test("Codex account header falls back to JWT and is omitted when unknown", async () => {
  for (const account of ["jwt-id", undefined]) {
    const token = jwt({
      "https://api.openai.com/auth": { chatgpt_account_id: account },
    });
    await openaiCodexAdapter.fetchUsage(
      { apiKey: token },
      {
        fetch: async (_url, init) => {
          assert.equal(
            new Headers(init?.headers).get("ChatGPT-Account-Id"),
            account ?? null,
          );
          return Response.json({});
        },
      },
    );
  }
});

test("unknown successful payloads remain visibly unknown for all adapters", async () => {
  for (const adapter of DEFAULT_ADAPTERS) {
    const auth =
      adapter.id === "cursor"
        ? { apiKey: cursorToken }
        : adapter.id === "google-antigravity"
          ? antiAuth
          : { apiKey: "fake-codex" };
    const report = await adapter.fetchUsage(auth, { fetch: payloadFetch({}) });
    assert.equal(report.meters.length, 0);
    assert.ok(report.warning, adapter.id);
  }
});

test("malformed JSON and thrown transport errors never expose arbitrary strings", async () => {
  for (const adapter of DEFAULT_ADAPTERS) {
    const auth =
      adapter.id === "cursor"
        ? { apiKey: cursorToken }
        : adapter.id === "google-antigravity"
          ? antiAuth
          : { apiKey: "FAKEKEY" };
    for (const fetcher of [
      async () => new Response("FAKEKEY"),
      async () => {
        throw new Error("Bearer FAKEKEY private@example.test");
      },
    ]) {
      const report = await adapter.fetchUsage(auth, { fetch: fetcher });
      assert.ok(report.error);
      assert.doesNotMatch(JSON.stringify(report), /FAKEKEY|private@example/);
    }
  }
});

test("timestamps and unknown numeric values cannot become NaN or false healthy state", () => {
  assert.equal(computeUsageStatus(Number.NaN), "unknown");
  assert.equal(computeUsageStatus(undefined), "unknown");
  assert.equal(parseTimestamp(Infinity), undefined);
  assert.equal(parseTimestamp("1788973200"), 1788973200000);
  assert.equal(parseTimestamp(null), undefined);
  assert.equal(parseTimestamp("0"), undefined);
  assert.equal(parseTimestamp("-1"), undefined);
});

test("Antigravity timeout leaves a fresh budget for fallback", {
  timeout: 10_000,
}, async () => {
  let calls = 0;
  let firstSignal: AbortSignal | null | undefined;
  const report = await googleAntigravityAdapter.fetchUsage(antiAuth, {
    fetch: async (_url, init) => {
      calls++;
      if (calls === 1) {
        firstSignal = init?.signal;
        return new Promise<Response>((_resolve, reject) => {
          const keepAlive = setTimeout(
            () => reject(new Error("Expected an abort")),
            8000,
          );
          init?.signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(keepAlive);
              reject(init.signal?.reason);
            },
            { once: true },
          );
        });
      }
      assert.equal(firstSignal?.aborted, true);
      assert.equal(init?.signal?.aborted, false);
      return Response.json({ buckets: [{ remainingFraction: 0.5 }] });
    },
  });
  assert.equal(calls, 2);
  assert.equal(report.error, undefined);
  assert.equal(report.meters[0].usedPercent, 50);
});

test("cancelled Antigravity requests never start another endpoint", async () => {
  const controller = new AbortController();
  let calls = 0;
  const report = await googleAntigravityAdapter.fetchUsage(antiAuth, {
    signal: controller.signal,
    fetch: async () => {
      calls++;
      controller.abort();
      throw controller.signal.reason;
    },
  });
  assert.equal(calls, 1);
  assert.match(report.error ?? "", /cancelled/);
});
