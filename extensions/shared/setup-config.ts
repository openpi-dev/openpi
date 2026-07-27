import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const REASONING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ReasoningLevel = (typeof REASONING_LEVELS)[number];

export interface SummaryModelConfig {
  readonly provider: string;
  readonly model: string;
  readonly reasoning: ReasoningLevel;
}

export const DEFAULT_WORKFLOW_CONCURRENCY = 8;
export const DEFAULT_WORKFLOW_MAX_AGENT_CALLS = 128;
export const MAX_WORKFLOW_CONCURRENCY = 64;
export const MAX_WORKFLOW_AGENT_CALLS = 1_024;

export interface MyPiSetupConfig {
  readonly summaries: {
    readonly enabled: boolean;
    readonly model?: SummaryModelConfig;
  };
  readonly workflows: {
    readonly concurrency: number;
    readonly maxAgentCalls: number;
  };
  readonly ui: {
    readonly showHeader: boolean;
    readonly customFooter: boolean;
  };
}

export const DEFAULT_SETUP_CONFIG: MyPiSetupConfig = {
  summaries: { enabled: false },
  workflows: {
    concurrency: DEFAULT_WORKFLOW_CONCURRENCY,
    maxAgentCalls: DEFAULT_WORKFLOW_MAX_AGENT_CALLS,
  },
  ui: {
    showHeader: false,
    customFooter: true,
  },
};

export const SETUP_CONFIG_PATH = join(getAgentDir(), "my-pi-setup.json");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isReasoningLevel = (value: unknown): value is ReasoningLevel =>
  typeof value === "string" &&
  REASONING_LEVELS.includes(value as ReasoningLevel);

function boundedInteger(value: unknown, fallback: number, maximum: number) {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= maximum
    ? value
    : fallback;
}

export function parseSetupConfig(value: unknown): MyPiSetupConfig {
  if (!isRecord(value)) return DEFAULT_SETUP_CONFIG;

  const summaries = isRecord(value.summaries) ? value.summaries : {};
  const enabled =
    typeof summaries.enabled === "boolean" ? summaries.enabled : false;
  const rawModel = isRecord(summaries.model) ? summaries.model : undefined;
  const model =
    rawModel &&
    typeof rawModel.provider === "string" &&
    rawModel.provider.trim() &&
    typeof rawModel.model === "string" &&
    rawModel.model.trim() &&
    isReasoningLevel(rawModel.reasoning)
      ? {
          provider: rawModel.provider.trim(),
          model: rawModel.model.trim(),
          reasoning: rawModel.reasoning,
        }
      : undefined;

  const workflows = isRecord(value.workflows) ? value.workflows : {};
  const ui = isRecord(value.ui) ? value.ui : {};
  return {
    summaries: { enabled, ...(model ? { model } : {}) },
    workflows: {
      concurrency: boundedInteger(
        workflows.concurrency,
        DEFAULT_WORKFLOW_CONCURRENCY,
        MAX_WORKFLOW_CONCURRENCY,
      ),
      maxAgentCalls: boundedInteger(
        workflows.maxAgentCalls,
        DEFAULT_WORKFLOW_MAX_AGENT_CALLS,
        MAX_WORKFLOW_AGENT_CALLS,
      ),
    },
    ui: {
      showHeader: typeof ui.showHeader === "boolean" ? ui.showHeader : false,
      customFooter:
        typeof ui.customFooter === "boolean" ? ui.customFooter : true,
    },
  };
}

export function loadSetupConfig() {
  try {
    return parseSetupConfig(
      JSON.parse(readFileSync(SETUP_CONFIG_PATH, "utf8")),
    );
  } catch {
    return DEFAULT_SETUP_CONFIG;
  }
}

export async function saveSetupConfig(config: MyPiSetupConfig) {
  const tempPath = `${SETUP_CONFIG_PATH}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(getAgentDir(), { recursive: true });
  try {
    await writeFile(tempPath, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(tempPath, SETUP_CONFIG_PATH);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

export function formatSetupConfig(config = loadSetupConfig()) {
  const summary = !config.summaries.enabled
    ? "Run recaps: disabled"
    : config.summaries.model
      ? `Run recaps: ${config.summaries.model.provider}/${config.summaries.model.model} · ${config.summaries.model.reasoning}`
      : "Run recaps: local fallback (no model calls)";
  return [
    summary,
    `Workflows: ${config.workflows.concurrency} concurrent agents · ${config.workflows.maxAgentCalls} total calls`,
    `UI: large header ${config.ui.showHeader ? "on" : "off"} · custom footer ${config.ui.customFooter ? "on" : "off"}`,
  ].join("\n");
}
