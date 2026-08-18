import { createHash } from "node:crypto";
import type { ContextEvent } from "@earendil-works/pi-coding-agent";

type Message = ContextEvent["messages"][number];

export interface ActiveEvidencePolicy {
  minimumTransactionsBeforeProjection: number;
  minActiveTransactions: number;
  epochStride: number;
}

const DEFAULT_ACTIVE_EVIDENCE_POLICY: ActiveEvidencePolicy = {
  minimumTransactionsBeforeProjection: 9,
  minActiveTransactions: 3,
  epochStride: 6,
};

export const DELAYED_ACTIVE_EVIDENCE_POLICY: ActiveEvidencePolicy = {
  minimumTransactionsBeforeProjection: 15,
  minActiveTransactions: 3,
  epochStride: 6,
};

interface Transaction {
  start: number;
  end: number;
  callIds: string[];
}

function serializedChars(messages: readonly Message[]) {
  return messages.reduce(
    (total, message) => total + JSON.stringify(message).length,
    0,
  );
}

function assistantToolCallIds(message: Message) {
  if (message.role !== "assistant") return [];
  return message.content.flatMap((block) =>
    block.type === "toolCall" ? [block.id] : [],
  );
}

function parseTransactions(messages: readonly Message[], start: number) {
  const transactions: Transaction[] = [];
  let index = start;
  while (index < messages.length) {
    const assistant = messages[index];
    if (!assistant) return undefined;
    const callIds = assistantToolCallIds(assistant);
    if (callIds.length === 0 || new Set(callIds).size !== callIds.length) {
      return undefined;
    }

    const expected = new Set(callIds);
    const observed = new Set<string>();
    let cursor = index + 1;
    while (cursor < messages.length && observed.size < expected.size) {
      const result = messages[cursor];
      if (result?.role !== "toolResult") return undefined;
      if (!expected.has(result.toolCallId) || observed.has(result.toolCallId)) {
        return undefined;
      }
      observed.add(result.toolCallId);
      cursor += 1;
    }
    if (observed.size !== expected.size) return undefined;

    transactions.push({ start: index, end: cursor, callIds });
    index = cursor;
  }
  return transactions;
}

function latestUserIndex(messages: readonly Message[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") return index;
  }
  return -1;
}

export function projectActiveEvidence(
  messages: readonly Message[],
  policy = DEFAULT_ACTIVE_EVIDENCE_POLICY,
) {
  const userIndex = latestUserIndex(messages);
  if (userIndex < 0 || userIndex === messages.length - 1) return undefined;

  const transactions = parseTransactions(messages, userIndex + 1);
  if (!transactions) return undefined;
  if (transactions.length < policy.minimumTransactionsBeforeProjection) {
    return undefined;
  }

  const closable = transactions.length - policy.minActiveTransactions;
  const closedTransactions =
    Math.floor(closable / policy.epochStride) * policy.epochStride;
  if (closedTransactions < policy.epochStride) return undefined;

  const first = transactions[0];
  const retained = transactions[closedTransactions];
  if (!first || !retained) return undefined;

  const closedMessages = messages.slice(first.start, retained.start);
  const digest = createHash("sha256")
    .update(JSON.stringify(closedMessages))
    .digest("hex")
    .slice(0, 16);
  const epoch = closedTransactions / policy.epochStride;
  const projectedMessages: Message[] = [
    ...messages.slice(0, first.start),
    ...messages.slice(retained.start),
  ];
  const originalChars = serializedChars(messages);
  const projectedChars = serializedChars(projectedMessages);
  if (projectedChars >= originalChars) return undefined;

  return {
    messages: projectedMessages,
    receipt: {
      epoch,
      closedTransactions,
      retainedTransactions: transactions.length - closedTransactions,
      originalChars,
      projectedChars,
      digest,
    },
  };
}
