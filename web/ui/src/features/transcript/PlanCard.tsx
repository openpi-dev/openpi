import { Check, Clipboard, FileText } from "lucide-react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { WebLiveMessage } from "../../../../protocol/types.ts";
import { evidenceRecord, evidenceText } from "../../../../protocol/evidence.ts";
import { Markdown } from "../../components/Markdown.tsx";
import { copyText } from "../../lib/clipboard.ts";

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

export function PlanCard({ result }: { result: WebLiveMessage }) {
  const { t } = useTranslation();
  const bodyId = useId();
  const [expanded, setExpanded] = useState(true);
  const [copied, setCopied] = useState<"copiedMessage" | "copyFailed" | null>(
    null,
  );
  const plan = planPresentation(result);
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
          onClick={async () =>
            setCopied(
              (await copyText(plan.markdown)) ? "copiedMessage" : "copyFailed",
            )
          }
        >
          {copied === "copiedMessage" ? (
            <Check aria-hidden="true" />
          ) : (
            <Clipboard aria-hidden="true" />
          )}
        </button>
      </div>
      <div id={bodyId} hidden={!expanded} className="plan-card-body">
        {plan.ready && (
          <p className="plan-card-note">{t("planCardNotApproval")}</p>
        )}
        {plan.truncated && (
          <p className="plan-card-note">{t("planCardTruncated")}</p>
        )}
        <Markdown>{plan.markdown}</Markdown>
        <details className="plan-card-evidence">
          <summary>{t("planCardEvidence")}</summary>
          <pre className="tool-evidence">
            {evidenceText(result.content).text}
          </pre>
        </details>
      </div>
      {copied && (
        <span className="plan-card-feedback" role="status">
          {t(copied)}
        </span>
      )}
    </section>
  );
}
