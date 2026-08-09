import {
  loadSetupConfig,
  type ReasoningLevel,
  type SuggestionModelConfig,
} from "../../shared/setup-config.ts";

export type SuggestionConfig = SuggestionModelConfig;
export type { ReasoningLevel };

export function loadSuggestionConfig() {
  return loadSetupConfig().suggestions.model;
}
