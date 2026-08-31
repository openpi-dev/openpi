import assert from "node:assert/strict";
import test from "node:test";
import { PiWebRuntime } from "../../web/runtime/pi-runtime.ts";

type Trace = {
  commandId: string;
  sessionId: string;
  startedAt: number;
  started: boolean;
  queued: boolean;
};

type RuntimeHarness = {
  runtime: { session: object };
  activePromptTrace?: Trace;
  pendingPromptTraces: Trace[];
  liveMessageSequence: number;
  liveMessageKey?: string;
  listeners: Set<
    (event: { type: string; detail?: Record<string, unknown> }) => void
  >;
};

test("prompt traces advance with queued user messages", () => {
  const session = {};
  const harness = Object.create(PiWebRuntime.prototype) as RuntimeHarness;
  harness.runtime = { session };
  harness.pendingPromptTraces = [];
  harness.liveMessageSequence = 0;
  harness.listeners = new Set();
  harness.activePromptTrace = {
    commandId: "first",
    sessionId: "session",
    startedAt: 1,
    started: false,
    queued: false,
  };
  harness.pendingPromptTraces.push({
    commandId: "second",
    sessionId: "session",
    startedAt: 2,
    started: false,
    queued: true,
  });

  const projectEvent = (
    PiWebRuntime.prototype as unknown as {
      projectEvent(this: RuntimeHarness, session: object, event: object): void;
    }
  ).projectEvent;
  const userMessage = (text: string) => ({
    type: "message_start",
    message: { role: "user", content: [{ type: "text", text }] },
  });

  projectEvent.call(harness, session, userMessage("first"));
  assert.equal(harness.activePromptTrace?.commandId, "first");
  assert.equal(harness.activePromptTrace?.started, true);

  projectEvent.call(harness, session, userMessage("second"));
  assert.equal(harness.activePromptTrace?.commandId, "second");
  assert.equal(harness.activePromptTrace?.started, true);
  assert.equal(harness.pendingPromptTraces.length, 0);
});
