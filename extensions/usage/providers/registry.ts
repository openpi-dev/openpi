import type { ProviderUsageAdapter } from "../types.ts";
import { cursorAdapter } from "./cursor.ts";
import { googleAntigravityAdapter } from "./google-antigravity.ts";
import { openaiCodexAdapter } from "./openai-codex.ts";

export const DEFAULT_ADAPTERS: readonly ProviderUsageAdapter[] = [
  cursorAdapter,
  googleAntigravityAdapter,
  openaiCodexAdapter,
];
