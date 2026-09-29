import type { WebModelConfiguration } from "./types.ts";
import { validModelConfiguration } from "./model-configuration.ts";

export interface ProviderModelDiscovery {
  provider: string;
  baseUrl: string;
  api: WebModelConfiguration["api"];
  apiKey?: string;
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
  const response = await fetch(url, { headers, signal, redirect: "error" });
  if (!response.ok) throw new Error(`Model catalog returned HTTP ${response.status}`);
  if (!response.body) throw new Error("Empty model catalog");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
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
  if (!data || typeof data !== "object" || !("data" in data) || !Array.isArray(data.data)) throw new Error("Unsupported model catalog");
  const models = new Map<string, { id: string; name: string }>();
  for (const item of data.data) {
    if (!item || typeof item !== "object" || typeof item.id !== "string" || !item.id || item.id.length > 256 || /[\u0000-\u001f]/u.test(item.id)) continue;
    const name = typeof item.name === "string" ? item.name : typeof item.display_name === "string" ? item.display_name : item.id;
    models.set(item.id, { id: item.id, name: name.slice(0, 256).replace(/[\u0000-\u001f]/gu, "") || item.id });
    if (models.size >= 500) break;
  }
  return { models: [...models.values()].sort((a, b) => a.id.localeCompare(b.id)), truncated: data.data.length > 500 };
}
