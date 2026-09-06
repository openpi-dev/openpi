/**
 * Cloud Code Assist (Antigravity) streamSimple implementation.
 *
 * Wire shape (reference: oh-my-pi packages/ai/src/providers/google-gemini-cli.ts,
 * shared google-gemini-cli/google-antigravity implementation):
 *
 *   POST {endpoint}/v1internal:streamGenerateContent?alt=sse
 *   { project, requestId, model, userAgent: "antigravity", requestType: "agent",
 *     request: { contents, systemInstruction, tools, toolConfig,
 *                generationConfig, labels, sessionId } }
 *
 * SSE frames carry `{ response: GenerateContentResponse }` envelopes. Endpoint
 * failover: daily-cloudcode-pa → daily-cloudcode-pa.sandbox. Message/tool
 * conversion is kept local because Pi extensions cannot resolve pi-ai's
 * internal google-shared module at installed runtime.
 */

import { createHash, randomUUID } from "node:crypto";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
  ToolCall,
} from "@earendil-works/pi-ai/compat";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import { emptyUsage } from "../usage.ts";
import { decodeApiKey } from "./credentials.ts";
import {
  convertMessages,
  convertTools,
  isThinkingPart,
  mapStopReasonString,
  retainThoughtSignature,
} from "./google-conversion.ts";
import { ensureAntigravityVersion, getAntigravityUserAgent } from "./oauth.ts";
import { routeAntigravityModel } from "./routing.ts";

const ENDPOINTS = [
  "https://daily-cloudcode-pa.googleapis.com",
  "https://daily-cloudcode-pa.sandbox.googleapis.com",
] as const;

const CLAUDE_THINKING_BETA_HEADER = "interleaved-thinking-2025-05-14";

const FLASH_FIRST_EVENT_TIMEOUT_MS = 60_000;
const DEFAULT_FIRST_EVENT_TIMEOUT_MS = 300_000;
const MAX_ERROR_BODY_BYTES = 64 * 1024;

type AntigravityStreamOptions = Omit<SimpleStreamOptions, "toolChoice"> & {
  /** Keep Antigravity's richer modes compatible across Pi 0.84.1 and 0.84.3+. */
  toolChoice?:
    | "auto"
    | "none"
    | "any"
    | { mode: "ANY"; allowedFunctionNames: [string, ...string[]] };
};

const FORCED_TOOL_DIRECTIVE =
  "TOOL-ONLY TURN. This turn accepts a tool call and nothing else; " +
  "a text reply here is discarded unread and you will be re-prompted. " +
  "Emit the tool call now.";

interface AntigravitySessionState {
  agentId: string;
  trajectoryId: string;
  sessionId: string;
  stepIndex: number;
  lastExecutionId?: string;
}

const sessionStates = new Map<string, AntigravitySessionState>();
const MAX_SESSION_STATES = 64;

// Cloud Code Assist 400s on these JSON Schema keywords (reference: omp
// packages/ai/src/utils/schema/fields.ts — union of UNSUPPORTED_SCHEMA_FIELDS
// and LIFTABLE_TO_DESCRIPTION_FIELDS). Constraints that remain useful to the
// model are serialized into the sibling description before being removed.
const CCA_UNSUPPORTED_SCHEMA_FIELDS: Record<string, true> = {
  $schema: true,
  $ref: true,
  $defs: true,
  $dynamicRef: true,
  $dynamicAnchor: true,
  $comment: true,
  examples: true,
  prefixItems: true,
  unevaluatedProperties: true,
  unevaluatedItems: true,
  patternProperties: true,
  additionalProperties: true,
  propertyNames: true,
  minItems: true,
  maxItems: true,
  minLength: true,
  maxLength: true,
  minProperties: true,
  maxProperties: true,
  minimum: true,
  maximum: true,
  exclusiveMinimum: true,
  exclusiveMaximum: true,
  multipleOf: true,
  uniqueItems: true,
  pattern: true,
  format: true,
  default: true,
  deprecated: true,
  readOnly: true,
  writeOnly: true,
  dependencies: true,
  dependentSchemas: true,
  dependentRequired: true,
  "x-mcp-header": true,
};
// Stripped keywords whose constraint stays model-visible by spilling into the
// node's description (omp LIFTABLE_TO_DESCRIPTION_FIELDS, "spill" format).
const CCA_LIFTABLE_TO_DESCRIPTION: Record<string, true> = {
  pattern: true,
  format: true,
  minLength: true,
  maxLength: true,
  minimum: true,
  maximum: true,
  exclusiveMinimum: true,
  exclusiveMaximum: true,
  multipleOf: true,
  minItems: true,
  maxItems: true,
  uniqueItems: true,
  minProperties: true,
  maxProperties: true,
  default: true,
  examples: true,
};

