import type { Model } from "@earendil-works/pi-ai/compat";
import { CURSOR_API_URL } from "./constants.ts";

export type CursorModelDefinition = {
  id: string;
  name: string;
  api: "cursor-agent";
  provider: "cursor";
  baseUrl: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: Model<string>["cost"];
  contextWindow: number;
  maxTokens: number;
  cursorMaxMode?: boolean;
};

const ZERO_COST: CursorModelDefinition["cost"] = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

/**
 * Minimal offline catalog. Cursor's usable-model list is account-specific;
 * `default` is the server-side Auto route and remains valid when discovery is
 * unavailable or the account has no models response.
 */
export const CURSOR_MODELS: CursorModelDefinition[] = [
  {
    id: "default",
    name: "Auto",
    api: "cursor-agent",
    provider: "cursor",
    baseUrl: CURSOR_API_URL,
    reasoning: false,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: 200_000,
    maxTokens: 64_000,
  },
];

export const CURSOR_STATIC_MODELS = CURSOR_MODELS;
