import { ChevronDown, FileDiff } from "lucide-react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { WebTurnChanges } from "../../../../protocol/turn-changes.ts";

export type OpenTurnReview = (promptEntryId: string, filePath?: string) => void;

export function TurnChangesCard({
  changes,
  onReview,
}: {
  changes: WebTurnChanges;
  onReview?: OpenTurnReview;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  if (changes.state === "unavailable" || changes.files.length === 0)
    return null;
  const partial = changes.state === "partial";
  const toolEvidence = changes.source === "file-tools";
  const incompleteList = changes.fileCount === null;
  const files = expanded ? changes.files : changes.files.slice(0, 3);
  return (
    <section className="turn-changes" aria-label={t("turnChangesReview")}>
      <header className="turn-changes-header">
        <span className="turn-changes-icon" aria-hidden="true">
          <FileDiff />
        </span>
        <div className="turn-changes-summary">
          <strong
            title={t(toolEvidence ? "turnEditsScope" : "turnChangesScope")}
          >
            {t(
              toolEvidence
                ? incompleteList
                  ? "turnEditsPartial"
                  : "turnEdits"
                : partial
                  ? "turnChangesPartial"
                  : "turnChanges",
              {
                count: changes.fileCount ?? changes.files.length,
              },
            )}
          </strong>
          {!incompleteList &&
            !changes.files.some(
              (file) => file.binary || file.statsUnavailable,
            ) && (
              <span className="turn-changes-totals">
                <span className="review-additions">+{changes.additions}</span>
                <span className="review-deletions">−{changes.deletions}</span>
              </span>
            )}
          {partial && !toolEvidence && (
            <span className="turn-changes-warning">
              {t("turnChangesIncomplete")}
            </span>
          )}
        </div>
        <button
          type="button"
          className="turn-changes-review-button"
          aria-label={t("turnChangesReview")}
          disabled={!onReview}
          onClick={() =>
            onReview?.(changes.promptEntryId, changes.files[0]?.path)
          }
        >
          {t("reviewChanges")}
        </button>
      </header>
      <div className="turn-changes-list" id={listId}>
        {files.map((file) => {
          const slash = Math.max(
            file.path.lastIndexOf("/"),
            file.path.lastIndexOf("\\"),
          );
          return (
            <button
              key={file.path}
              type="button"
              className="turn-changes-file"
              title={file.path}
              disabled={!onReview}
              onClick={() => onReview?.(changes.promptEntryId, file.path)}
            >
              <span className="turn-changes-path">
                <span>{file.path.slice(0, slash + 1)}</span>
                <strong>{file.path.slice(slash + 1)}</strong>
              </span>
              <span className="turn-changes-file-stats">
                {file.binary ? (
                  <span>{t("gitReviewBinaryShort")}</span>
                ) : file.statsUnavailable ? (
                  <span title={t(`turnEditReason_${file.statsUnavailable}`)}>
                    {t("turnEditStatsUnknown")}
                  </span>
                ) : (
                  <>
                    <span className="review-additions">+{file.additions}</span>
                    <span className="review-deletions">−{file.deletions}</span>
                  </>
                )}
              </span>
            </button>
          );
        })}
      </div>
      {changes.files.length > 3 && (
        <button
          type="button"
          className="turn-changes-more"
          aria-expanded={expanded}
          aria-controls={listId}
          onClick={() => setExpanded((value) => !value)}
        >
          {t(expanded ? "turnChangesLess" : "turnChangesMore", {
            count: changes.files.length - 3,
          })}
          <ChevronDown className={expanded ? "up" : ""} aria-hidden="true" />
        </button>
      )}
    </section>
  );
}
