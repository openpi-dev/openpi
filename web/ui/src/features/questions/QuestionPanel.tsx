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

export function QuestionCard({
  request,
  answer,
  onSettled,
  connected = true,
  onSubmitting,
}: {
  request: WebQuestionRequest;
  answer: (
    request: WebQuestionRequest,
    answers: WebQuestionAnswers | null,
    signal: AbortSignal,
  ) => Promise<WebQuestionReceipt>;
  onSettled: (receipt: WebQuestionReceipt) => void;
  connected?: boolean;
  onSubmitting?: () => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [drafts, setDrafts] = useState<Draft[]>(() =>
    request.questions.map(() => ({ choice: null, custom: "", notes: {} })),
  );
  const [index, setIndex] = useState(0);
  const [review, setReview] = useState(false);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const submission = useRef<{ answers: WebQuestionAnswers | null } | null>(
    null,
  );
  const controller = useRef<AbortController | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const question = request.questions[index]!;
  const draft = drafts[index]!;
  const locked = busy || submitted || !connected;
  const overflow = drafts.some(
    (d) =>
      !answerDraftFits(d.custom) ||
      Object.values(d.notes).some((note) => !answerDraftFits(note)),
  );
  const complete = drafts.every((d) => d.choice !== null) && !overflow;
  const choiceLabel = (label: string | undefined, index: number) =>
    request.handoff ? t(index === 0 ? "handoffDone" : "handoffUnable") : label;

  useEffect(() => () => controller.current?.abort(), []);
  // Focus moves only after deliberate navigation, never on a background refresh.
  const navigate = (next: number, toReview = false) => {
    setIndex(next);
    setReview(toReview);
    requestAnimationFrame(() => heading.current?.focus());
  };
  const update = (patch: Partial<Draft>) =>
    setDrafts((current) =>
      current.map((d, i) => (i === index ? { ...d, ...patch } : d)),
    );
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
    if (busy || !connected || (!dismiss && !submitted && !complete)) return;
    submission.current ??= { answers: dismiss ? null : answers() };
    setBusy(true);
    setSubmitted(true);
    setError(false);
    onSubmitting?.();
    controller.current = new AbortController();
    try {
      const receipt = await answer(
        request,
        submission.current.answers,
        controller.current.signal,
      );
      if (!controller.current.signal.aborted) onSettled(receipt);
    } catch {
      if (!controller.current.signal.aborted) setError(true);
    } finally {
      if (!controller.current.signal.aborted) setBusy(false);
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
}: {
  sessionId: string;
  revision: number;
  connected: boolean;
}) {
  const { t } = useTranslation();
  const client = useMemo(() => new WebClient(), []);
  const [pending, setPending] = useState<WebQuestionRequest | null>(null);
  const [receipt, setReceipt] = useState<WebQuestionReceipt | null>(null);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const submitted = useRef(false);
  const settled = useRef<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: canonical snapshot revisions and explicit retries refresh pending questions.
  useEffect(() => {
    const controller = new AbortController();
    void client.pendingQuestions(sessionId, controller.signal).then(
      ({ pending: next }) => {
        if (controller.signal.aborted || submitted.current) return;
        setFailed(false);
        setPending(next?.requestId === settled.current ? null : next);
        if (next && next.requestId !== settled.current) setReceipt(null);
      },
      () => {
        if (!controller.signal.aborted && !submitted.current) setFailed(true);
      },
    );
    return () => controller.abort();
  }, [client, sessionId, revision, retry]);
  if (!pending && !receipt && !failed) return null;
  return (
    <div className="question-panel">
      {pending ? (
        <QuestionCard
          key={pending.requestId}
          request={pending}
          connected={connected}
          answer={(request, answers, signal) =>
            client.answerQuestions(request, answers, signal)
          }
          onSubmitting={() => {
            submitted.current = true;
          }}
          onSettled={(result) => {
            settled.current = pending.requestId;
            submitted.current = false;
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
