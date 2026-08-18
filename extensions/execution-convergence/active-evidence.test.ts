import assert from "node:assert/strict";
import test from "node:test";
import type { ContextEvent } from "@earendil-works/pi-coding-agent";
import { projectActiveEvidence } from "./active-evidence.ts";

type Message = ContextEvent["messages"][number];

function userMessage(text = "Implement the requested change"): Message {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: 1,
  };
}

function transaction(index: number, bodyChars = 900): Message[] {
  const id = `call-${index}`;
  return [
    {
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: `reasoning-${index}-${"r".repeat(bodyChars)}`,
          thinkingSignature: "reasoning_content",
        },
        {
          type: "toolCall",
          id,
          name: index % 2 === 0 ? "bash" : "read",
          arguments:
            index % 2 === 0
              ? {
                  command: `printf %s ${"x".repeat(bodyChars)} > scratch-${index}`,
                }
              : { path: `file-${index}.ts` },
        },
      ],
      api: "openai-completions",
      provider: "seal",
      model: "deepseek-v4-flash-0731-baidu",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      timestamp: index * 2,
    },
    {
      role: "toolResult",
      toolCallId: id,
      toolName: index % 2 === 0 ? "bash" : "read",
      content: [{ type: "text", text: `result-${index}` }],
      isError: false,
      timestamp: index * 2 + 1,
    },
  ];
}

function history(transactionCount: number) {
  return [
    userMessage(),
    ...Array.from({ length: transactionCount }, (_, index) =>
      transaction(index + 1),
    ).flat(),
  ];
}

function toolIds(messages: readonly Message[]) {
  const calls: string[] = [];
  const results: string[] = [];
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type === "toolCall") calls.push(block.id);
      }
    } else if (message.role === "toolResult") {
      results.push(message.toolCallId);
    }
  }
  return { calls, results };
}

test("short histories remain byte-for-byte untouched", () => {
  const messages = history(8);

  assert.equal(projectActiveEvidence(messages), undefined);
});

test("archiving never invents a model-facing user or custom message", () => {
  const projected = projectActiveEvidence(history(9));

  assert.ok(projected);
  assert.deepEqual(
    projected.messages.filter(
      (message) => message.role === "user" || message.role === "custom",
    ),
    [userMessage()],
  );
});

test("the first stable epoch closes six complete transactions and retains three", () => {
  const messages = history(9);
  const before = structuredClone(messages);

  const projected = projectActiveEvidence(messages);

  assert.ok(projected);
  assert.equal(projected.receipt.epoch, 1);
  assert.equal(projected.receipt.closedTransactions, 6);
  assert.equal(projected.receipt.retainedTransactions, 3);
  assert.ok(projected.receipt.projectedChars < projected.receipt.originalChars);
  assert.deepEqual(messages, before);
  assert.deepEqual(toolIds(projected.messages), {
    calls: ["call-7", "call-8", "call-9"],
    results: ["call-7", "call-8", "call-9"],
  });
});

test("an epoch receipt remains stable while its active suffix grows", () => {
  const atNine = projectActiveEvidence(history(9));
  const atFourteen = projectActiveEvidence(history(14));

  assert.ok(atNine);
  assert.ok(atFourteen);
  assert.equal(atNine.receipt.epoch, 1);
  assert.equal(atFourteen.receipt.epoch, 1);
  assert.equal(atNine.receipt.digest, atFourteen.receipt.digest);
});

test("the next epoch closes the next six transactions atomically", () => {
  const projected = projectActiveEvidence(history(15));

  assert.ok(projected);
  assert.equal(projected.receipt.epoch, 2);
  assert.equal(projected.receipt.closedTransactions, 12);
  assert.deepEqual(toolIds(projected.messages), {
    calls: ["call-13", "call-14", "call-15"],
    results: ["call-13", "call-14", "call-15"],
  });
});

test("a delayed policy leaves fourteen transactions untouched and closes twelve at fifteen", () => {
  const policy = {
    minimumTransactionsBeforeProjection: 15,
    minActiveTransactions: 3,
    epochStride: 6,
  };

  assert.equal(projectActiveEvidence(history(14), policy), undefined);
  const projected = projectActiveEvidence(history(15), policy);

  assert.ok(projected);
  assert.equal(projected.receipt.closedTransactions, 12);
  assert.equal(projected.receipt.retainedTransactions, 3);
  assert.deepEqual(toolIds(projected.messages), {
    calls: ["call-13", "call-14", "call-15"],
    results: ["call-13", "call-14", "call-15"],
  });
});

test("a delayed policy keeps its epoch stable until the next stride", () => {
  const policy = {
    minimumTransactionsBeforeProjection: 15,
    minActiveTransactions: 3,
    epochStride: 6,
  };
  const atFifteen = projectActiveEvidence(history(15), policy);
  const atTwenty = projectActiveEvidence(history(20), policy);
  const atTwentyOne = projectActiveEvidence(history(21), policy);

  assert.ok(atFifteen);
  assert.ok(atTwenty);
  assert.ok(atTwentyOne);
  assert.equal(atFifteen.receipt.digest, atTwenty.receipt.digest);
  assert.equal(atTwenty.receipt.closedTransactions, 12);
  assert.equal(atTwentyOne.receipt.closedTransactions, 18);
});

test("retained DeepSeek reasoning transactions are preserved exactly", () => {
  const messages = history(9);
  const retainedAssistant = messages.at(-2);
  const projected = projectActiveEvidence(messages);

  assert.ok(projected);
  assert.deepEqual(projected.messages.at(-2), retainedAssistant);
});

test("orphan or incomplete tool transactions fail open", () => {
  const messages = history(9);
  messages.pop();

  assert.equal(projectActiveEvidence(messages), undefined);
});

test("parallel tool batches are retained or closed as one transaction", () => {
  const messages = history(8);
  const parallelAssistant: Message = {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "parallel-a",
        name: "read",
        arguments: { path: "a.ts" },
      },
      {
        type: "toolCall",
        id: "parallel-b",
        name: "read",
        arguments: { path: "b.ts" },
      },
    ],
    api: "openai-completions",
    provider: "seal",
    model: "deepseek-v4-flash-0731-baidu",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: 99,
  };
  messages.push(
    parallelAssistant,
    {
      role: "toolResult",
      toolCallId: "parallel-a",
      toolName: "read",
      content: [{ type: "text", text: "a" }],
      isError: false,
      timestamp: 100,
    },
    {
      role: "toolResult",
      toolCallId: "parallel-b",
      toolName: "read",
      content: [{ type: "text", text: "b" }],
      isError: false,
      timestamp: 101,
    },
  );

  const projected = projectActiveEvidence(messages);

  assert.ok(projected);
  assert.deepEqual(toolIds(projected.messages), {
    calls: ["call-7", "call-8", "parallel-a", "parallel-b"],
    results: ["call-7", "call-8", "parallel-a", "parallel-b"],
  });
});
