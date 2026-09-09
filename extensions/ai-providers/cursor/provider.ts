import { createHash, randomUUID } from "node:crypto";
import * as http2 from "node:http2";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  ImageContent,
  Message,
  Model,
  SimpleStreamOptions,
  TextContent,
  ToolCall,
} from "@earendil-works/pi-ai/compat";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import { emptyUsage } from "../usage.ts";
import { ConnectFrameReader } from "./connect-frame-reader.ts";
import {
  CURSOR_API_URL,
  CURSOR_CLIENT_VERSION,
  CURSOR_RUN_PATH,
} from "./constants.ts";
import {
  AgentClientMessageSchema,
  AgentConversationTurnStructureSchema,
  type AgentRunRequest,
  AgentRunRequestSchema,
  AgentServerMessageSchema,
  AssistantMessageSchema,
  ClientHeartbeatSchema,
  ConversationActionSchema,
  type ConversationStateStructure,
  ConversationStateStructureSchema,
  ConversationStepSchema,
  ConversationTurnStructureSchema,
  type CursorRule,
  CursorRuleSchema,
  CursorRuleTypeGlobalSchema,
  CursorRuleTypeSchema,
  CursorToolCallSchema,
  ExecClientControlMessageSchema,
  ExecClientMessageSchema,
  ExecClientStreamCloseSchema,
  ExecClientThrowSchema,
  GetBlobResultSchema,
  type InteractionUpdate,
  KvClientMessageSchema,
  type KvServerMessage,
  KvServerMessageSchema,
  McpArgsSchema,
  McpImageContentSchema,
  McpRejectedSchema,
  McpResultSchema,
  McpSuccessSchema,
  McpTextContentSchema,
  McpToolCallSchema,
  McpToolResultContentItemSchema,
  McpToolResultSchema,
  type ModelDetails,
  ModelDetailsSchema,
  RequestContextResultSchema,
  RequestContextSchema,
  RequestContextSuccessSchema,
  type RequestedModel_ModelParameterbytes,
  RequestedModel_ModelParameterbytesSchema,
  RequestedModelSchema,
  ResumeActionSchema,
  SelectedContextSchema,
  SelectedImageSchema,
  SetBlobResultSchema,
  UserMessageActionSchema,
  UserMessageSchema,
} from "./proto.ts";
import { create, encodeJsonValue, fromBinary, toBinary } from "./protobuf.ts";
import { connectCursorHttp2 } from "./proxy.ts";
import {
  buildCursorTools,
  CURSOR_PI_PROVIDER,
  CURSOR_PI_TOOLS_SYSTEM_PROMPT,
  decodeCursorTool,
} from "./tool-bridge.ts";

const CONNECT_END_STREAM_FLAG = 0b00000010;
const CONNECT_COMPRESSED_FLAG = 0b00000001;
const MAX_CONNECT_FRAME_BYTES = 16 * 1024 * 1024;
const HEARTBEAT_INTERVAL_MS = 5_000;
const PROXY_TUNNEL_TIMEOUT_MS = 30_000;
const MAX_NATIVE_EXEC_REJECTIONS = 3;

export const CURSOR_CHAT_ONLY_SYSTEM_PROMPT =
  "This Cursor provider is running in chat-only mode. No filesystem, shell, code modification, MCP, web, or user-interaction tools are available. Never emit tool calls or interaction queries. Images attached to the user message are already available for direct analysis. If required information is unavailable, explain the limitation in text instead of attempting a tool.";

const HTTP2_FORBIDDEN_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "upgrade",
  "http2-settings",
]);

const CURSOR_RESERVED_HEADERS = new Set([
  "content-type",
  "connect-protocol-version",
  "te",
  "authorization",
  "x-ghost-mode",
  "x-cursor-client-version",
  "x-cursor-client-type",
  "x-request-id",
  "host",
  "content-length",
]);

type CursorBlobStore = Map<string, Uint8Array>;

export interface CursorRequestBuild {
  request: AgentRunRequest;
  requestBytes: Uint8Array;
  blobStore: CursorBlobStore;
  conversationState: ConversationStateStructure;
}

/** Connect's five-byte big-endian envelope. */
export function frameConnectMessage(data: Uint8Array, flags = 0): Buffer {
  const frame = Buffer.allocUnsafe(5 + data.length);
  frame[0] = flags;
  frame.writeUInt32BE(data.length, 1);
  frame.set(data, 5);
  return frame;
}

function createBlobId(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(data).digest());
}

function storeBlob(store: CursorBlobStore, data: Uint8Array): Uint8Array {
  const id = createBlobId(data);
  store.set(Buffer.from(id).toString("hex"), data);
  return id;
}

function textFromContent(
  content: string | (TextContent | ImageContent)[],
): string {
  if (typeof content === "string") return content.trim();
  return content
    .filter((item): item is TextContent => item.type === "text")
    .map((item) => item.text)
    .join("\n")
    .trim();
}

