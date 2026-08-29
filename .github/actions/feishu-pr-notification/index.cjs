const crypto = require("node:crypto");
const fs = require("node:fs");

const FIELD_LIMIT = 256;
const REVIEWER_LIMIT = 128;
const REVIEWERS_LIMIT = 512;
const URL_LIMIT = 512;
const CONTROL_OR_LINE_SEPARATOR = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const BIDI_CONTROL = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

function truncateCodePoints(value, maxCodePoints) {
  const points = Array.from(value);
  if (points.length <= maxCodePoints) return value;
  if (maxCodePoints <= 1) return "…";
  return `${points.slice(0, maxCodePoints - 1).join("")}…`;
}

function isEncodedAngleBracket(value) {
  return /^&(?:lt;?|gt;?|#0*(?:60|62)(?:;|(?![0-9]))|#x0*(?:3c|3e)(?:;|(?![0-9a-f])))/iu.test(
    value,
  );
}

/** Project untrusted PR metadata into one bounded Feishu plain-text field. */
function sanitizeFeishuField(value, maxCodePoints = FIELD_LIMIT) {
  const points = Array.from(String(value ?? ""))
    .filter((point) => !BIDI_CONTROL.test(point))
    .map((point) => (CONTROL_OR_LINE_SEPARATOR.test(point) ? " " : point));
  // Keep benign Unicode and ordinary ampersands byte-for-byte. The parallel
  // NFKC projection is used only to identify compatibility characters that a
  // downstream renderer could turn into Feishu <at> markup or an angle-bracket
  // entity. Replacement characters remain non-ASCII under NFKC/NFKD.
  const compatibility = points.map((point) => point.normalize("NFKC"));
  const safe = points.map((point, index) => {
    if (compatibility[index] === "<") return "‹";
    if (compatibility[index] === ">") return "›";
    if (
      compatibility[index] === "&" &&
      isEncodedAngleBracket(compatibility.slice(index).join(""))
    ) {
      return "⅋";
    }
    return point;
  });
  return truncateCodePoints(
    safe.join("").replace(/\s+/gu, " ").trim(),
    maxCodePoints,
  );
}

function formatNotificationText(event, repository) {
  const pr = event.pull_request;
  const author = sanitizeFeishuField(pr.user?.login ?? "unknown");
  const reviewers = [
    ...(pr.requested_reviewers ?? []).map((reviewer) =>
      sanitizeFeishuField(reviewer.login, REVIEWER_LIMIT),
    ),
    ...(pr.requested_teams ?? []).map(
      (team) => `team/${sanitizeFeishuField(team.slug, REVIEWER_LIMIT)}`,
    ),
  ].filter(Boolean);
  const reviewerText =
    reviewers.length > 0
      ? sanitizeFeishuField(reviewers.join(", "), REVIEWERS_LIMIT)
      : "未指定";
  const lines = [
    `${sanitizeFeishuField(repository)} 有新的 PR`,
    `#${pr.number} ${sanitizeFeishuField(pr.title)}`,
    `作者：${author}`,
    `审阅人：${reviewerText}`,
    `分支：${sanitizeFeishuField(pr.head.label)} -> ${sanitizeFeishuField(pr.base.ref)}`,
    `PR 链接：${sanitizeFeishuField(pr.html_url, URL_LIMIT)}`,
  ];
  return lines.join("\n");
}

function isSuccessfulResponse(payload) {
  return (
    payload !== null &&
    typeof payload === "object" &&
    (payload.code === 0 || payload.StatusCode === 0)
  );
}

async function sendNotification({
  event,
  repository,
  webhook,
  secret,
  now = Date.now,
}) {
  const timestamp = String(Math.floor(now() / 1_000));
  const stringToSign = `${timestamp}\n${secret}`;
  const sign = crypto
    .createHmac("sha256", stringToSign)
    .update("")
    .digest("base64");
  const response = await fetch(webhook, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      timestamp,
      sign,
      msg_type: "text",
      content: { text: formatNotificationText(event, repository) },
    }),
  });
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Feishu webhook returned ${response.status}: ${text}`);
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(
      `Feishu webhook returned an invalid JSON response: ${text}`,
    );
  }

  if (!isSuccessfulResponse(payload)) {
    throw new Error(`Feishu webhook failed: ${text}`);
  }
}

async function main() {
  const event = JSON.parse(fs.readFileSync(process.env.EVENT_PATH, "utf8"));
  await sendNotification({
    event,
    repository: process.env.REPOSITORY,
    webhook: process.env.FEISHU_PR_BOT_WEBHOOK,
    secret: process.env.FEISHU_PR_BOT_SECRET,
  });
  console.log("Feishu PR notification sent.");
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  formatNotificationText,
  isSuccessfulResponse,
  sanitizeFeishuField,
  sendNotification,
};
