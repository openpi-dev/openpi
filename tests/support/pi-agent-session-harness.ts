/**
 * Minimal controllable Pi AgentSession for production-adapter integration
 * tests. Tests drive native AgentSession events explicitly; this fake records
 * SDK calls but deliberately does not reproduce Pi or subagent lifecycle state.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  AgentSession,
  AgentSessionEvent,
  AgentSessionEventListener,
} from "@earendil-works/pi-coding-agent";

const ZERO_USAGE = {
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

export interface PiAgentSessionHarnessOptions {
  readonly model?: AgentSession["model"];
  readonly initialMessages?: AgentSession["messages"];
  readonly activeTools?: readonly string[];
  readonly contextUsage?: {
    readonly tokens: number | null;
    readonly contextWindow: number;
  };
  readonly sessionFile?: string;
  readonly bind?: () => Promise<void>;
  readonly preflight?: (
    text: string,
    harness: PiAgentSessionHarness,
  ) => Promise<void>;
  readonly prompt?: (
    text: string,
    harness: PiAgentSessionHarness,
  ) => Promise<void>;
  readonly steer?: (
    text: string,
    harness: PiAgentSessionHarness,
  ) => Promise<void>;
  readonly abort?: (harness: PiAgentSessionHarness) => Promise<void>;
  readonly shutdown?: (harness: PiAgentSessionHarness) => Promise<void>;
  readonly dispose?: (harness: PiAgentSessionHarness) => void;
}

export interface PiAgentSessionHarness {
  readonly session: AgentSession;
  readonly messages: AgentSession["messages"];
  readonly calls: {
    readonly bindings: Array<{ mode: "print" }>;
    readonly prompts: string[];
    readonly steers: string[];
    readonly sessionNames: string[];
    clearQueues: number;
    aborts: number;
    shutdowns: number;
    disposals: number;
  };
  emit(event: AgentSessionEvent): void;
  /** Explicitly settle the oldest default prompt Promise. */
  resolvePrompt(): void;
  emitUser(text: string): void;
  emitAssistant(
    text: string,
    options?: {
      readonly stopReason?: AssistantMessage["stopReason"];
      readonly errorMessage?: string;
      readonly provider?: string;
      readonly model?: string;
    },
  ): AssistantMessage;
  emitTextDelta(delta: string): void;
  setStreaming(streaming: boolean): void;
  setContextUsage(
    usage:
      | { readonly tokens: number | null; readonly contextWindow: number }
      | undefined,
  ): void;
  activeTools(): string[];
}

export function createPiAgentSessionHarness(
  options: PiAgentSessionHarnessOptions = {},
) {
  const listeners = new Set<AgentSessionEventListener>();
  const messages: AgentSession["messages"] = [
    ...(options.initialMessages ?? []),
  ];
  const calls = {
    bindings: [] as Array<{ mode: "print" }>,
    prompts: [] as string[],
    steers: [] as string[],
    sessionNames: [] as string[],
    clearQueues: 0,
    aborts: 0,
    shutdowns: 0,
    disposals: 0,
  };
  let streaming = false;
  let contextUsage = options.contextUsage;
  let activeTools = [...(options.activeTools ?? [])];
  let harness: PiAgentSessionHarness;
  const pendingDefaultPrompts: Array<() => void> = [];
  let queuedPromptResolutions = 0;

  const emit = (event: AgentSessionEvent) => {
    for (const listener of [...listeners]) listener(event);
  };

  const makeAssistantMessage = (
    text: string,
    messageOptions: {
      readonly stopReason?: AssistantMessage["stopReason"];
      readonly errorMessage?: string;
      readonly provider?: string;
      readonly model?: string;
    } = {},
  ) =>
    ({
      role: "assistant",
      content: [{ type: "text", text }],
      api: "openai-responses",
      provider: messageOptions.provider ?? options.model?.provider ?? "fixture",
      model: messageOptions.model ?? options.model?.id ?? "fixture-model",
      usage: ZERO_USAGE,
      stopReason: messageOptions.stopReason ?? "stop",
      ...(messageOptions.errorMessage
        ? { errorMessage: messageOptions.errorMessage }
        : {}),
      timestamp: Date.now(),
    }) satisfies AssistantMessage;

  const session = {
    messages,
    get model() {
      return options.model;
    },
    get isStreaming() {
      return streaming;
    },
    get sessionFile() {
      return options.sessionFile ?? "fixture-session.jsonl";
    },
    sessionManager: {
      appendSessionInfo(name: string) {
        calls.sessionNames.push(name);
      },
    },
    extensionRunner: {
      hasHandlers(eventType: string) {
        return (
          eventType === "session_shutdown" && options.shutdown !== undefined
        );
      },
      async emit() {
        calls.shutdowns++;
        await options.shutdown?.(harness);
      },
    },
    async bindExtensions(bindings: { mode: "print" }) {
      calls.bindings.push(bindings);
      await options.bind?.();
    },
    subscribe(listener: AgentSessionEventListener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async prompt(
      text: string,
      promptOptions?: Parameters<AgentSession["prompt"]>[1],
    ) {
      calls.prompts.push(text);
      try {
        await options.preflight?.(text, harness);
      } catch (error) {
        promptOptions?.preflightResult?.(false);
        throw error;
      }
      promptOptions?.preflightResult?.(true);
      if (options.prompt) {
        await options.prompt(text, harness);
        return;
      }
      await new Promise<void>((resolve) => {
        if (queuedPromptResolutions > 0) {
          queuedPromptResolutions--;
          resolve();
          return;
        }
        pendingDefaultPrompts.push(resolve);
      });
    },
    async steer(text: string) {
      calls.steers.push(text);
      await options.steer?.(text, harness);
    },
    clearQueue() {
      calls.clearQueues++;
      return { steering: [], followUp: [] };
    },
    async abort() {
      calls.aborts++;
      await options.abort?.(harness);
      streaming = false;
    },
    dispose() {
      calls.disposals++;
      options.dispose?.(harness);
    },
    getContextUsage() {
      return contextUsage;
    },
    getAllTools() {
      return activeTools.map((name) => ({ name }));
    },
    getToolDefinition() {
      return undefined;
    },
    getActiveToolNames() {
      return [...activeTools];
    },
    setActiveToolsByName(toolNames: string[]) {
      activeTools = [...toolNames];
    },
  } as unknown as AgentSession;

  harness = {
    session,
    messages,
    calls,
    emit,
    resolvePrompt() {
      const resolve = pendingDefaultPrompts.shift();
      if (resolve) resolve();
      else queuedPromptResolutions++;
    },
    emitUser(text) {
      const message = {
        role: "user",
        content: text,
        timestamp: Date.now(),
      } satisfies AgentSession["messages"][number];
      messages.push(message);
      emit({ type: "message_end", message });
    },
    emitAssistant(text, messageOptions) {
      const message = makeAssistantMessage(text, messageOptions);
      messages.push(message);
      emit({ type: "message_end", message });
      return message;
    },
    emitTextDelta(delta) {
      const partial = makeAssistantMessage(delta);
      emit({
        type: "message_update",
        message: partial,
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta,
          partial,
        },
      });
    },
    setStreaming(next) {
      streaming = next;
    },
    setContextUsage(next) {
      contextUsage = next;
    },
    activeTools: () => [...activeTools],
  };

  return harness;
}
