import {
  PLAN_MODE_STATE_ENTRY,
  restorePlanModeState,
} from "./persisted-state.ts";

export type PlanStatus = "inactive" | "planning" | "ready" | "invalid";
export interface PlanControlRequest {
  enabled: boolean;
  expectedRevision: string | null;
}

/** A projection of Pi's branch, never another state store. */
export function projectPlanControl(entries: readonly unknown[]) {
  const restored = restorePlanModeState(entries);
  let revision: string | null = null;
  let hasPrompt = false;
  for (const raw of entries) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    if (entry.type === "custom" && entry.customType === PLAN_MODE_STATE_ENTRY) {
      revision = typeof entry.id === "string" ? entry.id : null;
      const data = entry.data as { status?: unknown } | undefined;
      if (data?.status !== "ready") hasPrompt = false;
    } else if (
      entry.type === "message" &&
      (entry.message as { role?: unknown } | undefined)?.role === "user"
    ) {
      hasPrompt = true;
    }
  }
  const status: PlanStatus = restored.error
    ? "invalid"
    : restored.readyPlan
      ? "ready"
      : restored.planning
        ? "planning"
        : "inactive";
  return { status, revision, hasPrompt: restored.planning && hasPrompt };
}

export class PlanControlError extends Error {
  readonly code: string;
  readonly statusCode: number;
  constructor(message: string, code: string, statusCode: number) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

type Control = (
  request: PlanControlRequest,
) => ReturnType<typeof projectPlanControl>;
// The extension loader and Web runtime may evaluate separate module copies.
const key = Symbol.for("@tt-a1i/openpi/plan-control/v1");
const existing: unknown = Reflect.get(globalThis, key);
if (existing !== undefined && !(existing instanceof WeakMap))
  throw new Error("Incompatible Plan control bridge");
const controls: WeakMap<object, Control> = existing ?? new WeakMap();
if (existing === undefined)
  Object.defineProperty(globalThis, key, { value: controls });

export function registerPlanControl(scope: object, control: Control) {
  if (controls.has(scope))
    throw new Error("Session already has a Plan control owner");
  controls.set(scope, control);
  return () => {
    if (controls.get(scope) === control) controls.delete(scope);
  };
}

export function controlPlan(scope: object, request: PlanControlRequest) {
  const control = controls.get(scope);
  if (!control)
    throw new PlanControlError(
      "Plan control is unavailable for this Session",
      "PLAN_CONTROL_UNAVAILABLE",
      501,
    );
  return control(request);
}
