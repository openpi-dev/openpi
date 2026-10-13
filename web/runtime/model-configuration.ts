import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { type WebModelConfiguration, type WebProviderConfigurationChange, type WebProviderConfigurationSummary, WebRuntimeRequestError } from "./types.ts";

const apis = new Set(["openai-responses", "openai-completions", "anthropic-messages"]);
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f]/u.test(value);
const validProvider = (value: unknown): value is string => text(value, 160) && /^[a-zA-Z0-9._-]+$/u.test(value) && !["__proto__", "constructor", "prototype"].includes(value);
const validUrl = (value: unknown): value is string => {
  if (!text(value, 2048)) return false;
  const url = URL.parse(value);
  return !!url && ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
};

export function validModelConfiguration(value: unknown): value is WebModelConfiguration {
  if (!record(value) || Object.keys(value).some((key) => !["provider", "id", "name", "baseUrl", "api", "reasoning", "contextWindow", "maxTokens", "input"].includes(key))) return false;
  if (value.input !== undefined && (!Array.isArray(value.input) || !value.input.length || value.input.length > 2 || new Set(value.input).size !== value.input.length || !value.input.every((item) => item === "text" || item === "image"))) return false;
  if (!validProvider(value.provider) ||
    !text(value.id, 256) || !text(value.name, 256) || !text(value.baseUrl, 2048) ||
    typeof value.api !== "string" || !apis.has(value.api) || typeof value.reasoning !== "boolean") return false;
  if (![value.contextWindow, value.maxTokens].every((n) => n === undefined || (typeof n === "number" && Number.isSafeInteger(n) && n > 0 && n <= 100_000_000))) return false;
  return validUrl(value.baseUrl);
}

export function validProviderConfigurationChange(value: unknown): value is WebProviderConfigurationChange {
  if (!record(value) || Object.keys(value).length !== 2) return false;
  if (value.action === "remove") return validProvider(value.provider);
  const config = value.configuration;
  return value.action === "save" && record(config) && Object.keys(config).length === 5 &&
    validProvider(config.provider) && text(config.name, 160) && validUrl(config.baseUrl) && typeof config.api === "string" && apis.has(config.api) &&
    Array.isArray(config.models) && (config.models.length > 0 || getBuiltinProviders().some((provider) => provider === config.provider)) && config.models.length <= 100 &&
    config.models.every((model) => validModelConfiguration(model) && model.provider === config.provider) &&
    new Set(config.models.map((model) => model.id)).size === config.models.length;
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
  const summaries: WebProviderConfigurationSummary[] = [];
  for (const [provider, config] of Object.entries(providers)) {
    if (!validProvider(provider) || !record(config)) continue;
    const entries = Array.isArray(config.models) ? config.models : [];
    const start = models.length;
    for (const model of entries) {
      if (models.length >= 250) break;
      if (!record(model)) continue;
      const candidate = {
        provider, id: model.id, name: model.name ?? model.id,
        baseUrl: model.baseUrl ?? config.baseUrl, api: model.api ?? config.api,
        reasoning: model.reasoning ?? false,
        ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
        ...(model.maxTokens !== undefined ? { maxTokens: model.maxTokens } : {}),
        ...(model.input !== undefined ? { input: model.input } : {}),
      };
      if (validModelConfiguration(candidate)) models.push(candidate);
      if (models.length >= 250) break;
    }
    summaries.push({ provider, name: text(config.name, 160) ? config.name : provider,
      baseUrl: validUrl(config.baseUrl) ? config.baseUrl : "",
      api: config.api === "openai-responses" || config.api === "openai-completions" || config.api === "anthropic-messages" ? config.api : "",
      editable: (config.models === undefined || Array.isArray(config.models)) && entries.length <= 100 && models.length - start === entries.length,
    });
    if (summaries.length >= 250) break;
  }
  return { revision, models, providers: summaries };
}

export async function saveModelConfiguration(agentDir: string, revision: string, model: WebModelConfiguration) {
  return saveModelConfigurations(agentDir, revision, [model]);
}

export async function saveModelConfigurations(agentDir: string, revision: string, additions: WebModelConfiguration[]) {
  if (!additions.length || additions.length > 100 || !additions.every(validModelConfiguration) || new Set(additions.map((model) => `${model.provider}/${model.id}`)).size !== additions.length) throw new Error("Invalid model configurations");
  const current = await readConfiguration(agentDir);
  if (revision !== current.revision) throw new WebRuntimeRequestError("Model configuration changed; refresh before saving", "MODEL_CONFIGURATION_CONFLICT", 409);
  for (const model of additions) {
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
  }
  await writeConfiguration(current, revision);
}

/** Provider edits reuse the native file and revision guard, retaining unknown fields on surviving models. */
export async function changeProviderConfiguration(agentDir: string, revision: string, change: WebProviderConfigurationChange) {
  if (!validProviderConfigurationChange(change)) throw new Error("Invalid provider configuration");
  const current = await readConfiguration(agentDir);
  if (revision !== current.revision) throw new WebRuntimeRequestError("Model configuration changed; refresh before saving", "MODEL_CONFIGURATION_CONFLICT", 409);
  const id = change.action === "remove" ? change.provider : change.configuration.provider;
  if (change.action === "remove") {
    if (!Object.hasOwn(current.providers, id)) throw new Error("Provider configuration not found");
    delete current.providers[id];
  } else {
    const { provider: _provider, models, ...fields } = change.configuration;
    const previous = current.providers[id];
    if (previous !== undefined && !record(previous)) throw new Error("Invalid provider configuration");
    const config = record(previous) ? previous : {};
    if (previous && !(await readModelConfigurations(agentDir)).providers.some((provider) => provider.provider === id && provider.editable)) throw new Error("Provider has uneditable models");
    const previousModels = Array.isArray(config.models) ? config.models : [];
    current.providers[id] = { ...config, ...fields, ...(previous || getBuiltinProviders().some((provider) => provider === id) ? {} : { authHeader: true }), models: models.map(({ provider: _id, ...model }) => ({
      ...previousModels.find((entry) => record(entry) && entry.id === model.id), ...model,
      // Empty capacity controls remove the override instead of retaining the previous value.
      contextWindow: model.contextWindow, maxTokens: model.maxTokens,
    })) };
  }
  await writeConfiguration(current, revision);
}

async function writeConfiguration(current: Awaited<ReturnType<typeof readConfiguration>>, revision: string) {
  const temporary = `${current.path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(current.value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    if ((await readConfiguration(dirname(current.path))).revision !== revision) throw new WebRuntimeRequestError("Model configuration changed; refresh before saving", "MODEL_CONFIGURATION_CONFLICT", 409);
    await rename(temporary, current.path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}
