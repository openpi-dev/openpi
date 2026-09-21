import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { WebModelConfiguration } from "./types.ts";

const apis = new Set(["openai-responses", "openai-completions", "anthropic-messages"]);
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f]/u.test(value);

export function validModelConfiguration(value: unknown): value is WebModelConfiguration {
  if (!record(value) || Object.keys(value).length !== 8) return false;
  if (!text(value.provider, 160) || !/^[a-zA-Z0-9._-]+$/u.test(value.provider) || ["__proto__", "constructor", "prototype"].includes(value.provider) ||
    !text(value.id, 256) || !text(value.name, 256) || !text(value.baseUrl, 2048) ||
    !apis.has(String(value.api)) || typeof value.reasoning !== "boolean") return false;
  if (![value.contextWindow, value.maxTokens].every((n) => typeof n === "number" && Number.isSafeInteger(n) && n > 0 && n <= 100_000_000)) return false;
  const url = URL.parse(value.baseUrl);
  return !!url && ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
}

async function readConfiguration(agentDir: string) {
  const path = join(agentDir, "models.json");
  let source = "";
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.size > 2 * 1024 * 1024) throw new Error("Unsupported models.json file");
    source = await readFile(path, "utf8");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const value: unknown = source ? JSON.parse(source) : { providers: {} };
  if (!record(value) || !record(value.providers)) throw new Error("Invalid models.json");
  return { path, value, providers: value.providers, revision: createHash("sha256").update(source).digest("hex") };
}

/** Only allowlisted, non-secret fields leave the native configuration file. */
export async function readModelConfigurations(agentDir: string) {
  const { providers, revision } = await readConfiguration(agentDir);
  const models: WebModelConfiguration[] = [];
  for (const [provider, config] of Object.entries(providers)) {
    if (!record(config) || !Array.isArray(config.models)) continue;
    for (const model of config.models) {
      if (!record(model)) continue;
      const candidate = {
        provider, id: model.id, name: model.name ?? model.id,
        baseUrl: model.baseUrl ?? config.baseUrl, api: model.api ?? config.api,
        reasoning: model.reasoning ?? false,
        contextWindow: model.contextWindow ?? 128000, maxTokens: model.maxTokens ?? 16384,
      };
      if (validModelConfiguration(candidate)) models.push(candidate);
      if (models.length >= 250) break;
    }
    if (models.length >= 250) break;
  }
  return { revision, models };
}

export async function saveModelConfiguration(agentDir: string, revision: string, model: WebModelConfiguration) {
  if (!validModelConfiguration(model)) throw new Error("Invalid model configuration");
  const current = await readConfiguration(agentDir);
  if (revision !== current.revision) throw new Error("Model configuration changed; refresh before saving");
  const previous = current.providers[model.provider];
  if (previous !== undefined && !record(previous)) throw new Error("Invalid provider configuration");
  const config = record(previous) ? previous : {};
  if (config.models !== undefined && !Array.isArray(config.models)) throw new Error("Invalid existing model list");
  const models = Array.isArray(config.models) ? [...config.models] : [];
  const index = models.findIndex((entry) => record(entry) && entry.id === model.id);
  const { provider: _provider, ...fields } = model;
  const entry = { ...(index >= 0 && record(models[index]) ? models[index] : {}), ...fields };
  if (index >= 0) models[index] = entry;
  else models.push(entry);
  current.providers[model.provider] = {
    ...config,
    // New custom providers need a provider-level endpoint/API. Existing provider
    // defaults remain intact; per-model overrides avoid changing sibling models.
    ...(previous ? {} : { baseUrl: model.baseUrl, api: model.api, authHeader: true }),
    models,
  };
  const temporary = `${current.path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(current.value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    if ((await readConfiguration(agentDir)).revision !== revision) throw new Error("Model configuration changed; refresh before saving");
    await rename(temporary, current.path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}