function sanitizeSchemaForCcaValue(
  value: unknown,
  insidePropertiesMap: boolean,
): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeSchemaForCcaValue(entry, false));
  }
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  const spill: Array<[string, unknown]> = [];
  for (const [key, entry] of Object.entries(value)) {
    // Keys below `properties` are user-defined parameter names, not JSON
    // Schema keywords. A tool parameter named `pattern`, for example, must be
    // preserved while its schema value is sanitized normally.
    if (insidePropertiesMap) {
      out[key] = sanitizeSchemaForCcaValue(entry, false);
      continue;
    }
    if (Object.hasOwn(CCA_UNSUPPORTED_SCHEMA_FIELDS, key)) {
      if (
        entry !== undefined &&
        Object.hasOwn(CCA_LIFTABLE_TO_DESCRIPTION, key)
      ) {
        spill.push([key, entry]);
      }
      continue;
    }
    out[key] = sanitizeSchemaForCcaValue(entry, key === "properties");
  }
  if (spill.length > 0) {
    const formatted = `{${spill.map(([key, entry]) => `${key}: ${JSON.stringify(entry)}`).join(", ")}}`;
    const existing = typeof out.description === "string" ? out.description : "";
    out.description = existing ? `${existing}\n\n${formatted}` : formatted;
  }
  return out;
}

/** Recursively drop schema keywords Cloud Code Assist rejects. */
export function sanitizeSchemaForCca(value: unknown): unknown {
  return sanitizeSchemaForCcaValue(value, false);
}

// ---------------------------------------------------------------------------
// Request construction
// ---------------------------------------------------------------------------

function isClaudeRoute(modelId: string): boolean {
  return modelId.toLowerCase().includes("claude");
}

function normalizeSystemPrompts(
  systemPrompt: Context["systemPrompt"],
): string[] {
  if (!systemPrompt) return [];
  return Array.isArray(systemPrompt) ? systemPrompt : [systemPrompt];
}

/** Deterministic conversation id: hash of the first user text, like the client. */
function deriveSessionId(context: Context): string {
  for (const message of context.messages) {
    if (message.role !== "user") continue;
    const content = message.content;
    const text =
      typeof content === "string"
        ? content
        : content.find((part) => part.type === "text")?.text;
    if (text && text.trim().length > 0) {
      const digest = createHash("sha256").update(text).digest();
      let value = 0n;
      for (let i = 0; i < 8; i++) {
        value = (value << 8n) | BigInt(digest[i]);
      }
      // The real client formats its bounded int63 identifier as a negative
      // decimal string rather than using a UUID on the wire.
      return `-${String(value & 0x7fffffffffffffffn)}`;
    }
    break;
  }
  const random = BigInt(`0x${randomUUID().replaceAll("-", "").slice(0, 16)}`);
  return `-${String(random & 0x7fffffffffffffffn)}`;
}

function getSessionState(
  options: AntigravityStreamOptions | undefined,
  context: Context,
): AntigravitySessionState | undefined {
  const key = options?.sessionId;
  if (!key) return undefined;
  const existing = sessionStates.get(key);
  if (existing) return existing;
  if (sessionStates.size >= MAX_SESSION_STATES) {
    const oldest = sessionStates.keys().next().value;
    if (oldest) sessionStates.delete(oldest);
  }
  const created: AntigravitySessionState = {
    agentId: randomUUID(),
    trajectoryId: randomUUID(),
    sessionId: deriveSessionId(context),
    stepIndex: 1,
  };
  sessionStates.set(key, created);
  return created;
}

