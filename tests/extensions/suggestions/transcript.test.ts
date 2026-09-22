import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  createRunBoundary,
  getRunEntries,
  serializeRunTranscript,
  TRANSCRIPT_MAX_BYTES,
} from "../../../extensions/suggestions/src/transcript.ts";

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function entry(
  id: string,
  message: Extract<SessionEntry, { type: "message" }>["message"],
): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: new Date(0).toISOString(),
    message,
  };
}

test("run boundaries replace stale starts and settle exactly once", () => {
  const boundary = createRunBoundary();
  boundary.begin("before-run");
  boundary.begin("new-top-level-run");

  assert.deepEqual(boundary.settle(), {
    baselineLeafId: "new-top-level-run",
  });
  assert.equal(boundary.settle(), undefined);
});

test("run slicing starts after the before_agent_start leaf", () => {
  const entries = [
    entry("old", { role: "user", content: "old", timestamp: 0 }),
    entry("new", { role: "user", content: "new", timestamp: 1 }),
  ];
  assert.deepEqual(
    getRunEntries(entries, "old").map((item) => item.id),
    ["new"],
  );
  assert.deepEqual(getRunEntries(entries, "missing"), []);
});

test("transcript omits thinking, images, and recap entries while redacting tool data", () => {
  const entries: SessionEntry[] = [
    entry("user", {
      role: "user",
      content: [
        { type: "text", text: "Update the client" },
        { type: "image", data: "base64-image-bytes", mimeType: "image/png" },
      ],
      timestamp: 0,
    }),
    entry("assistant", {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hidden chain of thought" },
        {
          type: "toolCall",
          id: "call-1",
          name: "bash",
          arguments: {
            command:
              "curl -H 'Authorization: Bearer very-secret-token' https://example.test",
            apiKey: "sk-super-secret-value",
            payload: "x".repeat(10_000),
          },
        },
        { type: "text", text: "Updated the client." },
      ],
      api: "openai-codex-responses",
      provider: "openai-codex",
      model: "gpt-5.6-luna",
      usage,
      stopReason: "toolUse",
      timestamp: 1,
    }),
    entry("result", {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "bash",
      content: [{ type: "text", text: "token=another-secret\nfinished" }],
      isError: false,
      timestamp: 2,
    }),
    {
      type: "custom",
      id: "old-recap",
      parentId: "result",
      timestamp: new Date(0).toISOString(),
      customType: "summary-recap",
      data: { recap: "old recap" },
    },
  ];

  const transcript = serializeRunTranscript(entries);
  assert.match(transcript, /Update the client/);
  assert.match(transcript, /TOOL CALL bash/);
  assert.match(transcript, /Updated the client/);
  assert.doesNotMatch(transcript, /hidden chain of thought/);
  assert.doesNotMatch(transcript, /base64-image-bytes/);
  assert.doesNotMatch(transcript, /very-secret-token/);
  assert.doesNotMatch(transcript, /another-secret/);
  assert.doesNotMatch(transcript, /old recap/);
  assert.match(transcript, /\[REDACTED\]/);
  assert.match(transcript, /tool arguments capped/);
});

test("transcript enforces per-result and total byte caps", () => {
  const entries = Array.from({ length: 20 }, (_, index) =>
    entry(`result-${index}`, {
      role: "toolResult",
      toolCallId: `call-${index}`,
      toolName: "bash",
      content: [{ type: "text", text: `${index}:${"x".repeat(10_000)}` }],
      isError: false,
      timestamp: index,
    }),
  );

  const transcript = serializeRunTranscript(entries);
  assert.ok(Buffer.byteLength(transcript, "utf8") <= TRANSCRIPT_MAX_BYTES);
  assert.match(transcript, /transcript capped/);
  assert.match(transcript, /tool result capped/);
});

