import { randomUUID } from "node:crypto";
import * as http2 from "node:http2";
import type { Api, Model, RefreshModelsContext } from "@earendil-works/pi-ai";
import {
  CURSOR_API_URL,
  CURSOR_CLIENT_VERSION,
  CURSOR_MODELS_PATH,
} from "./constants.ts";
import type { CursorModelDefinition } from "./models.ts";
import {
  GetUsableModelsRequestSchema,
  GetUsableModelsResponseSchema,
  type ModelDetails,
} from "./proto.ts";
import { create, fromBinary, toBinary } from "./protobuf.ts";
import { connectCursorHttp2 } from "./proxy.ts";

export interface CursorModelDiscoveryOptions {
  apiKey: string;
  baseUrl?: string;
  clientVersion?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  customModelIds?: string[];
}

const FALLBACK_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_TOKENS = 64_000;
const MAX_DISCOVERY_RESPONSE_BYTES = 16 * 1024 * 1024;
const ONE_MILLION_CONTEXT_WINDOW = 1_000_000;

/**
 * GetUsableModels has no numeric context-window field. Recover 1M only from
 * signals Cursor does send; use 200k as the conservative unknown-model fallback.
 */
function resolveContextWindow(details: ModelDetails, id: string): number {
  const labels = [
    id,
    details.displayName,
    details.displayNameShort,
    details.displayModelId,
    ...details.aliases,
  ].join(" ");
  if (/\b1m\b/i.test(labels)) return ONE_MILLION_CONTEXT_WINDOW;
  if (details.maxMode && /claude|gemini|gpt-5\.6-sol/i.test(id)) {
    return ONE_MILLION_CONTEXT_WINDOW;
  }
  if (isNativeOneMillionModel(id)) return ONE_MILLION_CONTEXT_WINDOW;
  return FALLBACK_CONTEXT_WINDOW;
}

/** Cursor serves these coding families with a native, unlabeled 1M window. */
function isNativeOneMillionModel(id: string): boolean {
  const bareId = id.split("/").at(-1)?.toLowerCase() ?? id.toLowerCase();
  if (/^(?:kimi-)?k3$/.test(bareId)) return true;

  const glm =
    /^glm-(\d{1,2})(?:\.(\d+))?(v)?(?:-(air|turbo|flashx|flash|preview))?$/.exec(
      bareId,
    );
  if (!glm || glm[3]) return false;
  const variant = glm[4];
  if (variant && variant !== "air" && variant !== "turbo") return false;
  const major = Number(glm[1]);
  const minor = Number(glm[2] ?? 0);
  return major > 5 || (major === 5 && minor >= 2);
}

/**
 * Fetch account-specific models over Cursor's HTTP/2 Connect endpoint.
 * `null` means transport/protocol failure; an empty successful response is
 * deliberately represented as `[]` so callers can choose their fallback policy.
 */
export async function fetchCursorUsableModels(
  options: CursorModelDiscoveryOptions,
): Promise<CursorModelDefinition[] | null> {
  const token = options.apiKey.trim();
  if (!token || options.signal?.aborted) return null;
  const baseUrl = (options.baseUrl ?? CURSOR_API_URL).replace(/\/+$/, "");
  const request = create(GetUsableModelsRequestSchema, {
    customModelIds: normalizeModelIds(options.customModelIds),
  });
  const requestBytes = toBinary(GetUsableModelsRequestSchema, request);
  const responseBytes = await requestHttp2(
    baseUrl,
    requestBytes,
    token,
    options,
  );
  if (!responseBytes) return null;

  const payload = decodeUnaryPayload(responseBytes);
  if (!payload) return null;
  let response;
  try {
    response = fromBinary(GetUsableModelsResponseSchema, payload);
  } catch {
    return null;
  }

  const models: CursorModelDefinition[] = [];
  const seen = new Set<string>();
  for (const details of response.models) {
    const normalized = normalizeCursorModel(details, baseUrl);
    if (!normalized || seen.has(normalized.id)) continue;
    seen.add(normalized.id);
    models.push(normalized);
  }
  models.sort((left, right) => left.id.localeCompare(right.id));
  return models;
}

/** Provider extension hook: discovery always uses the credential passed by pi. */
export async function fetchCursorModels(
  context: RefreshModelsContext,
): Promise<CursorModelDefinition[]> {
  if (!context.allowNetwork) return [];
  context.signal.throwIfAborted();
  const credential = context.credential;
  const apiKey =
    credential?.type === "oauth"
      ? credential.access
      : credential?.type === "api_key"
        ? credential.key
        : undefined;
  if (!apiKey) return [];
  const discovered = await fetchCursorUsableModels({
    apiKey,
    signal: context.signal,
  });
  context.signal.throwIfAborted();
  if (discovered === null) {
    throw new Error("Cursor model discovery failed");
  }
  return discovered;
}

