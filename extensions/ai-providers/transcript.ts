/**
 * Transcript resolution shared by the opt-in AI providers.
 *
 * Pi 0.86.0 changed the input handed to a custom provider's stream from `Context`
 * to a normalized `TranscriptContext`: `systemPrompt` and `tools` are folded into
 * a leading transcript system message, and later system messages carry prompt and
 * tool deltas. Pi <= 0.85.1 still passes those two fields directly.
 *
 * Both shapes have to work from one implementation. OpenPI's published peer range
 * (`>=0.85.1`) admits 0.86+, while the locked development baseline is still
 * 0.85.1, so a provider that only reads `context.systemPrompt` / `context.tools`
 * silently degrades to an empty system prompt and zero tool declarations on 0.86+
 * — and, for converters that treat unknown roles as tool results, to an invalid
 * `functionResponse` as well.
 *
 * The replay below mirrors Pi's `getCurrentSystemMessage` / `getCurrentTools`
 * behavior without importing them: those helpers do not exist before Pi 0.86.
 */

import type { Context, Message, Tool } from "@earendil-works/pi-ai/compat";

/** Transcript system message as emitted by Pi 0.86+ (`TranscriptContext`). */
export interface TranscriptSystemMessage {
  role: "system";
  content?: string | { type: "text"; text: string }[];
  sections?: Record<string, string | null>;
  toolsAdded?: Tool[];
  toolsRemoved?: { name: string }[];
  timestamp?: number;
}

type TranscriptMessage = Message | TranscriptSystemMessage;

export interface ResolvedTranscript {
  /**
   * Which input shape produced this result. `context` means Pi <= 0.85.1 passed
   * `systemPrompt` / `tools` as separate fields and nothing had to be replayed.
   */
  source: "context" | "transcript";
  /** System prompts in wire order; empty when the transcript declares none. */
  systemPrompts: string[];
  /** Tool declarations in effect at the end of the transcript. */
  tools: Tool[] | undefined;
  /** Conversation messages, with every transcript system message removed. */
  messages: Message[];
}

function isSystemMessage(
  message: TranscriptMessage,
): message is TranscriptSystemMessage {
  return message.role === "system";
}

function textFromContent(content: TranscriptSystemMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function normalizeSystemPrompts(
  systemPrompt: Context["systemPrompt"],
): string[] {
  if (!systemPrompt) return [];
  return Array.isArray(systemPrompt) ? systemPrompt : [systemPrompt];
}

/**
 * Replay a transcript into the system prompt and tool set currently in effect.
 *
 * Later system messages patch earlier ones: `sections` are replaced by name (a
 * `null` value removes the section), and tool deltas are applied in order.
 */
export function resolveTranscript(context: Context): ResolvedTranscript {
  const messages = context.messages as unknown as TranscriptMessage[];
  const systemMessages = messages.filter(isSystemMessage);
  if (systemMessages.length === 0) {
    return {
      source: "context",
      systemPrompts: normalizeSystemPrompts(context.systemPrompt),
      tools: context.tools,
      messages: context.messages,
    };
  }

  const promptParts: string[] = [];
  const sections = new Map<string, string>();
  const tools = new Map<string, Tool>();
  for (const message of systemMessages) {
    const text = textFromContent(message.content);
    if (text.length > 0) promptParts.push(text);
    for (const [name, value] of Object.entries(message.sections ?? {})) {
      if (value === null) sections.delete(name);
      else sections.set(name, value);
    }
    for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
    for (const tool of message.toolsAdded ?? []) tools.set(tool.name, tool);
  }
  for (const value of sections.values()) {
    if (value.length > 0) promptParts.push(value);
  }

  return {
    source: "transcript",
    systemPrompts: promptParts.length > 0 ? [promptParts.join("\n\n")] : [],
    tools: tools.size > 0 ? [...tools.values()] : undefined,
    messages: messages.filter(
      (message): message is Message => !isSystemMessage(message),
    ),
  };
}

/**
 * Adapt either input shape to the `Context` a provider already understands.
 *
 * Returns the original context untouched on Pi <= 0.85.1, so existing behavior is
 * preserved exactly; on 0.86+ it re-materializes the folded fields.
 */
export function applyTranscript(context: Context): Context {
  const resolved = resolveTranscript(context);
  if (resolved.source === "context") return context;
  return {
    ...context,
    systemPrompt:
      resolved.systemPrompts.length > 0
        ? resolved.systemPrompts.join("\n\n")
        : undefined,
    tools: resolved.tools,
    messages: resolved.messages,
  };
}
