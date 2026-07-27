import {
  loadSetupConfig,
  type ReasoningLevel,
  type SummaryModelConfig,
} from "../../shared/setup-config.ts";

export type SummaryConfig = SummaryModelConfig;
export type { ReasoningLevel };

export function loadSummaryConfig() {
  return loadSetupConfig().summaries.model;
}