function buildToolConfig(
  model: Model<Api>,
  hasTools: boolean,
  toolChoice: AntigravityStreamOptions["toolChoice"],
): Record<string, unknown> | undefined {
  if (!hasTools) {
    return isClaudeRoute(model.id) && toolChoice !== "none"
      ? { functionCallingConfig: { mode: "VALIDATED" } }
      : undefined;
  }
  if (toolChoice === "none") {
    return { functionCallingConfig: { mode: "NONE" } };
  }
  if (toolChoice === "any") {
    return { functionCallingConfig: { mode: "ANY" } };
  }
  if (typeof toolChoice === "object") {
    return {
      functionCallingConfig: {
        mode: "ANY",
        allowedFunctionNames: [...toolChoice.allowedFunctionNames],
      },
    };
  }
  // Antigravity's default tool mode is VALIDATED (verified upstream for both
  // Gemini and Claude routes).
  return { functionCallingConfig: { mode: "VALIDATED" } };
}

/** Convert pi tools to CCA functionDeclarations with sanitized schemas. */
function buildTools(
  context: Context,
  toolChoice: AntigravityStreamOptions["toolChoice"],
): Record<string, unknown>[] | undefined {
  if (toolChoice === "none") return undefined;
  const tools = context.tools;
  if (!tools || tools.length === 0) return undefined;
  const converted = convertTools([...tools], true) as
    | { functionDeclarations: Record<string, unknown>[] }[]
    | undefined;
  if (!converted) return undefined;
  return converted.map((group) => ({
    ...group,
    functionDeclarations: group.functionDeclarations.map((declaration) => ({
      ...declaration,
      parameters: sanitizeSchemaForCca(declaration.parameters),
    })),
  }));
}

export function buildRequestBody(
  model: Model<Api>,
  context: Context,
  options: AntigravityStreamOptions | undefined,
  projectId: string,
  state?: AntigravitySessionState,
): Record<string, unknown> {
  const contents = convertMessages(model, context);

  const request: Record<string, unknown> = { contents };
  const systemPrompts = normalizeSystemPrompts(context.systemPrompt);
  if (systemPrompts.length > 0) {
    request.systemInstruction = {
      role: "user",
      parts: systemPrompts.map((text) => ({ text })),
    };
  }

  const tools = buildTools(context, options?.toolChoice);
  if (tools) request.tools = tools;
  const toolConfig = buildToolConfig(
    model,
    Boolean(tools),
    options?.toolChoice,
  );
  if (toolConfig) request.toolConfig = toolConfig;
  if (
    tools &&
    !isClaudeRoute(model.id) &&
    (options?.toolChoice === "any" || typeof options?.toolChoice === "object")
  ) {
    contents.push({ role: "user", parts: [{ text: FORCED_TOOL_DIRECTIVE }] });
  }

  const route = routeAntigravityModel(
    model.id,
    model.reasoning ? options?.reasoning : undefined,
    options?.thinkingBudgets,
    model as Model<Api> & {
      requestModelId?: string;
      antigravityEffortRouting?: Partial<
        Record<NonNullable<SimpleStreamOptions["reasoning"]>, string>
      >;
    },
  );
  const requestedMaxTokens = options?.maxTokens ?? model.maxTokens;
  const generationConfig: Record<string, unknown> = {
    maxOutputTokens: isClaudeRoute(route.wireModelId)
      ? Math.min(requestedMaxTokens, 64_000)
      : requestedMaxTokens,
  };
  if (options?.temperature !== undefined) {
    generationConfig.temperature = options.temperature;
  }
  const thinkingConfig = model.reasoning ? route.thinkingConfig : undefined;
  if (thinkingConfig) generationConfig.thinkingConfig = thinkingConfig;
  request.generationConfig = generationConfig;

  const agentId = state?.agentId ?? randomUUID();
  const trajectoryId = state?.trajectoryId ?? randomUUID();
  const sessionId = state?.sessionId ?? deriveSessionId(context);
  const stepIndex = state ? ++state.stepIndex : 2;
  request.sessionId = sessionId;
  request.labels = {
    ...(state?.lastExecutionId
      ? { last_execution_id: state.lastExecutionId }
      : {}),
    last_step_index: String(stepIndex - 1),
    trajectory_id: trajectoryId,
    used_claude: String(isClaudeRoute(model.id)),
    used_claude_conservative: String(isClaudeRoute(model.id)),
  };

  return {
    project: projectId,
    requestId: `agent/${agentId}/${Date.now()}/${trajectoryId}/${stepIndex}`,
    model: route.wireModelId,
    userAgent: "antigravity",
    requestType: "agent",
    request,
  };
}

