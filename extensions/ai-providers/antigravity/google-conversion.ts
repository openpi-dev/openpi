/**
 * Google/Cloud Code Assist message conversion used by the Antigravity adapter.
 *
 * Kept local because Pi only exposes its documented runtime modules to loaded
 * extensions; `@earendil-works/pi-ai/api/google-shared` is not one of them.
 * Behavior is adapted from pi-ai 0.84.1's MIT-licensed google-shared converter.
 */

import type {
  Api,
  AssistantMessage,
  Context,
  ImageContent,
  Message,
  Model,
  StopReason,
  Tool,
  ToolCall,
} from "@earendil-works/pi-ai/compat";

const NON_VISION_USER_IMAGE_PLACEHOLDER =
  "(image omitted: model does not support images)";
const NON_VISION_TOOL_IMAGE_PLACEHOLDER =
  "(tool image omitted: model does not support images)";
const BASE64_SIGNATURE_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
const JSON_SCHEMA_META_DECLARATIONS = new Set([
  "$schema",
  "$id",
  "$anchor",
  "$dynamicAnchor",
  "$vocabulary",
  "$comment",
  "$defs",
  "definitions",
]);

interface GoogleFunctionCall {
  id?: string;
  name: string;
  args: Record<string, unknown>;
}

interface GoogleFunctionResponse {
  id?: string;
  name: string;
  response: { output: string } | { error: string };
  parts?: GooglePart[];
}

export interface GooglePart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  inlineData?: { mimeType: string; data: string };
  functionCall?: GoogleFunctionCall;
  functionResponse?: GoogleFunctionResponse;
}

export interface GoogleContent {
  role: "user" | "model";
  parts: GooglePart[];
}

function sanitizeSurrogates(text: string): string {
  return text.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    "",
  );
}

function replaceContentImages(
  content: ({ type: "text"; text: string } | ImageContent)[],
  placeholder: string,
): ({ type: "text"; text: string } | ImageContent)[] {
  const result: ({ type: "text"; text: string } | ImageContent)[] = [];
  let previousWasPlaceholder = false;
  for (const block of content) {
    if (block.type === "image") {
      if (!previousWasPlaceholder) {
        result.push({ type: "text", text: placeholder });
      }
      previousWasPlaceholder = true;
      continue;
    }
    result.push(block);
    previousWasPlaceholder = block.text === placeholder;
  }
  return result;
}

function downgradeUnsupportedImages(
  messages: Message[],
  model: Model<Api>,
): Message[] {
  if (model.input.includes("image")) return messages;
  return messages.map((message) => {
    if (message.role === "user" && Array.isArray(message.content)) {
      return {
        ...message,
        content: replaceContentImages(
          message.content,
          NON_VISION_USER_IMAGE_PLACEHOLDER,
        ),
      };
    }
    if (message.role === "toolResult") {
      return {
        ...message,
        content: replaceContentImages(
          message.content,
          NON_VISION_TOOL_IMAGE_PLACEHOLDER,
        ),
      };
    }
    return message;
  });
}

function normalizeMessageContent(message: Message): Message {
  if (message.content !== null && message.content !== undefined) return message;
  return { ...message, content: [] };
}

