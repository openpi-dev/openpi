import assert from "node:assert/strict";
import test from "node:test";
import {
  cursorAdapter,
  extractCursorUserId,
} from "../../../extensions/usage/providers/cursor.ts";
import { googleAntigravityAdapter } from "../../../extensions/usage/providers/google-antigravity.ts";
import { openaiCodexAdapter } from "../../../extensions/usage/providers/openai-codex.ts";
import {
  DEFAULT_ADAPTERS,
  UsageAdapterRegistry,
} from "../../../extensions/usage/providers/registry.ts";
import type { UsageFetchContext } from "../../../extensions/usage/types.ts";

function fakeJwt(payload: Record<string, unknown>): string {
  const b64 = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj))
      .toString("base64")
      .replace(/=/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
  return `${b64({ alg: "none" })}.${b64(payload)}.sig`;
}

test("extractCursorUserId correctly strips auth0 prefix and handles clean ids", () => {
  const tokenWithPrefix = fakeJwt({ sub: "auth0|usr_12345" });
  assert.equal(extractCursorUserId(tokenWithPrefix), "usr_12345");

  const tokenClean = fakeJwt({ sub: "usr_abcde" });
  assert.equal(extractCursorUserId(tokenClean), "usr_abcde");

  assert.equal(extractCursorUserId("invalid.token"), undefined);
});

test("cursorAdapter verifies request Cookie format, URL, and parses auto/api without cents ratio", async () => {
  const token = fakeJwt({ sub: "auth0|cursor_user" });
  const summaryPayload = {
    individualUsage: {
      plan: {
        enabled: true,
        used: 1504,
        limit: 7000,
        autoPercentUsed: 12.5,
        apiPercentUsed: 45.0,
      },
      onDemand: {
        enabled: true,
        used: 250,
        limit: 2000,
      },
    },
    billingCycleEnd: "2026-04-01T00:00:00.000Z",
  };

  const capturedRequests: Array<{
    url: string;
    headers: Record<string, string>;
  }> = [];

  const fakeFetch: typeof fetch = async (url, init) => {
    const urlStr = String(url);
    const headers = (init?.headers as Record<string, string>) || {};
    capturedRequests.push({ url: urlStr, headers });

    if (urlStr === "https://cursor.com/api/usage-summary") {
      return new Response(JSON.stringify(summaryPayload), { status: 200 });
    }
    if (urlStr === "https://cursor.com/api/auth/me") {
      return new Response(JSON.stringify({ email: "user@example.com" }), {
        status: 200,
      });
    }
    return new Response("Not found", { status: 404 });
  };

  const report = await cursorAdapter.fetchUsage({ access: token }, {
    fetch: fakeFetch,
  } as UsageFetchContext);

  // Assert wire request details
  const summaryReq = capturedRequests.find((r) =>
    r.url.includes("usage-summary"),
  );
  assert.ok(summaryReq);
  assert.equal(summaryReq.url, "https://cursor.com/api/usage-summary");
  const expectedCookie = `WorkosCursorSessionToken=${encodeURIComponent(`cursor_user::${token}`)}`;
  assert.equal(summaryReq.headers.Cookie, expectedCookie);

  // Assert parsed report
  assert.equal(report.providerId, "cursor");
  assert.equal(report.accountIdentifier, "user@example.com");
  assert.equal(report.meters.length, 3);

  const autoMeter = report.meters.find((m) => m.id === "cursor-models");
  assert.ok(autoMeter);
  assert.equal(autoMeter.usedPercent, 12.5);
  assert.equal(autoMeter.status, "ok");

  const apiMeter = report.meters.find((m) => m.id === "other-models");
  assert.ok(apiMeter);
  assert.equal(apiMeter.usedPercent, 45.0);

  const onDemandMeter = report.meters.find((m) => m.id === "on-demand");
  assert.ok(onDemandMeter);
  assert.equal(onDemandMeter.usedPercent, 12.5);
  assert.equal(onDemandMeter.usedText, "$2.50");
});

