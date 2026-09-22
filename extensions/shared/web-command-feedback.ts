import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const WEB_COMMAND_FEEDBACK = "openpi-web-command-feedback";
export const WEB_COMMAND_INPUT = "openpi-web-command-input";
type Feedback = (text: string, level: "info" | "warning" | "error") => void;
const key = Symbol.for("@tt-a1i/openpi/web-command-feedback/v1");
const existing: unknown = Reflect.get(globalThis, key);
if (existing !== undefined && !(existing instanceof WeakMap))
  throw new Error("Incompatible Web feedback bridge");
const bridges: WeakMap<object, Feedback> = existing ?? new WeakMap();
if (existing === undefined)
  Object.defineProperty(globalThis, key, { value: bridges });

export function registerWebCommandFeedback(scope: object, feedback: Feedback) {
  if (bridges.has(scope))
    throw new Error("Session already has a Web feedback bridge");
  bridges.set(scope, feedback);
  return () => {
    if (bridges.get(scope) === feedback) bridges.delete(scope);
  };
}

export function publishWebCommandFeedback(
  scope: object,
  text: string,
  level: "info" | "warning" | "error" = "info",
) {
  const feedback = bridges.get(scope);
  if (!feedback) return false;
  feedback(text, level);
  return true;
}

export function notifyWebCommand(
  ctx: Pick<ExtensionContext, "ui" | "sessionManager">,
  text: string,
  level: "info" | "warning" | "error" = "info",
) {
  if (!publishWebCommandFeedback(ctx.sessionManager, text, level))
    ctx.ui.notify(text, level);
}
