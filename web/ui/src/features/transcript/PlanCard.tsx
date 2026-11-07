import { Check, Clipboard, FileText, MessageSquarePlus } from "lucide-react";
import { useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { evidenceRecord, evidenceText } from "../../../../protocol/evidence.ts";
import type { WebLiveMessage } from "../../../../protocol/types.ts";
import { Markdown } from "../../components/Markdown.tsx";
import { copyText } from "../../lib/clipboard.ts";
import { FullMessageText } from "./FullMessageText.tsx";

import type { PlanTextReference } from "../review/review-reference.ts";

/** A tool's arguments are only a proposal; readiness comes from its result. */
export function planPresentation(result?: WebLiveMessage) {
  if (result?.toolName !== "plan_ready" || result.isError !== false) return;
  const details = evidenceRecord(result.details);
  if (
    details.status === "ready" &&
    typeof details.plan === "string" &&
    details.plan.trim()
  ) {
    return { markdown: details.plan, ready: true, truncated: false };
  }
  // Large details can be omitted by the bounded protocol. Preserve the visible
  // result as a preview, without inferring readiness from its English prose.
  if (result.truncation?.details && result.content.trim()) {
    return { markdown: result.content, ready: false, truncated: true };
  }
}

export function PlanCard({
  result,
  sessionId,
  sessionPath,
  entryId,
  onReference,
}: {
  result: WebLiveMessage;
  sessionId?: string;
  sessionPath?: string;
  entryId?: string;
  onReference?: (reference: PlanTextReference) => void;
}) {
  const { t } = useTranslation();
  const bodyId = useId();
  const textBody = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState<{
    source: string;
    result: WebLiveMessage;
    markdown: string;
    text: string;
  } | null>(null);
  const [expanded, setExpanded] = useState(true);
  const [copied, setCopied] = useState<{
    source: string;
    markdown: string;
    status: "copiedMessage" | "copyFailed";
  } | null>(null);
  const [hydrated, setHydrated] = useState<{
    source: string;
    markdown: string;
    complete: boolean;
  } | null>(null);
  const source = JSON.stringify([sessionId, sessionPath, entryId]);
  const restored = hydrated?.source === source ? hydrated : undefined;
  const fullPlan = restored?.complete ? restored.markdown : undefined;
  const preview = planPresentation(result);
  const plan =
    preview?.truncated && restored
      ? {
          markdown: restored.markdown,
          ready: restored.complete,
          truncated: !restored.complete,
        }
      : preview;
  const copySource = useRef({ source, markdown: plan?.markdown });
  copySource.current = { source, markdown: plan?.markdown };
  const feedback =
    copied?.source === source && copied?.markdown === plan?.markdown
      ? copied.status
      : null;
  if (!plan) return null;
  const selectedText =
    selection?.source === source &&
    selection.result === result &&
    selection.markdown === plan.markdown
      ? selection.text
      : undefined;
  const canReference =
    onReference && sessionId && sessionPath && (entryId || result.toolCallId);
  const captureSelection = () => {
    const selected = window.getSelection();
    const text = selected?.toString();
    setSelection(
      text &&
        textBody.current?.contains(selected?.anchorNode ?? null) &&
        textBody.current.contains(selected?.focusNode ?? null)
        ? {
            source,
            result,
            markdown: plan.markdown,
            text,
          }
        : null,
    );
  };

  return (
    <section className="plan-card" aria-label={t("planCardLabel")}>
      <div className="plan-card-header">
        <button
          type="button"
          className="plan-card-toggle"
          aria-expanded={expanded}
          aria-controls={bodyId}
          onClick={() => setExpanded(!expanded)}
        >
          <FileText aria-hidden="true" />
          <span>{t(plan.ready ? "planCardReady" : "planCardResult")}</span>
          <span className="plan-card-disclosure">
            {t(expanded ? "planCardCollapse" : "planCardExpand")}
          </span>
        </button>
        {canReference && (
          <button
            type="button"
            className="plan-card-reference"
            disabled={!selectedText || !expanded}
            title={t("planCardReferenceHint")}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              if (!selectedText) return;
              onReference({
                kind: "plan",
                sessionId,
                sessionPath,
                entryId,
                toolCallId: result.toolCallId,
                text: selectedText,
              });
            }}
          >
            <MessageSquarePlus aria-hidden="true" />
            {t("planCardReference")}
          </button>
        )}
        <button
          type="button"
          className="plan-card-copy"
          aria-label={t(
            plan.truncated ? "planCardCopyPreview" : "planCardCopy",
          )}
          title={t(plan.truncated ? "planCardCopyPreview" : "planCardCopy")}
          onClick={async () => {
            const success = await copyText(plan.markdown);
            if (
              copySource.current.source === source &&
              copySource.current.markdown === plan.markdown
            )
              setCopied({
                source,
                markdown: plan.markdown,
                status: success ? "copiedMessage" : "copyFailed",
              });
          }}
        >
          {feedback === "copiedMessage" ? (
            <Check aria-hidden="true" />
          ) : (
            <Clipboard aria-hidden="true" />
          )}
        </button>
      </div>
      <div id={bodyId} hidden={!expanded} className="plan-card-body">
        <p className="plan-card-note">{t("planCardNotApproval")}</p>
        {plan.truncated && (
          <p className="plan-card-note">{t("planCardTruncated")}</p>
        )}
        {/* biome-ignore lint/a11y/noStaticElementInteractions: observes native text selection; the separate button owns interaction. */}
        <div
          ref={textBody}
          className="plan-card-text"
          onMouseUp={captureSelection}
          onKeyUp={captureSelection}
        >
          {preview?.truncated && sessionId && sessionPath && entryId ? (
            <FullMessageText
              key={source}
              preview={preview.markdown}
              sessionId={sessionId}
              sessionPath={sessionPath}
              entryId={entryId}
              markdown
              purpose="plan"
              fullText={fullPlan}
              onProgress={(markdown) =>
                setHydrated({ source, markdown, complete: false })
              }
              onComplete={(markdown) =>
                setHydrated({ source, markdown, complete: true })
              }
            />
          ) : (
            <Markdown>{plan.markdown}</Markdown>
          )}
        </div>
        <details className="plan-card-evidence">
          <summary>{t("planCardEvidence")}</summary>
          <pre className="tool-evidence">
            {evidenceText(result.content).text}
          </pre>
        </details>
      </div>
      {feedback && (
        <span className="plan-card-feedback" role="status">
          {t(feedback)}
        </span>
      )}
    </section>
  );
}
