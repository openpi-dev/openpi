/**
 * Antigravity model discovery.
 *
 * `POST /v1internal:fetchAvailableModels` returns a map of wire model id to
 * metadata (reference: omp packages/catalog/src/discovery/antigravity.ts).
 * Static models are the provider baseline. Network/protocol failures throw so
 * createProvider can retain the last successfully persisted dynamic catalog.
 */

import type { RefreshModelsContext } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { ensureAntigravityVersion, getAntigravityUserAgent } from "./oauth.ts";
import {
  ANTIGRAVITY_API_URL,
  type AntigravityProviderModel,
} from "./models.ts";
import {
  collapseAntigravityModels,
  type AntigravityModelDefinition,
} from "./routing.ts";

const DISCOVERY_ENDPOINTS = [
  "https://daily-cloudcode-pa.googleapis.com",
  "https://daily-cloudcode-pa.sandbox.googleapis.com",
] as const;
const FETCH_AVAILABLE_MODELS_PATH = "/v1internal:fetchAvailableModels";

// Reference: omp ANTIGRAVITY_DISCOVERY_DENYLIST.
const DISCOVERY_DENYLIST: Record<string, true> = {
  chat_20706: true,
  chat_23310: true,
  "gemini-2.5-pro": true,
};

const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_TOKENS = 64_000;

const DiscoveryModelSchema = Type.Object({
  displayName: Type.Optional(Type.String()),
  supportsImages: Type.Optional(Type.Boolean()),
  supportsThinking: Type.Optional(Type.Boolean()),
  maxTokens: Type.Optional(Type.Number()),
  maxOutputTokens: Type.Optional(Type.Number()),
  isInternal: Type.Optional(Type.Boolean()),
});

const DiscoveryResponseSchema = Type.Object({
  models: Type.Optional(Type.Record(Type.String(), DiscoveryModelSchema)),
});

type DiscoveryResponse = Static<typeof DiscoveryResponseSchema>;

type DiscoveredModel = AntigravityProviderModel & AntigravityModelDefinition;

function positiveNumber(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

function toModelDefinition(
  id: string,
  meta: Static<typeof DiscoveryModelSchema>,
): DiscoveredModel {
  const advertisedMaxTokens = positiveNumber(
    meta.maxOutputTokens,
    DEFAULT_MAX_TOKENS,
  );
  return {
    id,
    name: meta.displayName ?? id,
    api: "antigravity-cloudcode",
    provider: "google-antigravity",
    baseUrl: ANTIGRAVITY_API_URL,
    reasoning: meta.supportsThinking === true,
    input: meta.supportsImages === true ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: positiveNumber(meta.maxTokens, DEFAULT_CONTEXT_WINDOW),
    maxTokens: id.toLowerCase().includes("claude")
      ? Math.min(advertisedMaxTokens, DEFAULT_MAX_TOKENS)
      : advertisedMaxTokens,
  };
}

export async function fetchAntigravityModels(
  context: RefreshModelsContext,
): Promise<DiscoveredModel[]> {
  if (!context.allowNetwork) return [];
  context.signal.throwIfAborted();
  const credential = context.credential;
  if (!credential || credential.type !== "oauth") return [];
  await ensureAntigravityVersion(context.signal);

  for (const endpoint of DISCOVERY_ENDPOINTS) {
    if (context.signal.aborted) break;
    try {
      const response = await fetch(
        `${endpoint}${FETCH_AVAILABLE_MODELS_PATH}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${credential.access}`,
            "Content-Type": "application/json",
            "User-Agent": getAntigravityUserAgent(),
          },
          body: "{}",
          signal: context.signal,
        },
      );
      if (!response.ok) continue;
      const parsed = Value.Parse(
        DiscoveryResponseSchema,
        await response.json(),
      ) as DiscoveryResponse;
      if (!parsed.models) continue;
      const discovered = Object.entries(parsed.models)
        .filter(
          ([id, meta]) =>
            !Object.hasOwn(DISCOVERY_DENYLIST, id) && meta.isInternal !== true,
        )
        .map(([id, meta]) => toModelDefinition(id, meta));
      return collapseAntigravityModels(discovered);
    } catch {
      // Try the next endpoint; total failure must preserve the stored catalog.
    }
  }
  context.signal.throwIfAborted();
  throw new Error("Antigravity model discovery failed on all endpoints");
}
