import {
  ArrowLeft,
  ArrowRight,
  Check,
  MessageCircleQuestion,
  Pencil,
  RotateCcw,
  X,
} from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  answerDraftByteLength,
  answerDraftFits,
  MAX_ANSWER_DRAFT_UTF8_BYTES,
} from "../../../../../extensions/ask-user/limits.ts";
import type {
  WebQuestionAnswers,
  WebQuestionReceipt,
  WebQuestionRequest,
} from "../../../../protocol/questions.ts";
import { WebClient } from "../../protocol/client.ts";

type Draft = {
  choice: number | "custom" | null;
  custom: string;
  notes: Record<number, string>;
  notesExpanded?: boolean;
};

type QuestionWorkingPosition = {
  sessionId: string;
  sessionPath: string;
  requestId: string;
  drafts: Draft[];
  index: number;
  review: boolean;
  submission: { answers: WebQuestionAnswers | null } | null;
};

export type QuestionWorkingCache = Map<string, QuestionWorkingPosition>;

const MAX_QUESTION_DRAFTS = 32;
const MAX_QUESTION_DRAFT_BYTES = 1024 * 1024;

function workingBytes(position: QuestionWorkingPosition) {
  return position.drafts.reduce(
    (total, draft) =>
      total +
      answerDraftByteLength(draft.custom) +
      Object.values(draft.notes).reduce(
        (bytes, note) => bytes + answerDraftByteLength(note),
        0,
      ),
    0,
  );
}

function rememberWorking(
  cache: QuestionWorkingCache,
  key: string,
  next: QuestionWorkingPosition,
) {
  const hasDraft =
    next.submission ||
    next.drafts.some(
      (draft) =>
        draft.choice !== null ||
        draft.custom ||
        Object.values(draft.notes).some(Boolean),
    );
  if (!hasDraft) {
    cache.delete(key);
    return true;
  }
  const previous = cache.get(key);
  if (!previous && cache.size >= MAX_QUESTION_DRAFTS) return false;
  const previousBytes = previous ? workingBytes(previous) : 0;
  const nextBytes = workingBytes(next);
  const retainedBytes = Array.from(cache.values()).reduce(
    (bytes, position) => bytes + workingBytes(position),
    0,
  );
  if (
    nextBytes > previousBytes &&
    retainedBytes - previousBytes + nextBytes > MAX_QUESTION_DRAFT_BYTES
  )
    return false;
  cache.set(key, next);
  return true;
}

function retireWorking(
  cache: QuestionWorkingCache,
  sessionId: string,
  sessionPath: string,
  pendingRequestId?: string,
) {
  for (const [key, position] of cache) {
    if (
      position.sessionId === sessionId &&
      position.sessionPath === sessionPath &&
      position.requestId !== pendingRequestId
    )
      cache.delete(key);
  }
}