// ---------------------------------------------------------------------------
// SSE decoding
// ---------------------------------------------------------------------------

interface CcaPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: {
    id?: string;
    name?: string;
    args?: Record<string, unknown>;
  };
}

interface CcaChunk {
  response?: {
    responseId?: string;
    candidates?: {
      content?: { parts?: CcaPart[] };
      finishReason?: string;
    }[];
    promptFeedback?: {
      blockReason?: string;
      blockReasonMessage?: string;
    };
    usageMetadata?: {
      promptTokenCount?: number;
      cachedContentTokenCount?: number;
      candidatesTokenCount?: number;
      thoughtsTokenCount?: number;
      totalTokenCount?: number;
    };
  };
  error?: { code?: number; message?: string; status?: string };
}

async function readErrorResponseBody(
  body: ReadableStream<Uint8Array> | null,
  signal: AbortSignal | undefined,
  deadline: number,
): Promise<string> {
  if (!body) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let bytesRead = 0;
  let reachedEnd = false;
  let truncated = false;
  const timeoutError = () =>
    new Error("Timed out reading Cloud Code Assist error response body");
  try {
    while (bytesRead < MAX_ERROR_BODY_BYTES) {
      if (signal?.aborted) throw new Error("Request aborted");
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw timeoutError();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      const gates: Promise<ReadableStreamReadResult<Uint8Array>>[] = [
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(timeoutError()),
            Math.max(1, remaining),
          );
        }),
      ];
      if (signal) {
        gates.push(
          new Promise<never>((_, reject) => {
            onAbort = () => reject(new Error("Request aborted"));
            signal.addEventListener("abort", onAbort, { once: true });
          }),
        );
      }
      const result = await Promise.race(gates).finally(() => {
        if (timer) clearTimeout(timer);
        if (onAbort) signal?.removeEventListener("abort", onAbort);
      });
      if (Date.now() >= deadline) throw timeoutError();
      if (result.done) {
        reachedEnd = true;
        break;
      }
      const remainingBytes = MAX_ERROR_BODY_BYTES - bytesRead;
      const value = result.value.subarray(0, remainingBytes);
      bytesRead += value.byteLength;
      chunks.push(decoder.decode(value, { stream: true }));
      if (value.byteLength < result.value.byteLength) {
        truncated = true;
        break;
      }
      if (bytesRead === MAX_ERROR_BODY_BYTES) truncated = true;
    }
    chunks.push(decoder.decode());
    return chunks.join("") + (truncated ? "… [truncated]" : "");
  } finally {
    if (!reachedEnd) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function* readSseChunks(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal | undefined,
  firstEventDeadline: number,
  requestDeadline: number | undefined,
): AsyncGenerator<CcaChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines: string[] = [];
  const flush = (): CcaChunk | undefined => {
    if (dataLines.length === 0) return undefined;
    const payload = dataLines.join("\n");
    dataLines = [];
    if (payload === "[DONE]") return undefined;
    return JSON.parse(payload) as CcaChunk;
  };
  let sawEvent = false;
  let reachedEnd = false;
  const timeoutError = () =>
    new Error(
      sawEvent
        ? "Timed out waiting for the next SSE event"
        : "Timed out waiting for the first SSE event",
    );
  try {
    while (true) {
      if (signal?.aborted) throw new Error("Request aborted");
      const deadline = sawEvent ? requestDeadline : firstEventDeadline;
      const remaining =
        deadline === undefined ? undefined : deadline - Date.now();
      if (remaining !== undefined && remaining <= 0) throw timeoutError();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      const read = reader.read();
      const gates: Promise<ReadableStreamReadResult<Uint8Array>>[] = [read];
      if (remaining !== undefined) {
        gates.push(
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(timeoutError()),
              Math.max(1, remaining),
            );
          }),
        );
      }
      if (signal) {
        gates.push(
          new Promise<never>((_, reject) => {
            onAbort = () => reject(new Error("Request aborted"));
            signal.addEventListener("abort", onAbort, { once: true });
          }),
        );
      }
      const result = await Promise.race(gates).finally(() => {
        if (timer) clearTimeout(timer);
        if (onAbort) signal?.removeEventListener("abort", onAbort);
      });
      if (deadline !== undefined && Date.now() >= deadline)
        throw timeoutError();
      const { done, value } = result;
      if (done) {
        reachedEnd = true;
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (line === "") {
          const event = flush();
          if (event) {
            sawEvent = true;
            yield event;
          }
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trimStart());
        }
        // event:/id:/retry: lines carry no payload for this API.
      }
    }
    buffer += decoder.decode();
    const tail = buffer.trim();
    if (tail.startsWith("data:")) dataLines.push(tail.slice(5).trimStart());
    const event = flush();
    if (event) yield event;
  } finally {
    if (!reachedEnd) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function* prependChunks(
  initial: readonly CcaChunk[],
  rest: AsyncGenerator<CcaChunk>,
): AsyncGenerator<CcaChunk> {
  yield* initial;
  yield* rest;
}

function transientStatus(status: number | undefined): boolean {
  return (
    status === 408 || status === 429 || (status !== undefined && status >= 500)
  );
}

class EndpointAttemptError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "EndpointAttemptError";
    this.retryable = retryable;
  }
}

