import { cleanupQuestions } from "../../extensions/shared/web-cleanup-confirmation.ts";
import { randomUUID, timingSafeEqual } from "node:crypto";
import type { WebQuestionOutcome, WebHandoffPresentation, WebCleanupTarget } from "../../extensions/ask-user/web-bridge.ts";
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
  sessionPath?: string;
  sessionId: string;
  commandId: string;
  epoch: number;
  controllerId: string;
}

function sameOwner(a: QuestionOwner, b: QuestionOwner | undefined) {
  return b !== undefined && a.workspace === b.workspace && a.sessionPath === b.sessionPath && a.sessionId === b.sessionId &&
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
  private readonly terminal = new Map<string, { owner: QuestionOwner; receipt: WebQuestionReceipt }>();
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

  request(toolCallId: string, questions: WebQuestions, signal?: AbortSignal, handoff?: WebHandoffPresentation, cleanup?: WebCleanupTarget) {
    this.reconcile();
    const candidate = this.owner();
    const owner = candidate && structuredClone(candidate);
    if (!owner || this.pending || !validateWebQuestions(questions) || toolCallId.length > 256 || (handoff && !validHandoff(handoff))) {
      return Promise.resolve<WebQuestionOutcome>({ kind: "unavailable" });
    }
    if (cleanup && (handoff || cleanup.workspace !== owner.workspace || !Array.isArray(cleanup.paths) ||
        !cleanup.paths.length || cleanup.paths.some((p) => typeof p !== "string" || !p || /[\r\n\0]/u.test(p)) ||
        JSON.stringify(questions) !== JSON.stringify(cleanupQuestions(cleanup)))) return Promise.resolve<WebQuestionOutcome>({ kind: "unavailable" });
    if (signal?.aborted) return Promise.resolve<WebQuestionOutcome>({ kind: "cancelled" });
    const request: WebQuestionRequest = {
      requestId: randomUUID(),
      sessionId: owner.sessionId,
      toolCallId,
      expiresAt: Date.now() + this.timeoutMs,
      questions: structuredClone(questions),
      ...(handoff ? { handoff: structuredClone(handoff) } : {}),
      ...(cleanup ? { cleanup: structuredClone(cleanup) } : {}),
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
        const cleanupDecision = request.cleanup ? state === "answered"
          ? answers?.[0]?.selected === "Approve exact deletion" ? "approved" : "denied"
          : state === "dismissed" ? "denied" : state : undefined;
        this.terminal.set(request.requestId, { owner, receipt: { state, ...(cleanupDecision ? { cleanupDecision, cleanupTarget: structuredClone(request.cleanup) } : {}) } });
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

  receipt(sessionId: string, requestId: string, controllerId: string) {
    this.reconcile();
    const terminal = this.terminal.get(requestId);
    return terminal && terminal.owner.sessionId === sessionId && isController(terminal.owner, controllerId)
      ? structuredClone({ ...terminal.receipt, replayed: true }) : null;
  }

  waitingSessionId() {
    this.reconcile();
    return this.pending?.owner.sessionId;
  }

  answer(sessionId: string, requestId: string, controllerId: string, action: unknown, input: unknown) {
    this.reconcile();
    const p = this.pending?.request.requestId === requestId ? this.pending : undefined;
    const terminal = this.terminal.get(requestId);
    const owner = p?.owner ?? terminal?.owner;
    if (!owner || owner.sessionId !== sessionId) return { status: 409, body: { state: "stale", code: "STALE_QUESTION" } } as const;
    if (!isController(owner, controllerId)) return { status: 403, body: { error: "Only the initiating tab can answer", code: "NOT_CONTROLLER" } } as const;
    if (terminal) return { status: 200, body: { ...terminal.receipt, replayed: true } satisfies WebQuestionReceipt };
    if (!p) return { status: 409, body: { state: "stale", code: "STALE_QUESTION" } } as const;
    if (action === "dismiss" && input === undefined) {
      p.settle("dismissed");
      return { status: 200, body: { state: "dismissed", ...(p.request.cleanup ? { cleanupDecision: "denied" as const, cleanupTarget: structuredClone(p.request.cleanup) } : {}) } satisfies WebQuestionReceipt };
    }
    const answers = action === "answer" ? parseWebQuestionAnswers(p.request.questions, input) : undefined;
    if (!answers || (p.request.handoff && answers.some((answer) => !answer.selected)) || (p.request.cleanup && answers.some((answer) => !answer.selected || answer.note !== undefined))) return { status: 400, body: { error: "Answers must match every question and its allowed choices", code: "INVALID_ANSWERS" } } as const;
    p.settle("answered", answers);
    return { status: 200, body: { state: "answered", ...(p.request.cleanup ? { cleanupTarget: structuredClone(p.request.cleanup), cleanupDecision: answers[0]?.selected === "Approve exact deletion" ? "approved" as const : "denied" as const } : {}) } satisfies WebQuestionReceipt };
  }

  cancel() {
    this.pending?.settle("cancelled");
  }
}
