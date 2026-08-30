import { performance } from "node:perf_hooks";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { AgentProgressProjection } from "../extensions/workflows/progress-projection.ts";

type AgentMessage = AgentSession["messages"][number];

function readOption(name: string) {
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1];
  return process.argv
    .find((argument) => argument.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

function parseSizes(raw: string | undefined) {
  const sizes = (raw ?? "100,1000,10000")
    .split(",")
    .map((value) => Number.parseInt(value, 10));
  if (
    sizes.some(
      (value) => !Number.isSafeInteger(value) || value <= 0 || value % 2 !== 0,
    )
  ) {
    throw new Error("--sizes must contain positive even message counts");
  }
  return sizes;
}

const zeroUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

for (const messageCount of parseSizes(readOption("--sizes"))) {
  let sourceMessageVisits = 0;
  const store: AgentMessage[] = [];
  const messages = new Proxy(store, {
    get(target, property, receiver) {
      if (typeof property === "string" && /^\d+$/.test(property)) {
        sourceMessageVisits++;
      }
      return Reflect.get(target, property, receiver);
    },
  });
  const projection = new AgentProgressProjection();
  const toolCycles = messageCount / 2;
  let lifecycleEvents = 0;
  let progressWrites = 0;

  const started = performance.now();
  for (let index = 0; index < toolCycles; index++) {
    const toolCallId = `call-${index}`;
    const assistant = {
      role: "assistant" as const,
      content: [
        { type: "text" as const, text: `cycle ${index}` },
        {
          type: "toolCall" as const,
          id: toolCallId,
          name: "read",
          arguments: { path: `fixture-${index}.txt` },
        },
      ],
      api: "openai-responses",
      provider: "benchmark",
      model: "benchmark",
      usage: zeroUsage,
      stopReason: "toolUse" as const,
      timestamp: index * 2,
    } satisfies AgentMessage;
    const result = {
      role: "toolResult" as const,
      toolCallId,
      toolName: "read",
      content: [{ type: "text" as const, text: `result ${index}` }],
      isError: false,
      timestamp: index * 2 + 1,
    } satisfies AgentMessage;

    messages.push(assistant);
    projection.append(assistant);
    lifecycleEvents++;
    projection.snapshot();
    progressWrites++;

    for (let lifecycle = 0; lifecycle < 2; lifecycle++) {
      lifecycleEvents++;
      projection.snapshot();
      progressWrites++;
    }

    messages.push(result);
    projection.append(result);
    lifecycleEvents++;
    projection.snapshot();
    progressWrites++;
  }

  // runAgent performs one authoritative terminal reconciliation.
  projection.replace(messages);
  const terminal = projection.snapshot();
  const wallMs = performance.now() - started;
  const oneScanPerProgressLowerBoundVisits =
    messageCount ** 2 + messageCount / 2;

  console.log(
    JSON.stringify({
      messages: messageCount,
      toolCycles,
      lifecycleEvents,
      progressWrites,
      sourceMessageVisits,
      oneScanPerProgressLowerBoundVisits,
      reductionVsOneScanLowerBound: Number(
        (oneScanPerProgressLowerBoundVisits / sourceMessageVisits).toFixed(1),
      ),
      transcriptEntries: terminal.transcript.length,
      wallMs: Number(wallMs.toFixed(1)),
    }),
  );
}
