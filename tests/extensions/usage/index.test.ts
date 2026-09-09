import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { globalUsageCache } from "../../../extensions/usage/cache.ts";
import usage, {
  collectUsageReports,
  parseUsageArgs,
} from "../../../extensions/usage/index.ts";

test("parseUsageArgs parses all flags properly", () => {
  assert.deepEqual(parseUsageArgs(""), {
    refresh: false,
    redact: false,
    json: false,
  });
  assert.deepEqual(parseUsageArgs("-f"), {
    refresh: true,
    redact: false,
    json: false,
  });
  assert.deepEqual(parseUsageArgs("--refresh -r"), {
    refresh: true,
    redact: true,
    json: false,
  });
  assert.deepEqual(parseUsageArgs("-j --redact"), {
    refresh: false,
    redact: true,
    json: true,
  });
});

test("collectUsageReports queries matching providers and respects cache", async () => {
  globalUsageCache.invalidate();

  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    fetchCalls++;
    const urlStr = String(url);
    if (urlStr.includes("usage-summary")) {
      return new Response(
        JSON.stringify({
          individualUsage: {
            plan: { autoPercentUsed: 10, apiPercentUsed: 20 },
          },
        }),
        { status: 200 },
      );
    }
    return new Response("{}", { status: 200 });
  };

  try {
    const fakeToken = "h.eyJzdWIiOiJhdXRoMHx1c2VyMSJ9.s";
    const authStore = {
      cursor: { access: fakeToken },
    };

    // First call -> fetches
    const reports1 = await collectUsageReports({ authStore });
    assert.equal(reports1.length, 1);
    assert.equal(reports1[0].providerId, "cursor");
    assert.ok(fetchCalls > 0);

    const callsBefore = fetchCalls;
    // Second call without refresh -> from cache
    const reports2 = await collectUsageReports({ authStore, refresh: false });
    assert.equal(reports2.length, 1);
    assert.equal(fetchCalls, callsBefore);

    // Third call with refresh -> fetches again
    const reports3 = await collectUsageReports({ authStore, refresh: true });
    assert.equal(reports3.length, 1);
    assert.ok(fetchCalls > callsBefore);
  } finally {
    globalThis.fetch = originalFetch;
    globalUsageCache.invalidate();
  }
});

test("collectUsageReports isolates failures across multiple providers without caching errors", async () => {
  globalUsageCache.invalidate();

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const urlStr = String(url);
    // Cursor fails with 500
    if (urlStr.includes("cursor.com")) {
      return new Response("Server error", {
        status: 500,
        statusText: "Internal Server Error",
      });
    }
    // Antigravity succeeds
    if (urlStr.includes("googleapis.com")) {
      return new Response(
        JSON.stringify({
          groups: [
            {
              displayName: "Gemini",
              buckets: [{ remainingFraction: 0.5, window: "5h" }],
            },
          ],
        }),
        { status: 200 },
      );
    }
    return new Response("Not found", { status: 404 });
  };

  try {
    const authStore = {
      cursor: { access: "h.eyJzdWIiOiJ1c3IxIn0.s" },
      "google-antigravity": { access: "anti-token", projectId: "test-p" },
    };

    const reports = await collectUsageReports({ authStore });
    assert.equal(reports.length, 2);

    const cursorReport = reports.find((r) => r.providerId === "cursor");
    assert.ok(cursorReport);
    assert.ok(cursorReport.error);
    // Error must not leak token or secrets
    assert.match(cursorReport.error, /Failed to fetch/);
    assert.equal(cursorReport.error.includes("h.eyJ"), false);

    const antiReport = reports.find(
      (r) => r.providerId === "google-antigravity",
    );
    assert.ok(antiReport);
    assert.equal(antiReport.error, undefined);
    assert.equal(antiReport.meters.length, 1);
    assert.equal(antiReport.meters[0].usedPercent, 50);

    // Assert: cursor failure is NOT cached!
    assert.equal(globalUsageCache.get("cursor"), undefined);
    // Anti success IS cached!
    assert.ok(globalUsageCache.get("google-antigravity"));
  } finally {
    globalThis.fetch = originalFetch;
    globalUsageCache.invalidate();
  }
});

test("usage registers the /usage slash command on extension initialization", () => {
  let registeredName = "";
  let registeredDescription = "";

  const mockPi = {
    registerCommand: (
      name: string,
      options: { description: string; handler: unknown },
    ) => {
      registeredName = name;
      registeredDescription = options.description;
    },
  } as unknown as ExtensionAPI;

  usage(mockPi);
  assert.equal(registeredName, "usage");
  assert.match(registeredDescription, /subscription quota/);
});