function transformMessages(
  messages: Message[],
  model: Model<Api>,
  normalizeToolCallId: (id: string) => string,
): Message[] {
  const toolCallIdMap = new Map<string, string>();
  const normalizedMessages = messages.map(normalizeMessageContent);
  const imageAwareMessages = downgradeUnsupportedImages(
    normalizedMessages,
    model,
  );
  const transformed = imageAwareMessages.map((message): Message => {
    if (message.role === "user") return message;
    if (message.role === "toolResult") {
      const normalizedId = toolCallIdMap.get(message.toolCallId);
      return normalizedId && normalizedId !== message.toolCallId
        ? { ...message, toolCallId: normalizedId }
        : message;
    }

    const isSameModel =
      message.provider === model.provider &&
      message.api === model.api &&
      message.model === model.id;
    const content: AssistantMessage["content"] = [];
    for (const block of message.content) {
      if (block.type === "thinking") {
        if (block.redacted) {
          if (isSameModel) content.push(block);
          continue;
        }
        if (isSameModel && block.thinkingSignature) {
          content.push(block);
          continue;
        }
        if (!block.thinking.trim()) continue;
        content.push(
          isSameModel ? block : { type: "text", text: block.thinking },
        );
        continue;
      }
      if (block.type === "text") {
        content.push(isSameModel ? block : { type: "text", text: block.text });
        continue;
      }

      let normalizedToolCall: ToolCall = block;
      if (!isSameModel && block.thoughtSignature) {
        const { thoughtSignature: _thoughtSignature, ...unsignedToolCall } =
          normalizedToolCall;
        normalizedToolCall = unsignedToolCall;
      }
      if (!isSameModel) {
        const normalizedId = normalizeToolCallId(block.id);
        if (normalizedId !== block.id) {
          toolCallIdMap.set(block.id, normalizedId);
          normalizedToolCall = { ...normalizedToolCall, id: normalizedId };
        }
      }
      content.push(normalizedToolCall);
    }
    return { ...message, content };
  });

  const result: Message[] = [];
  let pendingToolCalls: ToolCall[] = [];
  let existingToolResultIds = new Set<string>();
  const insertSyntheticToolResults = () => {
    for (const toolCall of pendingToolCalls) {
      if (existingToolResultIds.has(toolCall.id)) continue;
      result.push({
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: "text", text: "No result provided" }],
        isError: true,
        timestamp: Date.now(),
      });
    }
    pendingToolCalls = [];
    existingToolResultIds = new Set<string>();
  };

  for (const message of transformed) {
    if (message.role === "assistant") {
      insertSyntheticToolResults();
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        continue;
      }
      pendingToolCalls = message.content.filter(
        (block): block is ToolCall => block.type === "toolCall",
      );
      result.push(message);
      continue;
    }
    if (message.role === "toolResult") {
      existingToolResultIds.add(message.toolCallId);
      result.push(message);
      continue;
    }
    insertSyntheticToolResults();
    result.push(message);
  }
  insertSyntheticToolResults();
  return result;
}

function getGeminiMajorVersion(modelId: string): number | undefined {
  const match = modelId.toLowerCase().match(/^gemini(?:-live)?-(\d+)/);
  return match ? Number.parseInt(match[1], 10) : undefined;
}

function requiresToolCallId(modelId: string): boolean {
  const geminiMajorVersion = getGeminiMajorVersion(modelId);
  return (
    modelId.startsWith("claude-") ||
    modelId.startsWith("gpt-oss-") ||
    (geminiMajorVersion !== undefined && geminiMajorVersion >= 3)
  );
}

function supportsMultimodalFunctionResponse(modelId: string): boolean {
  const geminiMajorVersion = getGeminiMajorVersion(modelId);
  return geminiMajorVersion === undefined || geminiMajorVersion >= 3;
}

function resolveThoughtSignature(
  isSameProviderAndModel: boolean,
  signature: string | undefined,
): string | undefined {
  if (!isSameProviderAndModel || !signature || signature.length % 4 !== 0) {
    return undefined;
  }
  return BASE64_SIGNATURE_PATTERN.test(signature) ? signature : undefined;
}