function normalizeModelIds(ids: readonly string[] | undefined): string[] {
  if (!ids) return [];
  const result = new Set<string>();
  for (const id of ids) {
    if (typeof id !== "string") continue;
    const value = id.trim();
    if (value) result.add(value);
  }
  return [...result];
}

function normalizeCursorModel(
  details: ModelDetails,
  baseUrl: string,
): CursorModelDefinition | null {
  const id = details.modelId.trim();
  if (!id) return null;
  const name =
    [
      details.displayName,
      details.displayNameShort,
      details.displayModelId,
      ...details.aliases,
    ]
      .map((value) => value.trim())
      .find(Boolean) ?? id;
  const multimodal = supportsCursorImages(id);
  return {
    id,
    name,
    api: "cursor-agent",
    provider: "cursor",
    baseUrl,
    reasoning: Boolean(details.thinkingDetails) || /^cursor-grok-\d/i.test(id),
    input: multimodal ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: resolveContextWindow(details, id),
    maxTokens: DEFAULT_MAX_TOKENS,
    ...(details.maxMode ? { cursorMaxMode: true } : {}),
  };
}

/** GetUsableModels omits modality metadata for Cursor-native image families. */
function supportsCursorImages(id: string): boolean {
  const lower = id.toLowerCase();
  if (/claude|gemini|gpt-|codex/.test(lower)) return true;
  const bareId = lower.split("/").at(-1) ?? lower;
  return (
    /^(?:kimi-)?k3(?:$|[._:-])/.test(bareId) ||
    /^cursor-grok-4(?:$|[._:-])/.test(bareId) ||
    /^(?:cursor-)?composer-2\.5(?:$|[._:-])/.test(bareId)
  );
}

function buildHeaders(
  apiKey: string,
  clientVersion: string,
): Record<string, string> {
  return {
    "content-type": "application/proto",
    te: "trailers",
    authorization: `Bearer ${apiKey}`,
    "x-ghost-mode": "true",
    "x-cursor-client-version": clientVersion,
    "x-cursor-client-type": "cli",
    "x-request-id": randomUUID(),
  };
}

async function requestHttp2(
  baseUrl: string,
  body: Uint8Array,
  apiKey: string,
  options: CursorModelDiscoveryOptions,
): Promise<Uint8Array | null> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  let client: http2.ClientHttp2Session;
  try {
    client = await connectCursorHttp2(baseUrl, {
      signal: options.signal,
      timeoutMs,
    });
  } catch {
    return null;
  }
  const { promise, resolve } = Promise.withResolvers<Uint8Array | null>();
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let removeAbortListener: (() => void) | undefined;
  const finish = (result: Uint8Array | null, destroy = false) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    removeAbortListener?.();
    if (destroy) client.destroy();
    else client.close();
    resolve(result);
  };
  timer = setTimeout(() => finish(null, true), timeoutMs);
  client.once("error", () => finish(null, true));
  const req = client.request({
    ":method": "POST",
    ":path": CURSOR_MODELS_PATH,
    ...buildHeaders(apiKey, options.clientVersion ?? CURSOR_CLIENT_VERSION),
  });
  const chunks: Buffer[] = [];
  let responseBytes = 0;
  req.on("response", (headers) => {
    const status = Number(headers[":status"] ?? 0);
    if (status < 200 || status >= 300) finish(null, true);
  });
  req.on("data", (chunk: Buffer) => {
    responseBytes += chunk.length;
    if (responseBytes > MAX_DISCOVERY_RESPONSE_BYTES) {
      req.close(http2.constants.NGHTTP2_CANCEL);
      finish(null, true);
      return;
    }
    chunks.push(chunk);
  });
  req.on("end", () => finish(new Uint8Array(Buffer.concat(chunks))));
  req.once("error", () => finish(null, true));
  const onAbort = () => {
    options.signal?.removeEventListener("abort", onAbort);
    req.close(http2.constants.NGHTTP2_CANCEL);
    finish(null, true);
  };
  if (options.signal) {
    if (options.signal.aborted) onAbort();
    else {
      options.signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () =>
        options.signal?.removeEventListener("abort", onAbort);
    }
  }
  req.end(Buffer.from(body));
  return promise;
}

/** Decode the first uncompressed Connect data frame, or accept raw unary proto. */
export function decodeUnaryPayload(body: Uint8Array): Uint8Array | null {
  if (body.length === 0) return body;
  if (body.length < 5) return body;
  const flags = body[0]!;
  const size = new DataView(body.buffer, body.byteOffset, 5).getUint32(1);
  const end = 5 + size;
  // Unary Connect responses are normally one data frame followed by an
  // optional end-stream frame. If the prefix is not a valid uncompressed frame,
  // accept the raw protobuf response used by older Cursor deployments.
  if (flags > 3 || end > body.length || (flags & 1) !== 0) return body;
  const data = body.subarray(5, end);
  if ((flags & 2) !== 0) return null;
  return data;
}