function imagesFromContent(content: string | (TextContent | ImageContent)[]) {
  if (typeof content === "string") return [];
  return content
    .filter((item): item is ImageContent => item.type === "image")
    .map((item) =>
      create(SelectedImageSchema, {
        uuid: randomUUID(),
        path: "",
        mimeType: item.mimeType,
        dataOrBlobId: {
          case: "data",
          value: Uint8Array.from(Buffer.from(item.data, "base64")),
        },
      }),
    );
}

function userMessageFromContent(
  content: string | (TextContent | ImageContent)[],
  messageId = randomUUID(),
) {
  const text = textFromContent(content);
  const images = imagesFromContent(content);
  return create(UserMessageSchema, {
    text,
    messageId,
    ...(images.length > 0
      ? {
          selectedContext: create(SelectedContextSchema, {
            selectedImages: images,
          }),
        }
      : {}),
  });
}

function rootPromptContent(
  content: string | (TextContent | ImageContent)[],
): Array<
  | { type: "text"; text: string }
  | { type: "image"; image: string; mediaType: string }
> {
  if (typeof content === "string") {
    const text = content.trim();
    return text ? [{ type: "text", text }] : [];
  }
  const parts: Array<
    | { type: "text"; text: string }
    | { type: "image"; image: string; mediaType: string }
  > = [];
  for (const item of content) {
    if (item.type === "text") {
      const text = item.text.trim();
      if (text) parts.push({ type: "text", text });
    } else {
      parts.push({
        type: "image",
        image: `data:${item.mimeType};base64,${item.data}`,
        mediaType: item.mimeType,
      });
    }
  }
  return parts;
}

function assistantRootContent(
  message: Extract<Message, { role: "assistant" }>,
  results: Map<string, Extract<Message, { role: "toolResult" }>>,
) {
  const content: Array<Record<string, unknown>> = [];
  for (const item of message.content) {
    if (item.type === "text" && item.text) {
      content.push({ type: "text", text: item.text });
    } else if (
      item.type === "toolCall" &&
      results.get(item.id)?.toolName === item.name
    ) {
      content.push({
        type: "tool-call",
        toolCallId: item.id,
        toolName: item.name,
        args: item.arguments,
      });
    }
  }
  return content;
}

function pairedToolResults(messages: Message[], end: number) {
  const calls = new Map<string, string>();
  const results = new Map<string, Extract<Message, { role: "toolResult" }>>();
  for (const message of messages.slice(0, end < 0 ? undefined : end)) {
    if (message.role === "assistant") {
      for (const part of message.content)
        if (part.type === "toolCall") calls.set(part.id, part.name);
    } else if (
      message.role === "toolResult" &&
      calls.get(message.toolCallId) === message.toolName
    ) {
      results.set(message.toolCallId, message);
    }
  }
  return results;
}

function buildHistoryRootPrompt(
  messages: Message[],
  store: CursorBlobStore,
  activeUserIndex: number,
): Uint8Array[] {
  const entries: Uint8Array[] = [];
  const results = pairedToolResults(messages, activeUserIndex);
  for (let index = 0; index < messages.length; index++) {
    if (index === activeUserIndex) break;
    const message = messages[index];
    let value: unknown;
    if (message.role === "user") {
      const content = rootPromptContent(message.content);
      if (content.length === 0) continue;
      value = { role: "user", content };
    } else if (message.role === "assistant") {
      const content = assistantRootContent(message, results);
      if (content.length === 0) continue;
      value = { role: "assistant", content };
    } else {
      if (results.get(message.toolCallId) !== message) continue;
      value = {
        role: "tool",
        id: message.toolCallId,
        content: [
          {
            type: "tool-result",
            toolCallId: message.toolCallId,
            toolName: message.toolName,
            result: message.content.some((part) => part.type === "image")
              ? rootPromptContent(message.content)
              : message.content
                  .filter((part) => part.type === "text")
                  .map((part) => part.text)
                  .join("\n"),
            ...(message.isError ? { isError: true } : {}),
          },
        ],
      };
    }
    entries.push(
      storeBlob(store, new TextEncoder().encode(JSON.stringify(value))),
    );
  }
  return entries;
}

function buildSystemPrompt(
  systemPrompt: Context["systemPrompt"],
  store: CursorBlobStore,
  hasTools = false,
): Uint8Array[] {
  const prompts = systemPrompt
    ? Array.isArray(systemPrompt)
      ? systemPrompt
      : [systemPrompt]
    : ["You are a helpful assistant."];
  return [
    ...prompts,
    hasTools ? CURSOR_PI_TOOLS_SYSTEM_PROMPT : CURSOR_CHAT_ONLY_SYSTEM_PROMPT,
  ].map((prompt) =>
    storeBlob(
      store,
      new TextEncoder().encode(
        JSON.stringify({ role: "system", content: prompt }),
      ),
    ),
  );
}

/**
 * Cursor asks for these rules over the exec channel before generating text.
 * These rules keep Cursor-native tools disabled. The request-context response
 * advertises only the active Pi tools through the MCP protocol bridge.
 */
