/**
 * Static Antigravity model table.
 *
 * This is the offline fallback so the provider is usable before (or without)
 * discovery. The live source of truth is the Cloud Code Assist
 * `fetchAvailableModels` endpoint, wired via `createProvider.fetchModels` (see
 * oh-my-pi packages/catalog/src/discovery/antigravity.ts for the reference
 * implementation and its denylist). Wire ids follow the real client:
 * `gemini-*` for Gemini routes, `claude-*[-thinking]` for Claude routes.
 */

import type { Model } from "@earendil-works/pi-ai";

export const ANTIGRAVITY_API_URL = "https://daily-cloudcode-pa.googleapis.com";

export type AntigravityProviderModel = Model<"antigravity-cloudcode"> & {
  requestModelId?: string;
};

const ZERO_COST: AntigravityProviderModel["cost"] = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

// Defaults mirror omp's discovery normalization (200k context, 64k output).
const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_TOKENS = 64_000;

function define(
  id: string,
  name: string,
  reasoning: boolean,
  requestModelId?: string,
  capabilities?: Pick<
    AntigravityProviderModel,
    "input" | "contextWindow" | "maxTokens"
  >,
): AntigravityProviderModel {
  return {
    id,
    name,
    api: "antigravity-cloudcode",
    provider: "google-antigravity",
    baseUrl: ANTIGRAVITY_API_URL,
    reasoning,
    input: capabilities?.input ?? ["text", "image"],
    cost: ZERO_COST,
    contextWindow: capabilities?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: capabilities?.maxTokens ?? DEFAULT_MAX_TOKENS,
    ...(requestModelId ? { requestModelId } : {}),
  };
}

export const ANTIGRAVITY_MODELS: AntigravityProviderModel[] = [
  define(
    "gemini-3.7-flash",
    "Gemini 3.7 Flash (Antigravity)",
    true,
    "gemini-3.7-flash-low",
  ),
  define(
    "gemini-3.5-flash",
    "Gemini 3.5 Flash (Antigravity)",
    true,
    "gemini-3.5-flash-extra-low",
  ),
  define(
    "gemini-3.1-pro",
    "Gemini 3.1 Pro (Antigravity)",
    true,
    "gemini-3.1-pro-low",
  ),
  define("claude-sonnet-4-6", "Claude Sonnet 4.6 (Antigravity)", true),
  define("claude-opus-4-6", "Claude Opus 4.6 (Antigravity)", true),
  define(
    "gpt-oss-120b",
    "GPT OSS 120B (Antigravity)",
    true,
    "gpt-oss-120b-medium",
    { input: ["text"], contextWindow: 131_072, maxTokens: 32_768 },
  ),
];