export function QuestionCard({
  request,
  answer,
  onSettled,
  connected = true,
  sessionPath = "",
  workingCache,
}: {
  request: WebQuestionRequest;
  answer: (
    request: WebQuestionRequest,
    answers: WebQuestionAnswers | null,
    signal: AbortSignal,
  ) => Promise<WebQuestionReceipt>;
  onSettled: (receipt: WebQuestionReceipt) => void;
  connected?: boolean;
  sessionPath?: string;
  workingCache?: QuestionWorkingCache;
}) {
  const { t } = useTranslation();
  const id = useId();
  const localCache = useMemo<QuestionWorkingCache>(() => new Map(), []);
  const cache = workingCache ?? localCache;
  const key = JSON.stringify([
    request.sessionId,
    sessionPath,
    request.requestId,
  ]);
  const [working, setWorking] = useState<QuestionWorkingPosition>(
    () =>
      cache.get(key) ?? {
        sessionId: request.sessionId,
        sessionPath,
        requestId: request.requestId,
        drafts: request.questions.map(() => ({
          choice: null,
          custom: "",
          notes: {},
        })),
        index: 0,
        review: false,
        submission: null,
      },
  );
  const workingRef = useRef(working);
  const { drafts, index, review, submission } = working;
  const [error, setError] = useState(Boolean(working.submission));
  const [draftLimit, setDraftLimit] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const submitted = Boolean(submission);
  const controller = useRef<AbortController | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const question = request.questions[index]!;
  const draft = drafts[index]!;
  const locked = busy || submitted || !connected;
  const overflow = drafts.some((d) =>
    d.choice === "custom"
      ? !answerDraftFits(d.custom)
      : typeof d.choice === "number" &&
        !answerDraftFits(d.notes[d.choice] ?? ""),
  );
  const complete = drafts.every((d) => d.choice !== null) && !overflow;
  const choiceLabel = (label: string | undefined, index: number) =>
    request.handoff ? t(index === 0 ? "handoffDone" : "handoffUnable") : label;

  useEffect(() => () => controller.current?.abort(), []);
  const commitWorking = (next: QuestionWorkingPosition) => {
    if (!rememberWorking(cache, key, next)) {
      setDraftLimit(true);
      return false;
    }
    workingRef.current = next;
    setWorking(next);
    setDraftLimit(false);
    return true;
  };
  // Focus moves only after deliberate navigation, never on a background refresh.
  const navigate = (next: number, toReview = false) => {
    commitWorking({ ...workingRef.current, index: next, review: toReview });
    requestAnimationFrame(() => heading.current?.focus());
  };
  const update = (patch: Partial<Draft>) => {
    const current = workingRef.current;
    commitWorking({
      ...current,
      drafts: current.drafts.map((d, i) =>
        i === current.index ? { ...d, ...patch } : d,
      ),
    });
  };
  const answers = () =>
    request.questions.map((q, i) => {
      const d = drafts[i]!;
      if (d.choice === "custom")
        return d.custom.trim()
          ? { id: q.id, custom: d.custom }
          : { id: q.id, rephrase: true as const };
      const selected =
        typeof d.choice === "number" ? q.options[d.choice]?.label : undefined;
      return {
        id: q.id,
        selected,
        ...(typeof d.choice === "number" && d.notes[d.choice]?.trim()
          ? { note: d.notes[d.choice] }
          : {}),
      };
    });
  const send = async (dismiss = false) => {
    if (busyRef.current || !connected || (!dismiss && !submitted && !complete))
      return;
    const original = workingRef.current.submission ?? {
      answers: dismiss ? null : answers(),
    };
    if (!commitWorking({ ...workingRef.current, submission: original })) return;
    busyRef.current = true;
    setBusy(true);
    setError(false);
    const owner = new AbortController();
    controller.current = owner;
    try {
      const receipt = await answer(request, original.answers, owner.signal);
      if (!owner.signal.aborted) {
        cache.delete(key);
        onSettled(receipt);
      }
    } catch {
      if (!owner.signal.aborted) setError(true);
    } finally {
      if (!owner.signal.aborted) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  };

  return (
    <section
      className="question-card"
      aria-labelledby={`${id}-title`}
      aria-busy={busy}
    >
      <header className="question-card-header">
        <span className="question-eyebrow">
          <MessageCircleQuestion aria-hidden="true" />
          {t(request.handoff ? "handoffWaiting" : "questionWaiting")}
        </span>
        <span className="question-count">
          {review
            ? t(request.handoff ? "handoffReview" : "questionReview")
            : t("questionProgress", {
                current: index + 1,
                total: request.questions.length,
              })}
        </span>
        <button
          type="button"
          className="question-icon"
          aria-label={t("questionDismiss")}
          title={t("questionDismiss")}
          disabled={locked}
          onClick={() => void send(true)}
        >
          <X />
        </button>
      </header>
      <div className="question-card-body">
        <h2 id={`${id}-title`} ref={heading} tabIndex={-1}>
          {review ? t("questionReviewTitle") : question.question}
        </h2>
        {request.handoff && (
          <div className="handoff-instructions">
            <p>{request.handoff.instructions}</p>
            <p className="question-help">
              {t("handoffSignal")} {request.handoff.completionSignal}
            </p>
            <p className="question-help">{t("handoffVerify")}</p>
          </div>
        )}
        {review ? (
          <>
            <p className="question-help">{t("questionReviewHelp")}</p>
            <ol className="question-review-list">
              {request.questions.map((q, i) => {
                const d = drafts[i]!;
                return (
                  <li key={q.id}>
                    <div>
                      <span className="question-review-label">{q.header}</span>
                      <p>
                        {typeof d.choice === "number"
                          ? choiceLabel(q.options[d.choice]?.label, d.choice)
                          : d.custom.trim() || t("questionRephrase")}
                      </p>
                      {typeof d.choice === "number" &&
                        d.notes[d.choice]?.trim() && (
                          <p className="question-help">{d.notes[d.choice]}</p>
                        )}
                    </div>
                    <button
                      type="button"
                      className="question-icon"
                      aria-label={t("questionEdit", { question: q.header })}
                      disabled={locked}
                      onClick={() => navigate(i)}
                    >
                      <Pencil />
                    </button>
                  </li>
                );
              })}
            </ol>
          </>
        ) : (
          <>
            <fieldset disabled={locked} className="question-choices">
              <legend className="sr-only">{question.header}</legend>
              {question.options.map((option, i) => (
                <label
                  key={option.label}
                  className={`question-choice ${draft.choice === i ? "is-selected" : ""}`}
                >
                  <input
                    className="question-radio"
                    type="radio"
                    name={`${id}-${question.id}`}
                    checked={draft.choice === i}
                    onChange={() => update({ choice: i })}
                  />
                  <span className="question-choice-number" aria-hidden="true">
                    {i + 1}
                  </span>
                  <span className="question-choice-copy">
                    <strong>{choiceLabel(option.label, i)}</strong>
                    <span>
                      {request.handoff
                        ? t(i === 0 ? "handoffDoneHelp" : "handoffUnableHelp")
                        : option.description}
                    </span>
                  </span>
                </label>
              ))}
            </fieldset>
            {typeof draft.choice === "number" && (
              <div className="question-extras">
                <button
                  type="button"
                  className="question-note-toggle"
                  disabled={locked}
                  aria-expanded={Boolean(draft.notesExpanded)}
                  aria-controls={
                    draft.notesExpanded ? `${id}-notes` : undefined
                  }
                  onClick={() =>
                    update({ notesExpanded: !draft.notesExpanded })
                  }
                >
                  <Pencil aria-hidden="true" />
                  {t("questionNotes")}
                </button>
                {typeof draft.choice === "number" &&
                  question.options[draft.choice]?.preview && (
                    <details
                      className="question-preview-disclosure"
                      key={`${question.id}-${draft.choice}`}
                    >
                      <summary>{t("questionPreview")}</summary>
                      <pre className="question-preview">
                        {question.options[draft.choice]!.preview}
                      </pre>
                    </details>
                  )}
              </div>
            )}
            {(draft.choice === "custom" ||
              (typeof draft.choice === "number" && draft.notesExpanded)) && (
              <label className="question-notes" id={`${id}-notes`}>
                <span className="sr-only" id={`${id}-answer-label`}>
                  {draft.choice === "custom"
                    ? t("questionYourAnswer")
                    : t("questionNotes")}
                </span>
                <textarea
                  rows={1}
                  disabled={locked}
                  value={
                    draft.choice === "custom"
                      ? draft.custom
                      : (draft.notes[draft.choice] ?? "")
                  }
                  onChange={(event) =>
                    draft.choice === "custom"
                      ? update({ custom: event.target.value })
                      : typeof draft.choice === "number" &&
                        update({
                          notes: {
                            ...draft.notes,
                            [draft.choice]: event.target.value,
                          },
                        })
                  }
                  aria-invalid={overflow}
                  aria-labelledby={`${id}-answer-label`}
                  aria-describedby={
                    [
                      overflow ? `${id}-limit` : "",
                      draft.choice === "custom" ? `${id}-custom-help` : "",
                    ]
                      .filter(Boolean)
                      .join(" ") || undefined
                  }
                  placeholder={
                    draft.choice === "custom"
                      ? t("questionCustomPlaceholder")
                      : t("questionNotesPlaceholder")
                  }
                />
                {draft.choice === "custom" && (
                  <span className="question-help" id={`${id}-custom-help`}>
                    {t("questionCustomHelp")}
                  </span>
                )}
              </label>
            )}
          </>
        )}
        {overflow && (
          <p className="question-error" id={`${id}-limit`} role="alert">
            {t("questionLimit", { count: MAX_ANSWER_DRAFT_UTF8_BYTES })}
          </p>
        )}
        {draftLimit && (
          <p className="question-error" role="alert">
            {t("questionDraftLimit")}
          </p>
        )}
        {!connected && (
          <p className="question-help" role="status">
            {t("questionDisconnected")}
          </p>
        )}
        {error && (
          <p className="question-error" role="alert">
            {t("questionUncertain")}
          </p>
        )}
      </div>
      <footer className="question-card-footer">
        {!review && !request.handoff && (
          <label
            className={`question-custom ${draft.choice === "custom" ? "is-selected" : ""} ${locked ? "is-disabled" : ""}`}
          >
            <input
              className="question-radio"
              type="radio"
              name={`${id}-${question.id}`}
              checked={draft.choice === "custom"}
              disabled={locked}
              onChange={() => update({ choice: "custom" })}
            />
            <span className="question-choice-number" aria-hidden="true">
              <Pencil />
            </span>
            <span>{t("questionCustom")}</span>
          </label>
        )}
        <div className="question-actions">
          {(review || index > 0) && (
            <button
              type="button"
              className="question-secondary"
              disabled={locked || (!review && index === 0)}
              onClick={() =>
                navigate(review ? request.questions.length - 1 : index - 1)
              }
            >
              <ArrowLeft />
              {t("questionBack")}
            </button>
          )}
          {!submitted && (
            <button
              type="button"
              className="question-secondary question-skip"
              disabled={locked}
              title={t("questionDismiss")}
              onClick={() => void send(true)}
            >
              {t("questionSkip")}
            </button>
          )}
          {submitted ? (
            <button
              type="button"
              className="question-primary"
              disabled={busy || !connected}
              onClick={() => void send()}
            >
              <RotateCcw />
              {busy ? t("questionSubmitting") : t("questionRetry")}
            </button>
          ) : review ? (
            <button
              type="button"
              className="question-primary"
              disabled={locked || !complete}
              onClick={() => void send()}
            >
              <Check />
              {t(request.handoff ? "handoffSubmit" : "questionSubmit")}
            </button>
          ) : (
            <button
              type="button"
              className="question-primary"
              disabled={locked || draft.choice === null || overflow}
              onClick={() =>
                navigate(
                  index < request.questions.length - 1 ? index + 1 : index,
                  index === request.questions.length - 1,
                )
              }
            >
              {index === request.questions.length - 1
                ? t(request.handoff ? "handoffReview" : "questionReview")
                : t("questionNext")}
              <ArrowRight />
            </button>
          )}
        </div>
      </footer>
    </section>
  );
}

/** Refresh from canonical snapshots, including SSE reconnects, not every token. */
export function QuestionPanel({
  sessionId,
  revision,
  connected,
  sessionPath = "",
  workingCache,
}: {
  sessionId: string;
  revision: number;
  connected: boolean;
  sessionPath?: string;
  workingCache?: QuestionWorkingCache;
}) {
  const { t } = useTranslation();
  const client = useMemo(() => new WebClient(), []);
  const localCache = useMemo<QuestionWorkingCache>(() => new Map(), []);
  const cache = workingCache ?? localCache;
  const [pending, setPending] = useState<WebQuestionRequest | null>(null);
  const [receipt, setReceipt] = useState<WebQuestionReceipt | null>(null);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const settled = useRef<string | null>(null);
  const currentRequest = useRef<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: canonical snapshot revisions and explicit retries refresh pending questions.
  useEffect(() => {
    const controller = new AbortController();
    void client.pendingQuestions(sessionId, controller.signal).then(
      ({ pending: next }) => {
        if (controller.signal.aborted) return;
        const visible = next?.requestId === settled.current ? null : next;
        // Read ownership must change before React unmounts the old form.
        currentRequest.current = visible?.requestId ?? null;
        setFailed(false);
        retireWorking(cache, sessionId, sessionPath, next?.requestId);
        setPending(visible);
        if (next && next.requestId !== settled.current) setReceipt(null);
      },
      () => {
        if (!controller.signal.aborted) setFailed(true);
      },
    );
    return () => controller.abort();
  }, [client, sessionId, sessionPath, cache, revision, retry]);
  if (!pending && !receipt && !failed) return null;
  return (
    <div className="question-panel">
      {pending ? (
        <QuestionCard
          key={pending.requestId}
          request={pending}
          connected={connected}
          sessionPath={sessionPath}
          workingCache={cache}
          answer={(request, answers, signal) =>
            client.answerQuestions(request, answers, signal)
          }
          onSettled={(result) => {
            if (currentRequest.current !== pending.requestId) return;
            currentRequest.current = null;
            settled.current = pending.requestId;
            setPending(null);
            setReceipt(result.state === "answered" ? null : result);
            setRetry((n) => n + 1);
          }}
        />
      ) : receipt ? (
        <div className="question-receipt" role="status">
          <Check aria-hidden="true" />
          <span>{t(`questionState_${receipt.state}`)}</span>
          <button
            type="button"
            className="question-icon"
            aria-label={t("questionCloseReceipt")}
            onClick={() => setReceipt(null)}
          >
            <X />
          </button>
        </div>
      ) : (
        <div className="question-receipt" role="alert">
          <span>{t("questionLoadFailed")}</span>
          <button
            type="button"
            className="question-secondary"
            onClick={() => setRetry((n) => n + 1)}
          >
            {t("questionRetryLoad")}
          </button>
        </div>
      )}
    </div>
  );
}