export function buildCursorRequestContextRules(
  systemPrompt: Context["systemPrompt"],
  hasTools = false,
): CursorRule[] {
  const rules: CursorRule[] = systemPrompt?.trim()
    ? [
        create(CursorRuleSchema, {
          fullPath: "/pi/system-prompt.mdc",
          content: systemPrompt,
          source: 2,
          type: create(CursorRuleTypeSchema, {
            type: {
              case: "global",
              value: create(CursorRuleTypeGlobalSchema, {}),
            },
          }),
        }),
      ]
    : [];
  rules.push(
    create(CursorRuleSchema, {
      fullPath: hasTools ? "/pi/cursor-tools.mdc" : "/pi/cursor-chat-only.mdc",
      content: hasTools
        ? CURSOR_PI_TOOLS_SYSTEM_PROMPT
        : CURSOR_CHAT_ONLY_SYSTEM_PROMPT,
      source: 2,
      type: create(CursorRuleTypeSchema, {
        type: { case: "global", value: create(CursorRuleTypeGlobalSchema, {}) },
      }),
    }),
  );
  return rules;
}

function buildHistoryTurns(
  messages: Message[],
  store: CursorBlobStore,
  activeUserIndex: number,
): Uint8Array[] {
  const turns: Uint8Array[] = [];
  const results = pairedToolResults(messages, activeUserIndex);
  const end = activeUserIndex >= 0 ? activeUserIndex : messages.length;
  let index = 0;
  while (index < end) {
    const user = messages[index];
    if (user.role !== "user") {
      index++;
      continue;
    }
    const userMessage = storeBlob(
      store,
      toBinary(UserMessageSchema, userMessageFromContent(user.content)),
    );
    const steps: Uint8Array[] = [];
    index++;
    while (index < end && messages[index]?.role !== "user") {
      const message = messages[index];
      if (message.role === "assistant") {
        for (const item of message.content) {
          if (item.type === "text" && item.text) {
            steps.push(
              storeBlob(
                store,
                toBinary(
                  ConversationStepSchema,
                  create(ConversationStepSchema, {
                    message: {
                      case: "assistantMessage",
                      value: create(AssistantMessageSchema, {
                        text: item.text,
                      }),
                    },
                  }),
                ),
              ),
            );
          } else if (item.type === "toolCall") {
            const result = results.get(item.id);
            if (!result || result.toolName !== item.name) continue;
            const args = Object.fromEntries(
              Object.entries(item.arguments).map(([key, value]) => [
                key,
                encodeJsonValue(JSON.parse(JSON.stringify(value))),
              ]),
            );
            const tool = create(CursorToolCallSchema, {
              toolCallId: item.id,
              tool: {
                case: "mcpToolCall",
                value: create(McpToolCallSchema, {
                  args: create(McpArgsSchema, {
                    name: item.name,
                    toolName: item.name,
                    providerIdentifier: CURSOR_PI_PROVIDER,
                    toolCallId: item.id,
                    args,
                  }),
                  result: create(McpToolResultSchema, {
                    result: {
                      case: "success",
                      value: create(McpSuccessSchema, {
                        isError: result.isError,
                        content: result.content.map((part) =>
                          create(McpToolResultContentItemSchema, {
                            content:
                              part.type === "text"
                                ? {
                                    case: "text",
                                    value: create(McpTextContentSchema, {
                                      text: part.text,
                                    }),
                                  }
                                : {
                                    case: "image",
                                    value: create(McpImageContentSchema, {
                                      data: Buffer.from(part.data, "base64"),
                                      mimeType: part.mimeType,
                                    }),
                                  },
                          }),
                        ),
                      }),
                    },
                  }),
                }),
              },
            });
            steps.push(
              storeBlob(
                store,
                toBinary(
                  ConversationStepSchema,
                  create(ConversationStepSchema, {
                    message: { case: "toolCall", value: tool },
                  }),
                ),
              ),
            );
          }
        }
      }
      index++;
    }
    const turn = create(ConversationTurnStructureSchema, {
      turn: {
        case: "agentConversationTurn",
        value: create(AgentConversationTurnStructureSchema, {
          userMessage,
          steps,
        }),
      },
    });
    turns.push(
      storeBlob(store, toBinary(ConversationTurnStructureSchema, turn)),
    );
  }
  return turns;
}

function lastUserIndex(messages: Message[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    const role = messages[index]?.role;
    if (role === "user") return index;
  }
  return -1;
}

type CursorModelWithOptions = Model<Api> & { cursorMaxMode?: boolean };

function hasCursorMaxMode(model: Model<Api>): model is CursorModelWithOptions {
  return Object.hasOwn(model, "cursorMaxMode");
}

function cursorMaxMode(model: Model<Api>): boolean {
  return hasCursorMaxMode(model) && model.cursorMaxMode === true;
}

function resolveWireModel(model: Model<Api>): {
  modelId: string;
  parameters: RequestedModel_ModelParameterbytes[];
} {
  const id = model.id;
  // Cursor resolves the bare Composer 2.5 id to its Fast lane unless the
  // Standard tier is requested explicitly.
  if (id === "composer-2.5") {
    return {
      modelId: id,
      parameters: [
        create(RequestedModel_ModelParameterbytesSchema, {
          id: "fast",
          value: "false",
        }),
      ],
    };
  }
  const match = /^(.*)-(minimal|low|medium|high|xhigh|max)(-fast)?$/.exec(id);
  if (!match?.[1] || !/(?:gpt|codex|o\d)/i.test(match[1])) {
    return { modelId: id, parameters: [] };
  }
  return {
    modelId: `${match[1]}${match[3] ?? ""}`,
    parameters: [
      create(RequestedModel_ModelParameterbytesSchema, {
        id: "reasoning",
        value: match[2]!,
      }),
    ],
  };
}

