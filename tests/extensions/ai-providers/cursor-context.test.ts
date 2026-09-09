import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai/compat";
import {
  estimateTokens,
  getLastAssistantUsage,
  shouldCompact,
} from "@earendil-works/pi-coding-agent";
import { CURSOR_MODELS } from "../../../extensions/ai-providers/cursor/models.ts";
import {
  ConversationStepSchema,
  ConversationTurnStructureSchema,
  UserMessageSchema,
} from "../../../extensions/ai-providers/cursor/proto.ts";
import { fromBinary } from "../../../extensions/ai-providers/cursor/protobuf.ts";
import { buildCursorRequest } from "../../../extensions/ai-providers/cursor/provider.ts";
import { emptyUsage } from "../../../extensions/ai-providers/usage.ts";

const model = CURSOR_MODELS[0]!;
function assistant(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: emptyUsage(),
    stopReason: "stop",
    timestamp: 1,
  };
}
function blob(
  built: Awaited<ReturnType<typeof buildCursorRequest>>,
  id: Uint8Array,
) {
  const bytes = built.blobStore.get(Buffer.from(id).toString("hex"));
  assert.ok(bytes, "every referenced history blob must be available");
  return bytes;
}

// These are separate protocol projections, not evidence of doubled model input.
// Upstream history-loss reproduction: https://github.com/can1357/oh-my-pi/pull/737
// Root JSON is model history; native turns also have to remain replayable.
test("Cursor preserves paired history in both projections and sends the active user only as action", async () => {
  const messages: Message[] = [
    { role: "user", content: "earlier question", timestamp: 0 },
    assistant([
      { type: "thinking", thinking: "hidden reasoning" },
      { type: "text", text: "checking" },
      {
        type: "toolCall",
        id: "read-1",
        name: "read",
        arguments: { path: "a" },
      },
    ]),
    {
      role: "toolResult",
      toolCallId: "read-1",
      toolName: "read",
      content: [{ type: "text", text: "missing file" }],
      isError: true,
      timestamp: 2,
    },
    {
      role: "toolResult",
      toolCallId: "orphan",
      toolName: "read",
      content: [{ type: "text", text: "orphan data" }],
      isError: false,
      timestamp: 2,
    },
    { role: "user", content: "current question", timestamp: 3 },
  ];
  const built = await buildCursorRequest(model, { messages });
  const root = built.conversationState.rootPromptMessagesJson.map((id) =>
    JSON.parse(Buffer.from(blob(built, id)).toString()),
  );
  assert.deepEqual(
    root
      .filter((message) => message.role === "user")
      .map((message) => message.content),
    [[{ type: "text", text: "earlier question" }]],
  );
  assert.equal(root.filter((message) => message.role === "tool").length, 1);
  assert.deepEqual(
    root.find((message) => message.role === "assistant").content,
    [
      { type: "text", text: "checking" },
      {
        type: "tool-call",
        toolCallId: "read-1",
        toolName: "read",
        args: { path: "a" },
      },
    ],
  );
  assert.deepEqual(root.find((message) => message.role === "tool").content, [
    {
      type: "tool-result",
      toolCallId: "read-1",
      toolName: "read",
      result: "missing file",
      isError: true,
    },
  ]);
  const action = built.request.action?.action;
  assert.equal(action?.case, "userMessageAction");
  if (action?.case === "userMessageAction")
    assert.equal(action.value.userMessage?.text, "current question");
  assert.equal(built.conversationState.turns.length, 1);
  const turn = fromBinary(
    ConversationTurnStructureSchema,
    blob(built, built.conversationState.turns[0]!),
  ).turn;
  assert.equal(turn.case, "agentConversationTurn");
  if (turn.case !== "agentConversationTurn")
    throw new Error("missing native turn");
  assert.equal(
    fromBinary(UserMessageSchema, blob(built, turn.value.userMessage)).text,
    "earlier question",
  );
  const steps = turn.value.steps.map(
    (id) => fromBinary(ConversationStepSchema, blob(built, id)).message,
  );
  assert.deepEqual(
    steps.map((step) => step.case),
    ["assistantMessage", "toolCall"],
  );
  const call = steps[1];
  assert.ok(
    call?.case === "toolCall" && call.value.tool.case === "mcpToolCall",
  );
  assert.equal(call.value.toolCallId, "read-1");
  const result = call.value.tool.value.result?.result;
  assert.ok(result?.case === "success");
  assert.equal(result.value.isError, true);
  const stored = [...built.blobStore.values()]
    .map((value) => Buffer.from(value).toString())
    .join("\n");
  assert.doesNotMatch(stored, /hidden reasoning|orphan data|current question/);
});

test("Cursor rebuild after compaction does not resurrect removed history under the same session ID", async () => {
  const options = { sessionId: "same-conversation" };
  const before = await buildCursorRequest(
    model,
    {
      messages: [
        { role: "user", content: "discarded-private-detail", timestamp: 0 },
        assistant([{ type: "text", text: "old-answer" }]),
        { role: "user", content: "next", timestamp: 2 },
      ],
    },
    options,
  );
  const after = await buildCursorRequest(
    model,
    {
      messages: [
        { role: "user", content: "retained-summary", timestamp: 3 },
        assistant([{ type: "text", text: "summary acknowledged" }]),
      ],
    },
    options,
  );
  assert.equal(before.request.conversationId, after.request.conversationId);
  assert.equal(after.request.action?.action.case, "resumeAction");
  const stored = [...after.blobStore.values()]
    .map((value) => Buffer.from(value).toString())
    .join("\n");
  assert.match(stored, /retained-summary/);
  assert.doesNotMatch(stored, /discarded-private-detail|old-answer/);
});

test("Pi public estimation remains available when Cursor has no provider usage", () => {
  const response = assistant([{ type: "text", text: "OK" }]);
  assert.equal(
    getLastAssistantUsage([
      {
        type: "message",
        id: "response",
        parentId: null,
        timestamp: new Date(1).toISOString(),
        message: response,
      },
    ]),
    undefined,
  );
  const small: Message[] = [
    { role: "user", content: "short", timestamp: 0 },
    response,
  ];
  const large: Message[] = [
    { role: "user", content: "x".repeat(80_000), timestamp: 0 },
    response,
  ];
  const estimate = (messages: Message[]) =>
    messages.reduce((total, message) => total + estimateTokens(message), 0);
  const settings = {
    enabled: true,
    reserveTokens: 1_000,
    keepRecentTokens: 500,
  };
  assert.ok(estimate(large) > estimate(small));
  assert.equal(shouldCompact(estimate(small), 16_000, settings), false);
  assert.equal(shouldCompact(estimate(large), 16_000, settings), true);
});
