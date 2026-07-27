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

export interface MyPiSetupConfig {
  readonly summaries: {
    readonly enabled: boolean;
    readonly model?: SummaryModelConfig;
  };
}

export const DEFAULT_SETUP_CONFIG: MyPiSetupConfig = {
  summaries: { enabled: true },
};

export const SETUP_CONFIG_PATH = join(getAgentDir(), "my-pi-setup.json");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isReasoningLevel = (value: unknown): value is ReasoningLevel =>
  typeof value === "string" &&
  REASONING_LEVELS.includes(value as ReasoningLevel);

export function parseSetupConfig(value: unknown): MyPiSetupConfig {
  if (!isRecord(value) || !isRecord(value.summaries)) {
    return DEFAULT_SETUP_CONFIG;
  }

  const summaries = value.summaries;
  const enabled =
    typeof summaries.enabled === "boolean" ? summaries.enabled : true;
  if (!isRecord(summaries.model)) return { summaries: { enabled } };

  const model = summaries.model;
  if (
    typeof model.provider !== "string" ||
    !model.provider.trim() ||
    typeof model.model !== "string" ||
    !model.model.trim() ||
    !isReasoningLevel(model.reasoning)
  ) {
    return { summaries: { enabled } };
  }

  return {
    summaries: {
      enabled,
      model: {
        provider: model.provider.trim(),
        model: model.model.trim(),
        reasoning: model.reasoning,
      },
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
  if (!config.summaries.enabled) return "Run recaps: disabled";
  if (!config.summaries.model) {
    return "Run recaps: local fallback (no model calls)";
  }
  const model = config.summaries.model;
  return `Run recaps: ${model.provider}/${model.model} · ${model.reasoning}`;
}