/** Build the protobuf Run request and retain blobs for the same Connect stream. */
export async function buildCursorRequest(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): Promise<CursorRequestBuild> {
  const store: CursorBlobStore = new Map();
  const activeIndex =
    context.messages.at(-1)?.role === "user"
      ? lastUserIndex(context.messages)
      : -1;
  const active = activeIndex >= 0 ? context.messages[activeIndex] : undefined;
  const activeContent = active?.role === "user" ? active.content : undefined;
  const rootPromptMessagesJson = [
    ...buildSystemPrompt(context.systemPrompt, store, !!context.tools?.length),
    ...buildHistoryRootPrompt(context.messages, store, activeIndex),
  ];
  const state = create(ConversationStateStructureSchema, {
    rootPromptMessagesJson,
    turns: buildHistoryTurns(context.messages, store, activeIndex),
    pendingToolCalls: [],
  });
  const conversationId = options?.sessionId ?? randomUUID();
  const action = create(ConversationActionSchema, {
    action:
      activeContent !== undefined &&
      (textFromContent(activeContent).length > 0 ||
        imagesFromContent(activeContent).length > 0)
        ? {
            case: "userMessageAction",
            value: create(UserMessageActionSchema, {
              userMessage: userMessageFromContent(activeContent),
            }),
          }
        : { case: "resumeAction", value: create(ResumeActionSchema, {}) },
  });
  const wire = resolveWireModel(model);
  let request = create(AgentRunRequestSchema, {
    conversationState: state,
    action,
    modelDetails: create(ModelDetailsSchema, {
      modelId: wire.modelId,
      displayModelId: model.id,
      displayName: model.name,
      displayNameShort: model.name,
      aliases: [],
      ...(cursorMaxMode(model) ? { maxMode: true } : {}),
    }),
    requestedModel: create(RequestedModelSchema, {
      modelId: wire.modelId,
      maxMode: cursorMaxMode(model),
      parameters: wire.parameters,
    }),
    conversationId,
  });
  const replacement = await options?.onPayload?.(request, model);
  if (replacement !== undefined) request = replacement as AgentRunRequest;
  const clientMessage = create(AgentClientMessageSchema, {
    message: { case: "runRequest", value: request },
  });
  return {
    request,
    requestBytes: toBinary(AgentClientMessageSchema, clientMessage),
    blobStore: store,
    conversationState: state,
  };
}

function sanitizeCallerHeaders(
  headers: SimpleStreamOptions["headers"],
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (value === null) continue;
    const field = name.toLowerCase();
    if (field.startsWith(":")) continue;
    if (
      HTTP2_FORBIDDEN_HEADERS.has(field) ||
      CURSOR_RESERVED_HEADERS.has(field)
    )
      continue;
    result[field] = value;
  }
  return result;
}

function cursorHeaders(
  apiKey: string,
  options: SimpleStreamOptions | undefined,
): Record<string, string> {
  return {
    ...sanitizeCallerHeaders(options?.headers),
    ":method": "POST",
    ":path": CURSOR_RUN_PATH,
    "content-type": "application/connect+proto",
    "connect-protocol-version": "1",
    te: "trailers",
    authorization: `Bearer ${apiKey}`,
    "x-ghost-mode": "true",
    "x-cursor-client-version": CURSOR_CLIENT_VERSION,
    "x-cursor-client-type": "cli",
    "x-request-id": randomUUID(),
  };
}

function headerRecord(
  headers: http2.IncomingHttpHeaders,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") result[key] = value;
    else if (Array.isArray(value)) result[key] = value.join(", ");
  }
  return result;
}

function errorFromEndStream(data: Uint8Array): Error | undefined {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(data));
    if (parsed && typeof parsed === "object" && "error" in parsed) {
      const error = parsed.error;
      if (error && typeof error === "object") {
        const message =
          "message" in error && typeof error.message === "string"
            ? error.message
            : "Cursor Connect error";
        const code =
          "code" in error && typeof error.code === "string"
            ? error.code
            : "unknown";
        return new Error(`Connect error ${code}: ${message}`);
      }
    }
    return undefined;
  } catch {
    return new Error("Failed to parse Cursor Connect end-stream envelope");
  }
}

