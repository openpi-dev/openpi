import type { WebModelConfiguration } from "./types.ts";
import { validModelConfiguration } from "./model-configuration.ts";

export interface ProviderModelDiscovery {
  provider: string;
  baseUrl: string;
  api: WebModelConfiguration["api"];
  apiKey?: string;
}

export type DiscoveredProviderModel = Pick<WebModelConfiguration, "id" | "name"> &
  Partial<Pick<WebModelConfiguration, "contextWindow" | "maxTokens" | "input" | "reasoning">>;

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function modelCapabilities(item: Record<string, unknown>) {
  const result: Partial<DiscoveredProviderModel> = {};
  const top = record(item.top_provider) ? item.top_provider : {};
  const capabilities = record(item.capabilities) ? item.capabilities : {};
  const architecture = record(item.architecture) ? item.architecture : {};
  const capacity = (...values: unknown[]) => values.find((value): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 100_000_000);
  const context = capacity(item.contextWindow, top.context_length, item.context_length, item.context_window);
  const output = capacity(item.maxTokens, top.max_completion_tokens, item.max_completion_tokens, item.max_output_tokens);
  if (context !== undefined) result.contextWindow = context;
  if (output !== undefined) result.maxTokens = output;
  const input = item.input ?? architecture.input_modalities;
  if (Array.isArray(input) && input.every((kind) => typeof kind === "string")) {
    const supported = input.filter((kind): kind is "text" | "image" => kind === "text" || kind === "image");
    if (supported.length) result.input = [...new Set(supported)];
  }
  const reasoning = item.reasoning ?? capabilities.reasoning;
  if (typeof reasoning === "boolean") result.reasoning = reasoning;
  else if (Array.isArray(item.supported_parameters) && item.supported_parameters.some((name) => name === "reasoning" || name === "reasoning_effort")) result.reasoning = true;
  return result;
}

export function validProviderDiscovery(value: unknown): value is ProviderModelDiscovery {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return Object.keys(v).every((key) => ["provider", "baseUrl", "api", "apiKey"].includes(key)) &&
    (v.apiKey === undefined || typeof v.apiKey === "string" && v.apiKey.length <= 8192 && !/[\r\n\u0000]/u.test(v.apiKey)) &&
    validModelConfiguration({ provider: v.provider, baseUrl: v.baseUrl, api: v.api, id: "catalog", name: "catalog", reasoning: false, contextWindow: 128000, maxTokens: 16384 });
}

/** A user-requested catalog read; never stream a prompt or follow credential-bearing redirects. */
export async function discoverProviderModels(request: ProviderModelDiscovery, headers: Record<string, string>, signal: AbortSignal) {
  if (!validProviderDiscovery(request)) throw new Error("Invalid provider connection");
  const base = request.baseUrl.replace(/\/+$/u, "");
  const url = new URL(`${base}${request.api === "anthropic-messages" && !base.endsWith("/v1") ? "/v1" : ""}/models`);
  const models = new Map<string, DiscoveredProviderModel>();
  const cursors = new Set<string>();
  let bytes = 0;
  let truncated = false;
  while (true) {
    const response = await fetch(url, { headers, signal, redirect: "error" });
    if (!response.ok) throw new Error(`Model catalog returned HTTP ${response.status}`);
    if (!response.body) throw new Error("Empty model catalog");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.length;
        if (bytes > 1024 * 1024) throw new Error("Model catalog is too large");
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => undefined); }
    const data: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!record(data) || !Array.isArray(data.data)) throw new Error("Unsupported model catalog");
    const hasMore = request.api === "anthropic-messages" && data.has_more === true;
    truncated ||= data.data.length > 500;
    for (const [index, item] of data.data.entries()) {
      if (!item || typeof item !== "object" || typeof item.id !== "string" || !item.id || item.id.length > 256 || /[\u0000-\u001f]/u.test(item.id)) continue;
      const name = typeof item.name === "string" ? item.name : typeof item.display_name === "string" ? item.display_name : item.id;
      models.set(item.id, { ...modelCapabilities(item), id: item.id, name: name.slice(0, 256).replace(/[\u0000-\u001f]/gu, "") || item.id });
      if (models.size >= 500) {
        truncated ||= index < data.data.length - 1 || hasMore;
        break;
      }
    }
    if (!hasMore || models.size >= 500) break;
    const cursor = data.last_id;
    if (typeof cursor !== "string" || !cursor || cursor.length > 256 || /[\u0000-\u001f]/u.test(cursor) || cursors.has(cursor) || data.data.length === 0) throw new Error("Unsupported model catalog pagination");
    cursors.add(cursor);
    url.searchParams.set("after_id", cursor);
  }
  return { models: [...models.values()].sort((a, b) => a.id.localeCompare(b.id)), truncated };
}