async function preflightChunks(
  chunks: AsyncGenerator<CcaChunk>,
): Promise<CcaChunk[]> {
  const initial: CcaChunk[] = [];
  while (true) {
    const next = await chunks.next();
    if (next.done) {
      throw new EndpointAttemptError(
        "Cloud Code Assist stream ended before returning content",
        true,
      );
    }
    const chunk = next.value;
    initial.push(chunk);
    if (chunk.error) {
      const code = chunk.error.code;
      const detail =
        chunk.error.message || chunk.error.status || "unknown error";
      throw new EndpointAttemptError(
        `Cloud Code Assist stream error: ${detail}`,
        transientStatus(code),
      );
    }
    const data = chunk.response;
    if (!data) continue;
    if (!data.candidates?.length && data.promptFeedback?.blockReason) {
      const detail = data.promptFeedback.blockReasonMessage;
      throw new EndpointAttemptError(
        `Request blocked by Google (${data.promptFeedback.blockReason})` +
          (detail ? `: ${detail}` : ""),
        false,
      );
    }
    const candidate = data.candidates?.[0];
    if (
      (candidate?.content?.parts ?? []).some(
        (part) =>
          Boolean(part.functionCall) ||
          (Boolean(part.text?.trim()) && part.thought !== true),
      )
    ) {
      return initial;
    }
    if (candidate?.finishReason) {
      throw new EndpointAttemptError(
        "Cloud Code Assist returned an empty response",
        true,
      );
    }
  }
}

function mergeRequestHeaders(
  defaults: Record<string, string>,
  overrides: AntigravityStreamOptions["headers"],
): Record<string, string> {
  const headers = new Headers(defaults);
  for (const [name, value] of Object.entries(overrides ?? {})) {
    if (value === null) headers.delete(name);
    else headers.set(name, value);
  }
  return Object.fromEntries(headers.entries());
}

// ---------------------------------------------------------------------------
// Stream entry point
// ---------------------------------------------------------------------------

let toolCallCounter = 0;