export function convertMessages(
  model: Model<Api>,
  context: Context,
): GoogleContent[] {
  const contents: GoogleContent[] = [];
  const normalizeToolCallId = (id: string) =>
    requiresToolCallId(model.id)
      ? id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64)
      : id;
  const messages = transformMessages(
    context.messages,
    model,
    normalizeToolCallId,
  );

  for (const message of messages) {
    if (message.role === "user") {
      const parts =
        typeof message.content === "string"
          ? [{ text: sanitizeSurrogates(message.content) }]
          : message.content.map(
              (item): GooglePart =>
                item.type === "text"
                  ? { text: sanitizeSurrogates(item.text) }
                  : {
                      inlineData: {
                        mimeType: item.mimeType,
                        data: item.data,
                      },
                    },
            );
      if (parts.length > 0) contents.push({ role: "user", parts });
      continue;
    }

    if (message.role === "assistant") {
      const parts: GooglePart[] = [];
      const isSameProviderAndModel =
        message.provider === model.provider && message.model === model.id;
      for (const block of message.content) {
        if (block.type === "text") {
          const thoughtSignature = resolveThoughtSignature(
            isSameProviderAndModel,
            block.textSignature,
          );
          if (!block.text.trim() && !thoughtSignature) continue;
          parts.push({
            text: sanitizeSurrogates(block.text),
            ...(thoughtSignature ? { thoughtSignature } : {}),
          });
          continue;
        }
        if (block.type === "thinking") {
          if (!isSameProviderAndModel) {
            if (block.thinking.trim()) {
              parts.push({ text: sanitizeSurrogates(block.thinking) });
            }
            continue;
          }
          const thoughtSignature = resolveThoughtSignature(
            true,
            block.thinkingSignature,
          );
          if (!block.thinking.trim() && !thoughtSignature) continue;
          parts.push({
            thought: true,
            text: sanitizeSurrogates(block.thinking),
            ...(thoughtSignature ? { thoughtSignature } : {}),
          });
          continue;
        }

        const thoughtSignature = resolveThoughtSignature(
          isSameProviderAndModel,
          block.thoughtSignature,
        );
        parts.push({
          functionCall: {
            name: block.name,
            args: block.arguments ?? {},
            ...(requiresToolCallId(model.id) ? { id: block.id } : {}),
          },
          ...(thoughtSignature ? { thoughtSignature } : {}),
        });
      }
      if (parts.length > 0) contents.push({ role: "model", parts });
      continue;
    }

    const textResult = message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    const imageContent = model.input.includes("image")
      ? message.content.filter(
          (part): part is ImageContent => part.type === "image",
        )
      : [];
    const hasImages = imageContent.length > 0;
    const responseValue = textResult
      ? sanitizeSurrogates(textResult)
      : hasImages
        ? "(see attached image)"
        : "";
    const imageParts: GooglePart[] = imageContent.map((image) => ({
      inlineData: { mimeType: image.mimeType, data: image.data },
    }));
    const supportsMultimodal = supportsMultimodalFunctionResponse(model.id);
    const functionResponsePart: GooglePart = {
      functionResponse: {
        name: message.toolName,
        response: message.isError
          ? { error: responseValue }
          : { output: responseValue },
        ...(hasImages && supportsMultimodal ? { parts: imageParts } : {}),
        ...(requiresToolCallId(model.id) ? { id: message.toolCallId } : {}),
      },
    };
    const lastContent = contents.at(-1);
    if (
      lastContent?.role === "user" &&
      lastContent.parts.some((part) => part.functionResponse)
    ) {
      lastContent.parts.push(functionResponsePart);
    } else {
      contents.push({ role: "user", parts: [functionResponsePart] });
    }
    if (hasImages && !supportsMultimodal) {
      contents.push({
        role: "user",
        parts: [{ text: "Tool result image:" }, ...imageParts],
      });
    }
  }
  return contents;
}

function sanitizeForOpenApi(
  schema: unknown,
  insidePropertiesMap = false,
): unknown {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    return schema;
  }
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (insidePropertiesMap) {
      result[key] = sanitizeForOpenApi(value);
      continue;
    }
    if (!JSON_SCHEMA_META_DECLARATIONS.has(key)) {
      result[key] = sanitizeForOpenApi(value, key === "properties");
    }
  }
  return result;
}

export function convertTools(
  tools: Tool[],
  useParameters = false,
): { functionDeclarations: Record<string, unknown>[] }[] | undefined {
  if (tools.length === 0) return undefined;
  return [
    {
      functionDeclarations: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        ...(useParameters
          ? { parameters: sanitizeForOpenApi(tool.parameters) }
          : { parametersJsonSchema: tool.parameters }),
      })),
    },
  ];
}

export function isThinkingPart(part: {
  thought?: boolean;
  thoughtSignature?: string;
}): boolean {
  return part.thought === true;
}

export function retainThoughtSignature(
  existing: string | undefined,
  incoming: string | undefined,
): string | undefined {
  return typeof incoming === "string" && incoming.length > 0
    ? incoming
    : existing;
}

export function mapStopReasonString(reason: string): StopReason {
  if (reason === "STOP") return "stop";
  if (reason === "MAX_TOKENS") return "length";
  return "error";
}
