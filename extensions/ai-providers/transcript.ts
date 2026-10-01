/** Project Pi's transcript into the wire fields used by the opt-in providers. */
import {
  type Context,
  getCurrentSystemPrompt,
  getCurrentTools,
  normalizeContext,
} from "@earendil-works/pi-ai";

export function resolveTranscript(context: Context) {
  const { messages } = normalizeContext(context);
  const systemPrompt = getCurrentSystemPrompt(messages);
  const tools = getCurrentTools(messages);
  return {
    systemPrompts: systemPrompt ? [systemPrompt] : [],
    tools: tools.length > 0 ? tools : undefined,
    messages: messages.filter((message) => message.role !== "system"),
  };
}

export function applyTranscript(context: Context): Context {
  const resolved = resolveTranscript(context);
  return {
    systemPrompt: resolved.systemPrompts[0],
    tools: resolved.tools,
    messages: resolved.messages,
  };
}