export function streamAntigravity(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const requestOptions = options as AntigravityStreamOptions | undefined;
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

    const fail = (error: unknown) => {
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
      const { token, projectId } = decodeApiKey(requestOptions?.apiKey ?? "");
      if (!token) {
        throw new Error(
          "No Antigravity access token — run /login google-antigravity",
        );
      }
      if (!projectId) {
        throw new Error(
          "No Cloud Code Assist project id in credentials — " +
            "re-run /login google-antigravity",
        );
      }

      const fetcher = requestOptions?.fetch ?? fetch;
      await ensureAntigravityVersion(requestOptions?.signal, fetcher);
      const providerState = getSessionState(requestOptions, context);
      let payload: unknown = buildRequestBody(
        model,
        context,
        requestOptions,
        projectId,
        providerState,
      );
      const replacement = await requestOptions?.onPayload?.(payload, model);
      if (replacement !== undefined) payload = replacement;
      const body = JSON.stringify(payload);
      const headers = mergeRequestHeaders(
        {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          "User-Agent": getAntigravityUserAgent(),
          ...(isClaudeRoute(model.id) && model.reasoning
            ? { "anthropic-beta": CLAUDE_THINKING_BETA_HEADER }
            : {}),
        },
        requestOptions?.headers,
      );
      const defaultFirstEventTimeout = model.id.includes("flash")
        ? FLASH_FIRST_EVENT_TIMEOUT_MS
        : DEFAULT_FIRST_EVENT_TIMEOUT_MS;
      const requestTimeout =
        requestOptions?.timeoutMs && requestOptions.timeoutMs > 0
          ? requestOptions.timeoutMs
          : undefined;
      const firstEventTimeout =
        requestTimeout !== undefined
          ? Math.min(requestTimeout, defaultFirstEventTimeout)
          : defaultFirstEventTimeout;

      let chunks: AsyncGenerator<CcaChunk> | undefined;
      let lastError: Error | undefined;
      for (const endpoint of ENDPOINTS) {
        const isLast = endpoint === ENDPOINTS[ENDPOINTS.length - 1];
        const attemptStartedAt = Date.now();
        const firstEventDeadline = attemptStartedAt + firstEventTimeout;
        const requestDeadline =
          requestTimeout === undefined
            ? undefined
            : attemptStartedAt + requestTimeout;
        const attemptAbort = new AbortController();
        const attemptSignal = requestOptions?.signal
          ? AbortSignal.any([requestOptions.signal, attemptAbort.signal])
          : attemptAbort.signal;
        let attempt: Response;
        let headersTimer: ReturnType<typeof setTimeout> | undefined;
        let onAbort: (() => void) | undefined;
        try {
          const pending = fetcher(
            `${endpoint}/v1internal:streamGenerateContent?alt=sse`,
            { method: "POST", headers, body, signal: attemptSignal },
          );
          const gates: Promise<Response>[] = [pending];
          gates.push(
            new Promise<never>((_, reject) => {
              headersTimer = setTimeout(
                () => {
                  const error = new Error(
                    "Timed out waiting for Cloud Code Assist response headers",
                  );
                  reject(error);
                  attemptAbort.abort(error);
                },
                Math.max(1, firstEventDeadline - Date.now()),
              );
            }),
          );
          if (requestOptions?.signal) {
            gates.push(
              new Promise<never>((_, reject) => {
                onAbort = () => {
                  const error = new Error("Request aborted");
                  reject(error);
                  attemptAbort.abort(error);
                };
                requestOptions.signal?.addEventListener("abort", onAbort, {
                  once: true,
                });
              }),
            );
          }
          attempt = await Promise.race(gates);
        } catch (error) {
          // Network/transport failure: fail over before any bytes stream.
          if (requestOptions?.signal?.aborted) throw error;
          lastError = error instanceof Error ? error : new Error(String(error));
          if (isLast) throw lastError;
          continue;
        } finally {
          if (headersTimer) clearTimeout(headersTimer);
          if (onAbort) {
            requestOptions?.signal?.removeEventListener("abort", onAbort);
          }
        }
        await requestOptions?.onResponse?.(
          {
            status: attempt.status,
            headers: Object.fromEntries(attempt.headers.entries()),
          },
          model,
        );
        if (!attempt.ok) {
          let errorText: string;
          try {
            errorText = await readErrorResponseBody(
              attempt.body,
              attemptSignal,
              requestDeadline ?? firstEventDeadline,
            );
          } catch (error) {
            attemptAbort.abort(error);
            if (requestOptions?.signal?.aborted) throw error;
            errorText = error instanceof Error ? error.message : String(error);
          }
          lastError = new Error(
            `Cloud Code Assist API error (${attempt.status}): ${errorText}`,
          );
          if (!transientStatus(attempt.status) || isLast) throw lastError;
          continue;
        }
        if (!attempt.body) {
          lastError = new Error(
            "Cloud Code Assist returned an empty response body",
          );
          if (isLast) throw lastError;
          continue;
        }
        const candidateChunks = readSseChunks(
          attempt.body,
          attemptSignal,
          firstEventDeadline,
          requestDeadline,
        );
        try {
          const initial = await preflightChunks(candidateChunks);
          chunks = prependChunks(initial, candidateChunks);
          break;
        } catch (error) {
          await candidateChunks.return(undefined).catch(() => {});
          if (requestOptions?.signal?.aborted) throw error;
          lastError = error instanceof Error ? error : new Error(String(error));
          if (
            isLast ||
            (error instanceof EndpointAttemptError && !error.retryable)
          ) {
            throw lastError;
          }
        }
      }
      if (!chunks) throw lastError ?? new Error("No endpoint reachable");

      stream.push({ type: "start", partial: output });

      let sawFinishReason = false;
      let sawMeaningfulContent = false;
      const contentIndex = () => output.content.length - 1;
      const closeOpenBlock = () => {
        const block = output.content[contentIndex()];
        if (!block) return;
        if (block.type === "text") {
          stream.push({
            type: "text_end",
            contentIndex: contentIndex(),
            content: block.text,
            partial: output,
          });
        } else if (block.type === "thinking") {
          stream.push({
            type: "thinking_end",
            contentIndex: contentIndex(),
            content: block.thinking,
            partial: output,
          });
        }
      };

      let lastResponseId: string | undefined;
      for await (const chunk of chunks) {
        if (chunk.error) {
          const detail =
            chunk.error.message || chunk.error.status || "unknown error";
          throw new Error(`Cloud Code Assist stream error: ${detail}`);
        }
        const data = chunk.response;
        if (!data) continue;
        if (data.responseId) lastResponseId = data.responseId;
        if (!data.candidates?.length && data.promptFeedback?.blockReason) {
          const detail = data.promptFeedback.blockReasonMessage;
          throw new Error(
            `Request blocked by Google (${data.promptFeedback.blockReason})` +
              (detail ? `: ${detail}` : ""),
          );
        }

        const candidate = data.candidates?.[0];
        for (const part of candidate?.content?.parts ?? []) {
          if (part.text !== undefined && part.text !== "") {
            if (isThinkingPart(part)) {
              const open = output.content[contentIndex()];
              if (open?.type !== "thinking") {
                closeOpenBlock();
                output.content.push({
                  type: "thinking",
                  thinking: "",
                });
                stream.push({
                  type: "thinking_start",
                  contentIndex: contentIndex(),
                  partial: output,
                });
              }
              const block = output.content[contentIndex()];
              if (block.type === "thinking") {
                block.thinking += part.text;
                block.thinkingSignature = retainThoughtSignature(
                  block.thinkingSignature,
                  part.thoughtSignature,
                );
                stream.push({
                  type: "thinking_delta",
                  contentIndex: contentIndex(),
                  delta: part.text,
                  partial: output,
                });
              }
            } else {
              if (part.text.trim().length > 0) sawMeaningfulContent = true;
              const open = output.content[contentIndex()];
              if (open?.type !== "text") {
                closeOpenBlock();
                output.content.push({ type: "text", text: "" });
                stream.push({
                  type: "text_start",
                  contentIndex: contentIndex(),
                  partial: output,
                });
              }
              const block = output.content[contentIndex()];
              if (block.type === "text") {
                block.text += part.text;
                block.textSignature = retainThoughtSignature(
                  block.textSignature,
                  part.thoughtSignature,
                );
                stream.push({
                  type: "text_delta",
                  contentIndex: contentIndex(),
                  delta: part.text,
                  partial: output,
                });
              }
            }
          } else if (
            part.text === "" &&
            part.thoughtSignature &&
            !part.functionCall
          ) {
            const open = output.content[contentIndex()];
            if (open?.type === "thinking") {
              open.thinkingSignature = retainThoughtSignature(
                open.thinkingSignature,
                part.thoughtSignature,
              );
            } else if (open?.type === "text") {
              open.textSignature = retainThoughtSignature(
                open.textSignature,
                part.thoughtSignature,
              );
            }
          }

          if (part.functionCall) {
            sawMeaningfulContent = true;
            closeOpenBlock();
            const call = part.functionCall;
            const providedId = call.id;
            const duplicated =
              providedId !== undefined &&
              output.content.some(
                (b) => b.type === "toolCall" && b.id === providedId,
              );
            const toolCall: ToolCall = {
              type: "toolCall",
              id:
                providedId && !duplicated
                  ? providedId
                  : `call_${call.name ?? "tool"}_${++toolCallCounter}`,
              name: call.name ?? "",
              arguments: call.args ?? {},
              ...(part.thoughtSignature
                ? { thoughtSignature: part.thoughtSignature }
                : {}),
            };
            output.content.push(toolCall);
            const index = contentIndex();
            stream.push({
              type: "toolcall_start",
              contentIndex: index,
              partial: output,
            });
            stream.push({
              type: "toolcall_delta",
              contentIndex: index,
              delta: JSON.stringify(toolCall.arguments),
              partial: output,
            });
            stream.push({
              type: "toolcall_end",
              contentIndex: index,
              toolCall,
              partial: output,
            });
          }
        }

        if (candidate?.finishReason) {
          sawFinishReason = true;
          const mapped = mapStopReasonString(candidate.finishReason);
          const hasToolCalls = output.content.some(
            (b) => b.type === "toolCall",
          );
          if ((mapped === "stop" || mapped === "length") && hasToolCalls) {
            output.stopReason = "toolUse";
          } else {
            output.stopReason = mapped;
            if (mapped === "error") {
              output.errorMessage = `Generation failed with finish reason: ${candidate.finishReason}`;
            }
          }
        }

        if (data.usageMetadata) {
          const usage = data.usageMetadata;
          const promptTokens = usage.promptTokenCount ?? 0;
          const cacheReadTokens = usage.cachedContentTokenCount ?? 0;
          const thinkingTokens = usage.thoughtsTokenCount ?? 0;
          output.usage = {
            input: Math.max(0, promptTokens - cacheReadTokens),
            output: (usage.candidatesTokenCount ?? 0) + thinkingTokens,
            cacheRead: cacheReadTokens,
            cacheWrite: 0,
            totalTokens: usage.totalTokenCount ?? 0,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          };
        }
      }

      closeOpenBlock();

      if (requestOptions?.signal?.aborted) {
        output.stopReason = "aborted";
      } else if (output.stopReason === "pending") {
        if (!sawFinishReason) {
          throw new Error(
            "Cloud Code Assist stream ended without a finish reason " +
              "(connection dropped or response truncated)",
          );
        }
        output.stopReason = "stop";
      }
      if (!sawMeaningfulContent && output.stopReason === "stop") {
        throw new Error("Cloud Code Assist API returned an empty response");
      }
      if (
        providerState &&
        output.stopReason !== "error" &&
        output.stopReason !== "aborted"
      ) {
        providerState.lastExecutionId = lastResponseId;
      }

      if (output.stopReason === "error" || output.stopReason === "aborted") {
        stream.push({
          type: "error",
          reason: output.stopReason,
          error: output,
        });
      } else {
        stream.push({
          type: "done",
          reason: output.stopReason,
          message: output,
        });
      }
      stream.end();
    } catch (error) {
      fail(error);
    }
  })();

  return stream;
}
