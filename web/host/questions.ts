import { randomUUID, timingSafeEqual } from "node:crypto";
import type { WebQuestionOutcome, WebHandoffPresentation } from "../../extensions/ask-user/web-bridge.ts";
import {
  parseWebQuestionAnswers,
  validateWebQuestions,
  validHandoff,
  WEB_QUESTION_TIMEOUT_MS,
  type WebQuestionReceipt,
  type WebQuestionRequest,
  type WebQuestions,
  type WebQuestionState,
} from "../protocol/questions.ts";

export interface QuestionOwner {
  workspace: string;
  sessionId: string;
  commandId: string;
  epoch: number;
  controllerId: string;
}

function sameOwner(a: QuestionOwner, b: QuestionOwner | undefined) {
  return b !== undefined && a.workspace === b.workspace && a.sessionId === b.sessionId &&
    a.commandId === b.commandId && a.epoch === b.epoch && a.controllerId === b.controllerId;
}

function isController(owner: QuestionOwner, controllerId: string) {
  return owner.controllerId.length === controllerId.length &&
    timingSafeEqual(Buffer.from(owner.controllerId), Buffer.from(controllerId));
}

/** One sequential ask_user per active run. All waits and receipts are bounded. */
export class WebQuestionBroker {
  private pending?: {
    owner: QuestionOwner;
    request: WebQuestionRequest;
    settle: (state: WebQuestionState, answers?: NonNullable<ReturnType<typeof parseWebQuestionAnswers>>) => void;
  };
  private readonly terminal = new Map<string, { owner: QuestionOwner; state: WebQuestionState }>();
  private readonly owner: () => QuestionOwner | undefined;
  private readonly changed: () => void;
  private readonly timeoutMs: number;

  constructor(
    owner: () => QuestionOwner | undefined,
    changed: () => void,
    timeoutMs = WEB_QUESTION_TIMEOUT_MS,
  ) {
    this.owner = owner;
    this.changed = changed;
    this.timeoutMs = timeoutMs;
  }

  request(toolCallId: string, questions: WebQuestions, signal?: AbortSignal, handoff?: WebHandoffPresentation) {
    this.reconcile();
    const owner = this.owner();
    if (!owner || this.pending || !validateWebQuestions(questions) || toolCallId.length > 256 || (handoff && !validHandoff(handoff))) {
      return Promise.resolve<WebQuestionOutcome>({ kind: "unavailable" });
    }
    if (signal?.aborted) return Promise.resolve<WebQuestionOutcome>({ kind: "cancelled" });
    const request: WebQuestionRequest = {
      requestId: randomUUID(),
      sessionId: owner.sessionId,
      toolCallId,
      expiresAt: Date.now() + this.timeoutMs,
      questions: structuredClone(questions),
      ...(handoff ? { handoff: structuredClone(handoff) } : {}),
    };
    return new Promise<WebQuestionOutcome>((resolve) => {
      const cancel = () => settle("cancelled");
      const timer = setTimeout(() => settle("expired"), this.timeoutMs);
      timer.unref();
      const settle = (state: WebQuestionState, answers?: NonNullable<ReturnType<typeof parseWebQuestionAnswers>>) => {
        if (this.pending?.request.requestId !== request.requestId) return;
        this.pending = undefined;
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
        if (this.terminal.size >= 128) this.terminal.delete(this.terminal.keys().next().value!);
        this.terminal.set(request.requestId, { owner, state });
        resolve(state === "answered" && answers
          ? { kind: "answered", answers }
          : { kind: state === "stale" || state === "answered" ? "cancelled" : state });
        this.changed();
      };
      this.pending = { owner, request, settle };
      signal?.addEventListener("abort", cancel, { once: true });
      this.changed();
    });
  }

  reconcile() {
    if (this.pending && !sameOwner(this.pending.owner, this.owner())) this.pending.settle("stale");
    if (this.pending && Date.now() >= this.pending.request.expiresAt) this.pending.settle("expired");
  }

  read(sessionId: string, controllerId: string) {
    this.reconcile();
    const p = this.pending;
    return p && p.owner.sessionId === sessionId && isController(p.owner, controllerId)
      ? structuredClone(p.request) : null;
  }

  answer(sessionId: string, requestId: string, controllerId: string, action: unknown, input: unknown) {
    this.reconcile();
    const p = this.pending?.request.requestId === requestId ? this.pending : undefined;
    const terminal = this.terminal.get(requestId);
    const owner = p?.owner ?? terminal?.owner;
    if (!owner || owner.sessionId !== sessionId) return { status: 409, body: { state: "stale", code: "STALE_QUESTION" } } as const;
    if (!isController(owner, controllerId)) return { status: 403, body: { error: "Only the initiating tab can answer", code: "NOT_CONTROLLER" } } as const;
    if (terminal) return { status: 200, body: { state: terminal.state, replayed: true } satisfies WebQuestionReceipt };
    if (!p) return { status: 409, body: { state: "stale", code: "STALE_QUESTION" } } as const;
    if (action === "dismiss" && input === undefined) {
      p.settle("dismissed");
      return { status: 200, body: { state: "dismissed" } satisfies WebQuestionReceipt };
    }
    const answers = action === "answer" ? parseWebQuestionAnswers(p.request.questions, input) : undefined;
    if (!answers || (p.request.handoff && answers.some((answer) => !answer.selected))) return { status: 400, body: { error: "Answers must match every question and its allowed choices", code: "INVALID_ANSWERS" } } as const;
    p.settle("answered", answers);
    return { status: 200, body: { state: "answered" } satisfies WebQuestionReceipt };
  }

  cancel() {
    this.pending?.settle("cancelled");
  }
}