/** Cursor AgentService/Run with Pi-owned tool execution across provider turns. */
export function streamCursor(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  (async () => {
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: emptyUsage(),
      stopReason: "pending",
      timestamp: Date.now(),
    };
    let h2Client: http2.ClientHttp2Session | undefined;
    let h2Request: http2.ClientHttp2Stream | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let removeAbortListener: (() => void) | undefined;
    let currentText:
      | Extract<AssistantMessage["content"][number], { type: "text" }>
      | undefined;
    let currentThinking:
      | Extract<AssistantMessage["content"][number], { type: "thinking" }>
      | undefined;
    let turnEnded = false;
    let terminalError: Error | undefined;
    let finished = false;
    const pendingCalls = new Map<string, ToolCall>();
    let handingOffTools = false;
    let nativeExecRejections = 0;

    const closeBlocks = () => {
      if (currentText) {
        const index = output.content.indexOf(currentText);
        stream.push({
          type: "text_end",
          contentIndex: index,
          content: currentText.text,
          partial: output,
        });
        currentText = undefined;
      }
      if (currentThinking) {
        const index = output.content.indexOf(currentThinking);
        stream.push({
          type: "thinking_end",
          contentIndex: index,
          content: currentThinking.thinking,
          partial: output,
        });
        currentThinking = undefined;
      }
    };

    const finishError = (error: unknown) => {
      if (finished) return;
      finished = true;
      closeBlocks();
      // Peer resets and server cancellation messages are transport failures.
      // Only the caller's signal establishes a locally requested interruption.
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage =
        error instanceof Error ? error.message : String(error);
      stream.push({
        type: "error",
        reason: output.stopReason,
        error: output,
      });
      stream.end();
    };

    try {
      const apiKey = options?.apiKey?.trim();
      if (!apiKey)
        throw new Error("Cursor API key is required — run /login cursor");
      if (options?.fetch) {
        throw new Error(
          "Cursor uses an HTTP/2 transport and does not support options.fetch",
        );
      }
      if (options?.signal?.aborted) throw new Error("Cursor request aborted");
      const timeoutMs = options?.timeoutMs;
      if (
        timeoutMs !== undefined &&
        (!Number.isFinite(timeoutMs) || timeoutMs < 0)
      ) {
        throw new Error(`Invalid timeoutMs: ${String(timeoutMs)}`);
      }
      const requestTimeoutMs =
        timeoutMs === undefined || timeoutMs === 0
          ? undefined
          : Math.max(1, Math.floor(timeoutMs));
      const built = await buildCursorRequest(model, context, options);
      const baseUrl = model.baseUrl || CURSOR_API_URL;
      const completion = Promise.withResolvers<void>();
      let completionSettled = false;
      const settle = (error?: unknown) => {
        if (completionSettled) return;
        completionSettled = true;
        if (error !== undefined) completion.reject(error);
        else if (terminalError) completion.reject(terminalError);
        else if (!turnEnded)
          completion.reject(new Error("Cursor stream ended before turnEnded"));
        else completion.resolve();
      };
      // Abort can reject completion while we are still awaiting response
      // headers; keep the rejection observed so Node does not report it as
      // unhandled when the catch path never reaches `await completion.promise`.
      void completion.promise.catch(() => {});
      const responseReady = Promise.withResolvers<void>();
      let responseSeen = false;
      let responseStatus = 0;
      let responseHeaders: Record<string, string> = {};
      let responseReadySettled = false;
      const rejectResponseReady = (error: unknown) => {
        if (responseReadySettled) return;
        responseReadySettled = true;
        responseReady.reject(error);
      };
      const resolveResponseReady = () => {
        if (responseReadySettled) return;
        responseReadySettled = true;
        responseReady.resolve();
      };
      const clearIdleTimer = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = undefined;
      };
      const armIdleTimer = () => {
        clearIdleTimer();
        if (requestTimeoutMs === undefined) return;
        idleTimer = setTimeout(() => {
          const error = new Error(
            `Cursor request idle timeout after ${requestTimeoutMs}ms`,
          );
          rejectResponseReady(error);
          settle(error);
          h2Request?.close(http2.constants.NGHTTP2_CANCEL);
        }, requestTimeoutMs);
      };
      const frames = new ConnectFrameReader(MAX_CONNECT_FRAME_BYTES);
      const processFrame = (flags: number, bytes: Uint8Array) => {
        if (handingOffTools || terminalError) return;
        if ((flags & CONNECT_COMPRESSED_FLAG) !== 0) {
          throw new Error("Compressed Cursor Connect frames are unsupported");
        }
        if ((flags & CONNECT_END_STREAM_FLAG) !== 0) {
          terminalError = errorFromEndStream(bytes);
          if (terminalError) {
            // Preserve the server's error before close emits an aborted event.
            settle(terminalError);
            h2Request?.close();
          }
          return;
        }
        const message = fromBinary(AgentServerMessageSchema, bytes);
        if (message.message.case === "execServerMessage") {
          const exec = message.message.value;
          if (exec.message.case === "requestContextArgs") {
            const result = create(RequestContextResultSchema, {
              result: {
                case: "success",
                value: create(RequestContextSuccessSchema, {
                  requestContext: create(RequestContextSchema, {
                    rules: buildCursorRequestContextRules(
                      context.systemPrompt,
                      !!context.tools?.length,
                    ),
                    tools: buildCursorTools(context.tools),
                  }),
                }),
              },
            });
            const response = create(ExecClientMessageSchema, {
              id: exec.id,
              execId: exec.execId,
              message: { case: "requestContextResult", value: result },
            });
            const envelope = create(AgentClientMessageSchema, {
              message: { case: "execClientMessage", value: response },
            });
            h2Request?.write(
              frameConnectMessage(toBinary(AgentClientMessageSchema, envelope)),
            );
            return;
          }
          if (exec.message.case === "mcpArgs") {
            const args = exec.message.value;
            if (args.smartModeApprovalOnly) {
              // A probe must not become a tool call or preauthorize Pi execution.
              const reply = create(AgentClientMessageSchema, {
                message: {
                  case: "execClientMessage",
                  value: create(ExecClientMessageSchema, {
                    id: exec.id,
                    execId: exec.execId,
                    message: {
                      case: "mcpResult",
                      value: create(McpResultSchema, {
                        result: {
                          case: "rejected",
                          value: create(McpRejectedSchema, {
                            reason:
                              "Pi must evaluate permissions when executing the tool; approval-only probes cannot authorize execution.",
                          }),
                        },
                      }),
                    },
                  }),
                },
              });
              h2Request?.write(
                frameConnectMessage(toBinary(AgentClientMessageSchema, reply)),
              );
              return;
            }
            const call = decodeCursorTool(args, context.tools);
            if (
              context.messages.some((message) =>
                message.role === "toolResult"
                  ? message.toolCallId === call.id
                  : message.role === "assistant" &&
                    message.content.some(
                      (part) => part.type === "toolCall" && part.id === call.id,
                    ),
              )
            ) {
              throw new Error(
                "Cursor attempted to replay a tool call identity already present in Pi history",
              );
            }
            const previous = pendingCalls.get(call.id);
            if (previous && JSON.stringify(previous) !== JSON.stringify(call)) {
              throw new Error(
                "Cursor repeated a tool call identity with different arguments",
              );
            }
            pendingCalls.set(call.id, call);
            return;
          }
          const throwReply = create(AgentClientMessageSchema, {
            message: {
              case: "execClientControlMessage",
              value: create(ExecClientControlMessageSchema, {
                message: {
                  case: "throw",
                  value: create(ExecClientThrowSchema, {
                    id: exec.id,
                    error: context.tools?.length
                      ? "Cursor-native execution is unavailable; use advertised Pi MCP tools"
                      : "Cursor tools are not available in this chat-only provider",
                    errorCode: "UNIMPLEMENTED",
                  }),
                },
              }),
            },
          });
          const closeReply = create(AgentClientMessageSchema, {
            message: {
              case: "execClientControlMessage",
              value: create(ExecClientControlMessageSchema, {
                message: {
                  case: "streamClose",
                  value: create(ExecClientStreamCloseSchema, { id: exec.id }),
                },
              }),
            },
          });
          const error = new Error(
            context.tools?.length
              ? "Cursor requested unsupported native execution outside Pi"
              : "Cursor requested a tool that is unavailable in chat-only mode",
          );
          if (!h2Request) {
            settle(error);
            return;
          }
          // Like OMP's sendExecClientThrow, reject this exec frame in band.
          // streamClose closes the rejected exec, not AgentService/Run: the
          // model may recover by requesting one of the advertised Pi tools.
          const recover =
            Boolean(context.tools?.length) &&
            ++nativeExecRejections <= MAX_NATIVE_EXEC_REJECTIONS;
          if (!recover) {
            terminalError = context.tools?.length
              ? new Error(
                  `Cursor native execution recovery limit (${MAX_NATIVE_EXEC_REJECTIONS}) exceeded; last exec id ${exec.id}`,
                )
              : error;
          }
          h2Request.write(
            frameConnectMessage(toBinary(AgentClientMessageSchema, throwReply)),
          );
          h2Request.write(
            frameConnectMessage(toBinary(AgentClientMessageSchema, closeReply)),
            () => {
              if (!recover) settle(terminalError);
            },
          );
          return;
        }
        if (message.message.case === "kvServerMessage") {
          sendKvReply(message.message.value, built.blobStore, h2Request);
          return;
        }
        if (message.message.case === "interactionQuery") {
          throw new Error(
            `Cursor interaction query ${message.message.value.query.case ?? "unknown"} is unavailable ${context.tools?.length ? "outside Pi's interaction lifecycle" : "in chat-only mode"}`,
          );
        }
        if (message.message.case !== "interactionUpdate") return;
        const update = message.message.value;
        if (
          context.tools?.length &&
          (update.message.case === "partialToolCall" ||
            update.message.case === "toolCallStarted" ||
            update.message.case === "toolCallCompleted" ||
            update.message.case === "toolCallDelta")
        ) {
          // Only exec mcpArgs is an invocation. UI previews may be partial,
          // duplicated, or emitted for approval probes, and never execute.
          // Native previews are not an execution request either. Wait for its
          // exec frame so we can reject it with the correct protocol identity.
          return;
        }
        processInteraction(
          message.message.value,
          output,
          stream,
          () => {
            turnEnded = true;
          },
          {
            setText(value) {
              currentText = value;
            },
            getText() {
              return currentText;
            },
            setThinking(value) {
              currentThinking = value;
            },
            getThinking() {
              return currentThinking;
            },
            closeBlocks,
          },
        );
      };
      const processData = (chunk: Buffer) => {
        frames.push(chunk, processFrame);
        // Preserve tool batching while a complete header awaits its body.
        if (frames.awaitingPayload) return;
        if (pendingCalls.size > 0 && !handingOffTools) {
          if (terminalError) throw terminalError;
          if (options?.signal?.aborted)
            throw new Error("Cursor request aborted");
          closeBlocks();
          for (const call of pendingCalls.values()) {
            const contentIndex = output.content.length;
            output.content.push(call);
            stream.push({
              type: "toolcall_start",
              contentIndex,
              partial: output,
            });
            stream.push({
              type: "toolcall_delta",
              contentIndex,
              delta: JSON.stringify(call.arguments),
              partial: output,
            });
            stream.push({
              type: "toolcall_end",
              contentIndex,
              toolCall: call,
              partial: output,
            });
          }
          output.stopReason = "toolUse";
          handingOffTools = true;
          turnEnded = true;
          settle();
        }
      };

      h2Client = await connectCursorHttp2(baseUrl, {
        signal: options?.signal,
        timeoutMs: Math.min(
          requestTimeoutMs ?? PROXY_TUNNEL_TIMEOUT_MS,
          PROXY_TUNNEL_TIMEOUT_MS,
        ),
      });
      h2Client.once("error", (error) => {
        rejectResponseReady(error);
        settle(error);
      });
      h2Request = h2Client.request(cursorHeaders(apiKey, options));
      h2Request.once("response", (headers) => {
        armIdleTimer();
        responseSeen = true;
        responseStatus = Number(headers[":status"] ?? 0);
        responseHeaders = headerRecord(headers);
        resolveResponseReady();
      });
      h2Request.on("trailers", (trailers) => {
        const status = String(trailers["grpc-status"] ?? "0");
        if (status !== "0") {
          const encodedMessage = String(trailers["grpc-message"] ?? "");
          try {
            terminalError = new Error(
              `Cursor gRPC error ${status}: ${decodeURIComponent(encodedMessage)}`,
            );
          } catch (cause) {
            const error = new Error(
              `Cursor gRPC error ${status} contains a malformed grpc-message trailer`,
              { cause },
            );
            terminalError = error;
            settle(error);
          }
        }
      });
      const responseCallback = responseReady.promise.then(async () => {
        await options?.onResponse?.(
          { status: responseStatus, headers: responseHeaders },
          model,
        );
        if (responseStatus < 200 || responseStatus >= 300) {
          throw new Error(
            `Cursor AgentService request failed with HTTP ${responseStatus}`,
          );
        }
        stream.push({ type: "start", partial: output });
      });
      // Keep rejected transport/callback promises observed even when the peer
      // closes immediately after a malformed or unsupported interaction.
      void responseReady.promise.catch(() => {});
      void responseCallback.catch(() => {});
      let dataChain = Promise.resolve();
      h2Request.on("data", (chunk: Buffer) => {
        armIdleTimer();
        dataChain = dataChain
          .then(() => responseCallback)
          .then(() => processData(chunk))
          .catch((error) => {
            settle(error);
          });
      });
      h2Request.once("end", () => {
        clearIdleTimer();
        if (!responseSeen) {
          rejectResponseReady(
            new Error("Cursor response headers were not received"),
          );
        }
        void dataChain
          .then(() => responseCallback)
          .then(() => {
            if (!responseSeen)
              throw new Error("Cursor response headers were not received");
            if (frames.incomplete)
              throw new Error("Incomplete Cursor Connect frame");
            settle();
          })
          .catch((error) => settle(error));
      });
      h2Request.once("error", (error) => {
        rejectResponseReady(error);
        settle(error);
      });
      h2Request.once("aborted", () => {
        const error = new Error("Cursor response aborted");
        rejectResponseReady(error);
        settle(error);
      });
      const sendHeartbeat = () => {
        if (!h2Request || h2Request.closed || h2Request.destroyed) return;
        const message = create(AgentClientMessageSchema, {
          message: {
            case: "clientHeartbeat",
            value: create(ClientHeartbeatSchema, {}),
          },
        });
        try {
          h2Request.write(
            frameConnectMessage(toBinary(AgentClientMessageSchema, message)),
          );
        } catch {
          // The terminal request/error handler owns stream completion.
        }
      };
      heartbeat = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
      if (options?.signal) {
        const onAbort = () => {
          const error = new Error("Cursor request aborted");
          rejectResponseReady(error);
          h2Request?.close(http2.constants.NGHTTP2_CANCEL);
          settle(error);
        };
        if (options.signal.aborted) onAbort();
        else {
          options.signal.addEventListener("abort", onAbort, { once: true });
          removeAbortListener = () =>
            options.signal?.removeEventListener("abort", onAbort);
        }
      }
      armIdleTimer();
      h2Request.write(frameConnectMessage(built.requestBytes));
      await responseCallback;
      await completion.promise;
      if (heartbeat) clearInterval(heartbeat);
      clearIdleTimer();
      removeAbortListener?.();
      h2Request.close();
      h2Client.close();
      closeBlocks();
      if (output.stopReason === "pending") output.stopReason = "stop";
      output.usage.totalTokens = output.usage.input + output.usage.output;
      stream.push({
        type: "done",
        reason:
          output.stopReason === "toolUse"
            ? "toolUse"
            : output.stopReason === "length"
              ? "length"
              : "stop",
        message: output,
      });
      stream.end();
    } catch (error) {
      if (heartbeat) clearInterval(heartbeat);
      if (idleTimer) clearTimeout(idleTimer);
      removeAbortListener?.();
      h2Request?.close();
      h2Client?.close();
      finishError(error);
    }
  })().catch((error) => {
    // The body above handles all expected failures; this guard also protects
    // the event stream from an unexpected asynchronous callback rejection.
    stream.push({
      type: "error",
      reason: "error",
      error: {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: emptyUsage(),
        stopReason: "error",
        errorMessage: error instanceof Error ? error.message : String(error),
        timestamp: Date.now(),
      },
    });
    stream.end();
  });
  return stream;
}

