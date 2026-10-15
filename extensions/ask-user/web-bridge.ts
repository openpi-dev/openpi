import type { AskUserAnswer, AskUserInput } from "./index.ts";

export interface WebHandoffPresentation {
  title: string;
  instructions: string;
  completionSignal: string;
}

export type WebQuestionOutcome =
  | { kind: "answered"; answers: AskUserAnswer[] }
  | { kind: "dismissed" | "cancelled" | "expired" | "unavailable" };

type QuestionBridge = (
  toolCallId: string,
  questions: AskUserInput["questions"],
  signal?: AbortSignal,
  handoff?: WebHandoffPresentation,
) => Promise<WebQuestionOutcome>;

// Pi's extension loader and the Web CLI can evaluate different module copies.
// Share only same-process Session-owned transports; never persist resolvers.
const key = Symbol.for("@tt-a1i/openpi/web-questions/v1");
const existing: unknown = Reflect.get(globalThis, key);
if (existing !== undefined && !(existing instanceof WeakMap)) {
  throw new Error("Incompatible OpenPI Web question bridge");
}
const bridges: WeakMap<object, QuestionBridge> = existing ?? new WeakMap();
if (existing === undefined) {
  Object.defineProperty(globalThis, key, { value: bridges });
}

export function registerWebQuestionBridge(
  scope: object,
  bridge: QuestionBridge,
) {
  if (bridges.has(scope))
    throw new Error("Session already has a Web question bridge");
  bridges.set(scope, bridge);
  return () => {
    if (bridges.get(scope) === bridge) bridges.delete(scope);
  };
}

export function askWebQuestions(
  scope: object,
  toolCallId: string,
  questions: AskUserInput["questions"],
  signal?: AbortSignal,
  handoff?: WebHandoffPresentation,
) {
  return bridges.get(scope)?.(toolCallId, questions, signal, handoff);
}