test("googleAntigravityAdapter verifies auth bearer, projectId body, and endpoint fallback", async () => {
  const summaryData = {
    groups: [
      {
        displayName: "Gemini Models",
        buckets: [
          {
            bucketId: "gemini-5h",
            displayName: "Five Hour Limit Remaining",
            remainingFraction: 0.4,
            resetTime: "2026-03-09T18:00:00Z",
          },
        ],
      },
      {
        displayName: "Claude and GPT models",
        buckets: [
          {
            bucketId: "3p-weekly",
            displayName: "Weekly Limit Remaining",
            remainingFraction: 0.1,
            resetTime: "2026-03-15T00:00:00Z",
          },
        ],
      },
    ],
  };

  const capturedRequests: Array<{
    url: string;
    headers: Record<string, string>;
    body?: string;
  }> = [];

  const fakeFetch: typeof fetch = async (url, init) => {
    const urlStr = String(url);
    capturedRequests.push({
      url: urlStr,
      headers: (init?.headers as Record<string, string>) || {},
      body: String(init?.body || ""),
    });

    // Simulate primary daily endpoint 503, fallback to prod cloudcode-pa
    if (urlStr.startsWith("https://daily-cloudcode-pa.googleapis.com")) {
      return new Response("Daily down", {
        status: 503,
        statusText: "Service Unavailable",
      });
    }
    if (urlStr.startsWith("https://cloudcode-pa.googleapis.com")) {
      return new Response(JSON.stringify(summaryData), { status: 200 });
    }
    return new Response("Not found", { status: 404 });
  };

  const report = await googleAntigravityAdapter.fetchUsage(
    {
      access: "secret-token",
      projectId: "test-proj",
      email: "anti@example.com",
    },
    { fetch: fakeFetch } as UsageFetchContext,
  );

  // Assert 2 calls were made (primary failed, fallback succeeded)
  assert.equal(capturedRequests.length, 2);
  const primaryReq = capturedRequests[0];
  assert.equal(primaryReq.headers.Authorization, "Bearer secret-token");
  assert.equal(primaryReq.body, JSON.stringify({ project: "test-proj" }));

  const fallbackReq = capturedRequests[1];
  assert.equal(fallbackReq.headers.Authorization, "Bearer secret-token");
  assert.equal(fallbackReq.body, JSON.stringify({ project: "test-proj" }));

  assert.equal(report.providerId, "google-antigravity");
  assert.equal(report.accountIdentifier, "anti@example.com");
  assert.equal(report.meters.length, 2);

  // 1 - 0.4 = 0.6 -> 60%
  const geminiMeter = report.meters[0];
  assert.equal(geminiMeter.usedPercent, 60);
  assert.equal(geminiMeter.status, "ok");

  // 1 - 0.1 = 0.9 -> 90% (warning)
  const claudeMeter = report.meters[1];
  assert.equal(claudeMeter.usedPercent, 90);
  assert.equal(claudeMeter.status, "warning");
});

test("openaiCodexAdapter verifies ChatGPT-Account-Id header and parses second-based reset_at", async () => {
  const tokenWithAccount = fakeJwt({
    "https://api.openai.com/auth": { chatgpt_account_id: "acct-123" },
    "https://api.openai.com/profile": { email: "codex@example.com" },
  });

  const nowSec = Math.floor(Date.now() / 1000);
  const resetSec = nowSec + 7200;

  const whamPayload = {
    plan_type: "pro",
    rate_limit: {
      primary_window: {
        used_percent: 20,
        reset_at: resetSec,
      },
      secondary_window: {
        used_percent: 100,
        reset_at: resetSec + 86400 * 5,
      },
    },
    additional_rate_limits: [
      {
        metered_feature: "codex_bengalfox",
        rate_limit: {
          primary_window: {
            used_percent: 5,
            reset_at: resetSec,
          },
        },
      },
    ],
  };

  const capturedRequests: Array<{
    url: string;
    headers: Record<string, string>;
  }> = [];

  const fakeFetch: typeof fetch = async (url, init) => {
    capturedRequests.push({
      url: String(url),
      headers: (init?.headers as Record<string, string>) || {},
    });
    return new Response(JSON.stringify(whamPayload), { status: 200 });
  };

  const report = await openaiCodexAdapter.fetchUsage(
    { access: tokenWithAccount },
    { fetch: fakeFetch } as UsageFetchContext,
  );

  // Assert wire request
  assert.equal(capturedRequests.length, 1);
  assert.equal(
    capturedRequests[0].url,
    "https://chatgpt.com/backend-api/wham/usage",
  );
  assert.equal(
    capturedRequests[0].headers.Authorization,
    `Bearer ${tokenWithAccount}`,
  );
  assert.equal(capturedRequests[0].headers["ChatGPT-Account-Id"], "acct-123");

  assert.equal(report.providerId, "openai-codex");
  assert.equal(report.planName, "ChatGPT Pro");
  assert.equal(report.accountIdentifier, "codex@example.com");

  const primary = report.meters.find((m) => m.id === "codex-primary");
  assert.ok(primary);
  assert.equal(primary.usedPercent, 20);
  // Must convert sec to ms (13 digits)
  assert.equal(primary.resetsAt, resetSec * 1000);

  const secondary = report.meters.find((m) => m.id === "codex-secondary");
  assert.ok(secondary);
  assert.equal(secondary.usedPercent, 100);
  assert.equal(secondary.status, "exhausted");

  const spark = report.meters.find((m) => m.id.includes("codex_bengalfox"));
  assert.ok(spark);
  assert.equal(spark.name, "Spark (Fast)");
  assert.equal(spark.usedPercent, 5);

  // Test that when accountId is missing, the header is not sent
  capturedRequests.length = 0;
  const tokenWithoutAccount = fakeJwt({ sub: "user-without-account" });
  await openaiCodexAdapter.fetchUsage({ access: tokenWithoutAccount }, {
    fetch: fakeFetch,
  } as UsageFetchContext);
  assert.equal(capturedRequests[0].headers["ChatGPT-Account-Id"], undefined);
});

test("UsageAdapterRegistry resolves matching adapters from credential map", () => {
  const registry = new UsageAdapterRegistry(DEFAULT_ADAPTERS);
  const authStore = {
    cursor: { access: "c-token" },
    "openai-codex": { access: "o-token" },
    unknown_provider: { key: "some-key" },
  };

  const resolved = registry.resolveAdaptersWithCredentials(authStore);
  assert.equal(resolved.length, 2);
  assert.deepEqual(resolved.map((r) => r.adapter.id).sort(), [
    "cursor",
    "openai-codex",
  ]);
});
