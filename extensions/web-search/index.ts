import type { Message } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadSetupConfig } from "../shared/setup-config.ts";
import {
  createNativeSearchCapture,
  record,
  replayNativeSearch,
} from "./native.ts";
import { resolveWebSearchSupport } from "./support.ts";

/** Optional hosted search. Pi owns transport, credentials, cancellation, usage and history. */
export default function webSearch(pi: ExtensionAPI) {
  let messages: readonly Message[] = [];
  let inTurn = false;
  let capture: ReturnType<typeof createNativeSearchCapture> | undefined;
  let failure: string | undefined;
  pi.on("turn_start", () => {
    inTurn = true;
  });
  pi.on("turn_end", () => {
    inTurn = false;
    capture = undefined;
  });
  pi.on("session_start", () => {
    inTurn = false;
    capture = undefined;
    messages = [];
  });
  pi.on("context", (event) => {
    messages = event.messages.filter((message): message is Message =>
      ["assistant", "user", "toolResult"].includes(message.role),
    );
  });
  pi.on("before_provider_request", (event, ctx) => {
    capture = undefined;
    failure = undefined;
    try {
      const model = ctx.model;
      if (
        !inTurn ||
        !model ||
        !record(event.payload) ||
        event.payload.model !== model.id
      )
        return;
      const config = loadSetupConfig().webSearch;
      const support = resolveWebSearchSupport(
        model,
        config,
        ctx.modelRegistry.isUsingOAuth(model),
      );
      // Replay remains necessary after disabling search; disabling never erases history.
      const adapter =
        model.api === "anthropic-messages"
          ? "anthropic"
          : model.api === "openai-responses" ||
              model.api === "openai-codex-responses"
            ? "responses"
            : undefined;
      if (!adapter) return;
      const payload = replayNativeSearch(
        event.payload,
        messages,
        model,
        adapter,
      );
      if (!config.enabled || !support.available) return payload;
      if (
        adapter === "responses" &&
        /^gpt-5(?:-\d{4}-\d{2}-\d{2})?$/u.test(model.id) &&
        record(payload.reasoning) &&
        payload.reasoning.effort === "minimal"
      )
        return payload;
      const tools = Array.isArray(payload.tools) ? payload.tools : [];
      const nativeTool =
        adapter === "responses"
          ? { type: "web_search" }
          : { type: "web_search_20250305", name: "web_search", max_uses: 8 };
      if (
        tools.some(
          (tool) =>
            record(tool) &&
            (tool.name === "web_search" ||
              String(tool.type).startsWith("web_search")),
        )
      ) {
        throw new Error(
          "Another extension owns web_search. Disable it before enabling current-model web search.",
        );
      }
      capture = createNativeSearchCapture(adapter, model);
      return {
        ...payload,
        tools: [...tools, nativeTool],
        ...(adapter === "responses"
          ? {
              include: [
                ...new Set([
                  ...(Array.isArray(payload.include) ? payload.include : []),
                  "web_search_call.action.sources",
                ]),
              ],
            }
          : {}),
      };
    } catch (error) {
      // Pi reports hook exceptions and continues. Abort explicitly to fail closed.
      failure = error instanceof Error ? error.message : String(error);
      capture = undefined;
      ctx.abort();
      return event.payload;
    }
  });
  pi.on("provider_stream_event", (event, ctx) => {
    if (
      event.provider === ctx.model?.provider &&
      event.api === ctx.model.api &&
      event.model === ctx.model.id
    )
      capture?.observe(event.data);
  });
  pi.on("message_end", (event) => {
    if (event.message.role === "assistant" && failure) {
      const errorMessage = failure;
      failure = undefined;
      return {
        message: {
          ...event.message,
          stopReason: "error" as const,
          errorMessage,
        },
      };
    }
    if (event.message.role !== "assistant" || !capture) return;
    const message = capture.finish(event.message);
    capture = undefined;
    if (message) return { message };
  });
}