for (const fixture of [
  {
    name: "double-quoted spaces",
    text: 'password="north south" next=visible',
    expected: "password=[REDACTED] next=visible",
  },
  {
    name: "quoted punctuation in JSON output",
    text: '{"secret":"north,south;east}west","ordinary":"visible"}',
    expected: '{"secret":[REDACTED],"ordinary":"visible"}',
  },
  {
    name: "single-quoted spaces and punctuation",
    text: "token='north south;east,west}' next=visible",
    expected: "token=[REDACTED] next=visible",
  },
  {
    name: "escaped double quotes and backslashes",
    text: String.raw`password="north\" south\\east tail" next=visible`,
    expected: "password=[REDACTED] next=visible",
  },
  {
    name: "escaped single quotes and backslashes",
    text: String.raw`token='north\' south\\east tail' next=visible`,
    expected: "token=[REDACTED] next=visible",
  },
]) {
  test(`transcript redacts the complete value for ${fixture.name}`, () => {
    const transcript = serializeRunTranscript([
      entry("result", {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        content: [{ type: "text", text: fixture.text }],
        isError: false,
        timestamp: 0,
      }),
    ]);

    assert.equal(transcript, `TOOL RESULT read\n${fixture.expected}`);
  });
}

test("transcript preserves unlabelled quoted prose and unquoted redaction", () => {
  const transcript = serializeRunTranscript([
    entry("user", {
      role: "user",
      content:
        'Ordinary "north south" and \'east west\'. token=one-secret next=visible password: another-secret, ordinary: "hello world"',
      timestamp: 0,
    }),
  ]);

  assert.equal(
    transcript,
    'USER\nOrdinary "north south" and \'east west\'. token=[REDACTED] next=visible password: [REDACTED], ordinary: "hello world"',
  );
});

for (const fixture of [
  ...[")", "]", ".", ").]"].flatMap((closer) =>
    ['"', "'"].map((quote) => ({
      name: `${quote}-quoted value before ${closer}`,
      text: `password=${quote}north south${quote}${closer} next=visible`,
      expected: `password=[REDACTED]${closer} next=visible`,
    })),
  ),
  {
    name: "adjacent shell-quoted segments",
    text: `password='north'"'"'south' next=visible`,
    expected: "password=[REDACTED] next=visible",
  },
  {
    name: "adjacent quoted and unquoted segments",
    text: `token="north"middle'south' next=visible`,
    expected: "token=[REDACTED] next=visible",
  },
  {
    name: "quoted shell segments joined by punctuation",
    text: `password="north"."south" next=visible`,
    expected: "password=[REDACTED] next=visible",
  },
  {
    name: "quoted and unquoted shell segments joined by punctuation",
    text: `token='north'.south next=visible`,
    expected: "token=[REDACTED] next=visible",
  },
  {
    name: "unquoted header values inside shell quotes",
    text: "curl -H 'Cookie: session=alpha-value' -H 'X-API-Key: bravo-value' https://example.test",
    expected:
      "curl -H 'Cookie: [REDACTED] -H 'X-API-Key: [REDACTED] https://example.test",
  },
  {
    name: "nested shell wrappers without weakening baseline token masking",
    text: `curl -H "Cookie: 'north south'" -H "X-API-Key: bravo-value" https://example.test`,
    // A shell parser would be needed to recognize the first entire value.
    // Preserve the existing token boundary and still redact the second header.
    expected: `curl -H "Cookie: [REDACTED] south'" -H "X-API-Key: [REDACTED] https://example.test`,
  },
]) {
  for (const role of ["toolResult", "bashExecution"] as const) {
    test(`transcript redacts ${fixture.name} from ${role}`, () => {
      const message =
        role === "toolResult"
          ? {
              role,
              toolCallId: "call-1",
              toolName: "bash",
              content: [{ type: "text" as const, text: fixture.text }],
              isError: false,
              timestamp: 0,
            }
          : {
              role,
              command: fixture.text,
              output: "visible output",
              exitCode: 0,
              cancelled: false,
              truncated: false,
              timestamp: 0,
            };
      const transcript = serializeRunTranscript([entry("result", message)]);

      assert.equal(
        transcript,
        role === "toolResult"
          ? `TOOL RESULT bash\n${fixture.expected}`
          : `USER SHELL (exit 0)\n${fixture.expected}\nvisible output`,
      );
    });
  }
}
