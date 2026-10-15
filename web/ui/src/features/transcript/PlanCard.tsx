import { Check, Clipboard, FileText } from "lucide-react";
import { useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { evidenceRecord, evidenceText } from "../../../../protocol/evidence.ts";
import type { WebLiveMessage } from "../../../../protocol/types.ts";
import { Markdown } from "../../components/Markdown.tsx";
import { copyText } from "../../lib/clipboard.ts";
import { FullMessageText } from "./FullMessageText.tsx";

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
}: {
  result: WebLiveMessage;
  sessionId?: string;
  sessionPath?: string;
  entryId?: string;
}) {
  const { t } = useTranslation();
  const bodyId = useId();
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
