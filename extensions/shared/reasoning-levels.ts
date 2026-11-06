import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

// Browser-safe projection of the native levels, including hosts that only
// export their type and do not provide providers/model-schema at runtime.
export const REASONING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly ModelThinkingLevel[];

export type ReasoningLevel = (typeof REASONING_LEVELS)[number];