interface InteractionState {
  setText(
    value:
      | Extract<AssistantMessage["content"][number], { type: "text" }>
      | undefined,
  ): void;
  getText():
    | Extract<AssistantMessage["content"][number], { type: "text" }>
    | undefined;
  setThinking(
    value:
      | Extract<AssistantMessage["content"][number], { type: "thinking" }>
      | undefined,
  ): void;
  getThinking():
    | Extract<AssistantMessage["content"][number], { type: "thinking" }>
    | undefined;
  closeBlocks(): void;
}

function processInteraction(
  update: InteractionUpdate,
  output: AssistantMessage,
  stream: AssistantMessageEventStream,
  onTurnEnded: () => void,
  state: InteractionState,
): void {
  switch (update.message.case) {
    case "textDelta": {
      const thinking = state.getThinking();
      if (thinking) {
        const index = output.content.indexOf(thinking);
        stream.push({
          type: "thinking_end",
          contentIndex: index,
          content: thinking.thinking,
          partial: output,
        });
        state.setThinking(undefined);
      }
      const delta = update.message.value.text;
      if (!delta) return;
      let block = state.getText();
      if (!block) {
        block = { type: "text", text: "" };
        output.content.push(block);
        state.setText(block);
        stream.push({
          type: "text_start",
          contentIndex: output.content.length - 1,
          partial: output,
        });
      }
      block.text += delta;
      stream.push({
        type: "text_delta",
        contentIndex: output.content.indexOf(block),
        delta,
        partial: output,
      });
      break;
    }
    case "thinkingDelta": {
      const delta = update.message.value.text;
      if (!delta) return;
      const text = state.getText();
      if (text) {
        const index = output.content.indexOf(text);
        stream.push({
          type: "text_end",
          contentIndex: index,
          content: text.text,
          partial: output,
        });
        state.setText(undefined);
      }
      let block = state.getThinking();
      if (!block) {
        block = { type: "thinking", thinking: "" };
        output.content.push(block);
        state.setThinking(block);
        stream.push({
          type: "thinking_start",
          contentIndex: output.content.length - 1,
          partial: output,
        });
      }
      block.thinking += delta;
      stream.push({
        type: "thinking_delta",
        contentIndex: output.content.indexOf(block),
        delta,
        partial: output,
      });
      break;
    }
    case "thinkingCompleted": {
      const block = state.getThinking();
      if (!block) return;
      const index = output.content.indexOf(block);
      stream.push({
        type: "thinking_end",
        contentIndex: index,
        content: block.thinking,
        partial: output,
      });
      state.setThinking(undefined);
      break;
    }
    case "partialToolCall":
    case "toolCallDelta":
    case "toolCallStarted":
    case "toolCallCompleted":
      throw new Error(
        `Cursor ${update.message.case} is unavailable in chat-only mode`,
      );
    case "tokenDelta": {
      // Cursor only reports generated tokens here, not the complete context
      // usage Pi needs for context accounting. Keep the usage block empty;
      // Pi 0.84.3+ estimates the full history for threshold compaction.
      break;
    }
    case "turnEnded":
      onTurnEnded();
      break;
    case "heartbeat":
    case undefined:
      break;
  }
}

function sendKvReply(
  message: KvServerMessage,
  store: CursorBlobStore,
  request: http2.ClientHttp2Stream | undefined,
): void {
  if (!request || request.closed || request.destroyed) return;
  let reply;
  if (message.message.case === "getBlobArgs") {
    const key = Buffer.from(message.message.value.blobId).toString("hex");
    reply = create(KvClientMessageSchema, {
      id: message.id,
      message: {
        case: "getBlobResult",
        value: create(GetBlobResultSchema, { blobData: store.get(key) }),
      },
    });
  } else if (message.message.case === "setBlobArgs") {
    const args = message.message.value;
    store.set(Buffer.from(args.blobId).toString("hex"), args.blobData);
    reply = create(KvClientMessageSchema, {
      id: message.id,
      message: {
        case: "setBlobResult",
        value: create(SetBlobResultSchema, {}),
      },
    });
  } else {
    return;
  }
  const envelope = create(AgentClientMessageSchema, {
    message: { case: "kvClientMessage", value: reply },
  });
  try {
    request.write(
      frameConnectMessage(toBinary(AgentClientMessageSchema, envelope)),
    );
  } catch {
    // The owning stream listener reports the transport failure.
  }
}
