import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);

interface PullRequestEvent {
  pull_request: {
    number: number;
    title: string;
    user?: { login: string };
    requested_reviewers?: Array<{ login: string }>;
    requested_teams?: Array<{ slug: string }>;
    head: { label: string };
    base: { ref: string };
    html_url: string;
  };
}

interface NotificationModule {
  formatNotificationText(event: PullRequestEvent, repository: string): string;
  sanitizeFeishuField(value: unknown, maxCodePoints?: number): string;
  isSuccessfulResponse(payload: unknown): boolean;
  sendNotification(options: {
    event: PullRequestEvent;
    repository: string;
    webhook: string;
    secret: string;
    now?: () => number;
  }): Promise<void>;
}

const notification =
  require("../../.github/actions/feishu-pr-notification/index.cjs") as NotificationModule;

test("the privileged workflow executes only its trusted workflow commit", () => {
  const workflow = readFileSync(
    ".github/workflows/feishu-pr-notification.yml",
    "utf8",
  );
  assert.match(
    workflow,
    /actions\/checkout@[0-9a-f]{40} # v6/u,
    "checkout stays pinned to an immutable commit",
  );
  assert.match(workflow, /ref: \$\{\{ github\.workflow_sha \}\}/u);
  assert.match(workflow, /persist-credentials: false/u);
  assert.doesNotMatch(workflow, /pull_request\.head\.sha|github\.head_ref/u);
});

function event(overrides: Partial<PullRequestEvent["pull_request"]> = {}) {
  return {
    pull_request: {
      number: 270,
      title: "feat(ci): notify Feishu for new pull requests",
      user: { login: "contributor" },
      requested_reviewers: [{ login: "reviewer" }],
      requested_teams: [{ slug: "release-managers" }],
      head: { label: "contributor:feature" },
      base: { ref: "main" },
      html_url: "https://github.com/openpi-dev/openpi/pull/270",
      ...overrides,
    },
  } satisfies PullRequestEvent;
}

test("benign pull request metadata keeps the existing notification", () => {
  assert.equal(
    notification.formatNotificationText(event(), "openpi-dev/openpi"),
    [
      "openpi-dev/openpi 有新的 PR",
      "#270 feat(ci): notify Feishu for new pull requests",
      "作者：contributor",
      "审阅人：reviewer, team/release-managers",
      "分支：contributor:feature -> main",
      "PR 链接：https://github.com/openpi-dev/openpi/pull/270",
    ].join("\n"),
  );
  assert.equal(
    notification.sanitizeFeishuField(
      "fix A & B, AT&T · 支持①号 ﬃ ligature &#600; &#620; &#x3ca; &#x3e0;",
    ),
    "fix A & B, AT&T · 支持①号 ﬃ ligature &#600; &#620; &#x3ca; &#x3e0;",
  );
});

test("untrusted metadata cannot inject Feishu tags or message fields", () => {
  const text = notification.formatNotificationText(
    event({
      title:
        '<at user_id="all">所有人</at> &lt;at&gt; &ltat&gt; &LT/at&gt; &#60;at&gt; &#60/at&gt; &#x3c;at&gt; ＆ｌｔ；at\r\n作者：伪造\u202e\u2066',
      user: { login: "evil\n审阅人：伪造" },
      requested_reviewers: [{ login: "reviewer\u2028PR 链接：伪造" }],
      head: { label: "fork\u2029作者：伪造" },
    }),
    "openpi-dev/openpi",
  );
  const lines = text.split("\n");

  assert.equal(lines.length, 6, "untrusted metadata cannot add message lines");
  assert.equal(
    lines.filter((line) => line.startsWith("作者：")).length,
    1,
    "the canonical author field stays unique",
  );
  assert.doesNotMatch(
    text,
    /<|&|[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u,
  );
  assert.match(lines[1]!, /‹at user_id="all"›所有人‹\/at›/);
  assert.doesNotMatch(text.normalize("NFKC"), /<at/u);
});

test("field bounds count Unicode code points without splitting emoji", () => {
  assert.equal(notification.sanitizeFeishuField("🙂".repeat(10), 4), "🙂🙂🙂…");
});

test("reviewer aggregates stay bounded and missing metadata keeps its fallback", () => {
  const bounded = notification
    .formatNotificationText(
      event({
        requested_reviewers: Array.from({ length: 100 }, (_, index) => ({
          login: `reviewer-${index}-${"🙂".repeat(20)}`,
        })),
        requested_teams: [],
      }),
      "openpi-dev/openpi",
    )
    .split("\n")[3]!;
  assert.ok(Array.from(bounded.slice("审阅人：".length)).length <= 512);
  assert.ok(bounded.endsWith("…"));

  const fallback = notification.formatNotificationText(
    event({
      user: undefined,
      requested_reviewers: [],
      requested_teams: [],
    }),
    "openpi-dev/openpi",
  );
  assert.match(fallback, /^\u4f5c\u8005：unknown$/mu);
  assert.match(fallback, /^\u5ba1\u9605\u4eba：未指定$/mu);
});

test("current and legacy Feishu success responses remain accepted", () => {
  assert.equal(notification.isSuccessfulResponse({ code: 0 }), true);
  assert.equal(notification.isSuccessfulResponse({ StatusCode: 0 }), true);
  assert.equal(notification.isSuccessfulResponse({ code: 19021 }), false);
  assert.equal(notification.isSuccessfulResponse(null), false);
});

test("the HTTP payload uses the sanitized formatter and expected signature", async (t) => {
  let requestBody = "";
  const server = createServer((request, response) => {
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      requestBody += chunk;
    });
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ code: 0 }));
    });
  });
  t.after(() => server.close());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const now = 1_700_000_000_000;
  const secret = "test-secret";
  await notification.sendNotification({
    event: event({
      title:
        '<at user_id="all">所有人</at> &ltat user_id="all"&gt &LT/at&gt &#60at&gt &#60/at&gt',
    }),
    repository: "openpi-dev/openpi",
    webhook: `http://127.0.0.1:${address.port}`,
    secret,
    now: () => now,
  });

  const payload = JSON.parse(requestBody) as {
    timestamp: string;
    sign: string;
    msg_type: string;
    content: { text: string };
  };
  const timestamp = String(now / 1_000);
  const expectedSign = createHmac("sha256", `${timestamp}\n${secret}`)
    .update("")
    .digest("base64");

  assert.equal(payload.timestamp, timestamp);
  assert.equal(payload.sign, expectedSign);
  assert.equal(payload.msg_type, "text");
  assert.doesNotMatch(payload.content.text, /<at/u);
  assert.doesNotMatch(payload.content.text.normalize("NFKC"), /<at/u);
  assert.doesNotMatch(payload.content.text, /&(?:lt|gt|#)/iu);
  assert.equal(payload.content.text.split("\n").length, 6);
});
