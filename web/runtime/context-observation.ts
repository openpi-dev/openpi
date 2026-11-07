import * as PiAI from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  ExtensionContext,
  InlineExtension,
} from "@earendil-works/pi-coding-agent";
import type { WebContextObservation } from "../protocol/types.ts";

// One numerical snapshot per native Session. Never retain prompt text or media.
export function createContextObservation() {
  let latest: WebContextObservation | undefined;
  let sequence = 0;
  const clear = () => {
    latest = undefined;
  };
  const extension: InlineExtension = {
    name: "openpi-web-context-observation",
    hidden: true,
    factory(pi) {
      // Leave the observation unavailable if a host lacks full-transcript replay.
      if (
        typeof PiAI.getCurrentSystemPrompt !== "function" ||
        typeof PiAI.getCurrentTools !== "function"
      )
        return;
      pi.on("context_with_system", (event, ctx) => {
        clear();
        const tools = PiAI.getCurrentTools(event.messages);
        const conversation = conversationSize(event.messages);
        latest = {
          source: "context_with_system",
          sequence: ++sequence,
          observedAt: Date.now(),
          sessionId: ctx.sessionManager.getSessionId(),
          ...(ctx.sessionManager.getSessionFile()
            ? { sessionPath: ctx.sessionManager.getSessionFile() }
            : {}),
          ...(ctx.model
            ? { provider: ctx.model.provider, modelId: ctx.model.id }
            : {}),
          systemBytes: Buffer.byteLength(
            PiAI.getCurrentSystemPrompt(event.messages),
            "utf8",
          ),
          toolBytes: Buffer.byteLength(
            JSON.stringify(tools.map(PiAI.toToolDeclaration)),
            "utf8",
          ),
          toolCount: tools.length,
          conversationBytes: conversation.bytes,
          messageCount: conversation.messages,
          omittedBlocks: conversation.omitted,
        };
      });
      pi.on("session_start", clear);
      pi.on("session_compact", clear);
      pi.on("session_tree", clear);
      pi.on("model_select", clear);
      pi.on("session_shutdown", clear);
    },
  };
  return {
    extension,
    read(session: Pick<ExtensionContext, "sessionManager" | "model">) {
      if (
        !latest ||
        latest.sessionId !== session.sessionManager.getSessionId() ||
        latest.sessionPath !== session.sessionManager.getSessionFile() ||
        latest.provider !== session.model?.provider ||
        latest.modelId !== session.model?.id
      )
        return undefined;
      return { ...latest };
    },
  };
}

function conversationSize(messages: AgentMessage[]) {
  let bytes = 0;
  let omitted = 0;
  let count = 0;
  for (const message of messages) {
    if (message.role === "system") continue;
    count++;
    if (!("content" in message)) {
      omitted++;
      continue;
    }
    if (typeof message.content === "string") {
      bytes += Buffer.byteLength(message.content, "utf8");
      continue;
    }
    if (!Array.isArray(message.content)) {
      omitted++;
      continue;
    }
    for (const block of message.content) {
      if (block.type === "text") bytes += Buffer.byteLength(block.text, "utf8");
      else if (block.type === "thinking")
        bytes += Buffer.byteLength(block.thinking, "utf8");
      else if (block.type === "toolCall")
        bytes += Buffer.byteLength(
          JSON.stringify({ name: block.name, arguments: block.arguments }),
          "utf8",
        );
      else omitted++;
    }
  }
  return { bytes, omitted, messages: count };
}
