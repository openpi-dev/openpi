import { sanitizeTerminalText } from "../shared/terminal-text.ts";

export const MAX_READY_PLAN_CHARS = 50_000;
export const MAX_READY_PLAN_UTF8_BYTES = 48_000;
export const PLAN_MODE_STATE_ENTRY = "my-pi-setup-plan-mode-state";

export type PersistedPlanModeState =
  | { version: 1; status: "inactive" | "planning" }
  | { version: 1; status: "ready"; plan: string };

export interface RestoredPlanModeState {
  planning: boolean;
  readyPlan?: string;
  error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedReadyPlan(value: unknown): value is string {
  return (
    typeof value === "string" &&
    sanitizeTerminalText(value) === value &&
    value.trim().length > 0 &&
    value.length <= MAX_READY_PLAN_CHARS &&
    new TextEncoder().encode(value.trim()).byteLength <=
      MAX_READY_PLAN_UTF8_BYTES
  );
}

function decodePlanModeState(data: unknown): RestoredPlanModeState | undefined {
  if (
    !isRecord(data) ||
    data.version !== 1 ||
    typeof data.status !== "string"
  ) {
    return;
  }
  const keys = Object.keys(data).sort().join(",");
  if (data.status === "inactive" || data.status === "planning") {
    if (keys !== "status,version") return;
    return { planning: data.status === "planning" };
  }
  if (data.status === "ready" && keys === "plan,status,version") {
    if (!isBoundedReadyPlan(data.plan)) return;
    return { planning: true, readyPlan: data.plan.trim() };
  }
}

/** Restore only the newest branch-local state; malformed state fails closed. */
export function restorePlanModeState(
  entries: readonly unknown[],
): RestoredPlanModeState {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (
      !isRecord(entry) ||
      entry.type !== "custom" ||
      entry.customType !== PLAN_MODE_STATE_ENTRY
    ) {
      continue;
    }
    return (
      decodePlanModeState(entry.data) ?? {
        planning: true,
        error:
          "The latest persisted Plan Mode state is malformed; writes remain blocked. Use `/plan off` to clear it explicitly.",
      }
    );
  }
  return { planning: false };
}
