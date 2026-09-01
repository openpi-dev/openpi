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

type PromptSession = {
  isStreaming: boolean;
  sessionManager: { getSessionId(): string };
  prompt(
    content: string,
    options: { preflightResult(accepted: boolean): void },
  ): Promise<void>;
};

type PromptHarness = {
  runtime: { session: PromptSession };
  disposed: boolean;
  promptAdmission: Promise<void>;
  pendingPromptTraces: Trace[];
  inFlightRuntimes: Set<object>;
  retainedRuntimes: Set<object>;
  retainedSubscriptions: Map<object, () => void>;
  listeners: Set<() => void>;
};

function promptHarness(session: PromptSession) {
  const harness = Object.create(PiWebRuntime.prototype) as PromptHarness;
  harness.runtime = { session };
  harness.disposed = false;
  harness.promptAdmission = Promise.resolve();
  harness.pendingPromptTraces = [];
  harness.inFlightRuntimes = new Set();
  harness.retainedRuntimes = new Set();
  harness.retainedSubscriptions = new Map();
  harness.listeners = new Set();
  return harness;
}

const sendPrompt = (
  PiWebRuntime.prototype as unknown as {
    sendPrompt(
      this: PromptHarness,
      content: string,
      trace?: { commandId: string; sessionId: string },
      expectedSessionId?: string,
    ): Promise<void>;
  }
).sendPrompt;

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

test("prompt admission rejects a negative Pi preflight result", async () => {
  const session: PromptSession = {
    isStreaming: false,
    sessionManager: { getSessionId: () => "session-a" },
    prompt: async (_content, options) => {
      options.preflightResult(false);
    },
  };
  await assert.rejects(
    sendPrompt.call(promptHarness(session), "hello", undefined, "session-a"),
    /rejected before admission/,
  );
});

test("prompt admission fails closed without preflight evidence", async () => {
  const session: PromptSession = {
    isStreaming: false,
    sessionManager: { getSessionId: () => "session-a" },
    prompt: async () => {},
  };
  await assert.rejects(
    sendPrompt.call(promptHarness(session), "hello", undefined, "session-a"),
    /without preflight admission evidence/,
  );
});

test("a queued prompt fails closed when its requested runtime is replaced", async () => {
  let releaseFirst!: (accepted: boolean) => void;
  let markFirstStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    markFirstStarted = resolve;
  });
  let calls = 0;
  const firstSession: PromptSession = {
    isStreaming: false,
    sessionManager: { getSessionId: () => "session-a" },
    prompt: async (_content, options) => {
      calls++;
      markFirstStarted();
      await new Promise<void>((resolve) => {
        releaseFirst = (accepted) => {
          options.preflightResult(accepted);
          resolve();
        };
      });
    },
  };
  const harness = promptHarness(firstSession);
  const first = sendPrompt.call(harness, "first", undefined, "session-a");
  await firstStarted;
  const queued = sendPrompt.call(harness, "queued", undefined, "session-a");
  harness.runtime = {
    session: {
      isStreaming: false,
      sessionManager: { getSessionId: () => "session-b" },
      prompt: async () => {
        calls++;
      },
    },
  };
  releaseFirst(true);
  await first;
  await assert.rejects(queued, /session changed before prompt admission/i);
  assert.equal(calls, 1);
});
