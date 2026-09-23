import { ArrowLeft, ChevronDown, FilePenLine } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  WebTurnChanges,
  WebTurnChangesDetail,
} from "../../../../protocol/turn-changes.ts";
import { WebClient } from "../../protocol/client.ts";
import { DiffCodePreview } from "../review/DiffCodePreview.tsx";

const PREVIEW_FILES = 3;

function fileName(path: string) {
  return path.split(/[\\/]/u).at(-1) || path;
}

function FileLine({
  file,
  onClick,
  selected,
}: {
  file: WebTurnChanges["files"][number];
  onClick: () => void;
  selected?: boolean;
}) {
  return (
    <button
      type="button"
      className="turn-changes-file"
      title={file.path}
      aria-pressed={selected}
      onClick={onClick}
    >
      <span className="turn-changes-path">
        {file.path.slice(0, -fileName(file.path).length)}
        <strong>{fileName(file.path)}</strong>
      </span>
      <span className="turn-changes-file-stats" aria-hidden="true">
        <span className="review-additions">+{file.additions}</span>
        <span className="review-deletions">-{file.deletions}</span>
      </span>
    </button>
  );
}

export function TurnChangesCard({
  changes,
  sessionId,
  sessionPath,
}: {
  changes: WebTurnChanges;
  sessionId: string;
  sessionPath: string;
}) {
  const { t } = useTranslation();
  const client = useMemo(() => new WebClient(), []);
  const [expanded, setExpanded] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [retry, setRetry] = useState(0);
  const [detail, setDetail] = useState<WebTurnChangesDetail | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [requestedPath, setRequestedPath] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!reviewing) return;
    void retry;
    const controller = new AbortController();
    setDetail(null);
    setSelectedPath(null);
    setError(false);
    void client
      .turnChanges(
        sessionId,
        sessionPath,
        changes.promptEntryId,
        controller.signal,
      )
      .then((result) => {
        if (controller.signal.aborted) return;
        if (
          !result.ok ||
          result.changes.promptEntryId !== changes.promptEntryId
        ) {
          setError(true);
          return;
        }
        setDetail(result.changes);
        setSelectedPath(
          result.changes.files.find((file) => file.path === requestedPath)
            ?.path ??
            result.changes.files[0]?.path ??
            null,
        );
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      });
    return () => controller.abort();
  }, [
    reviewing,
    retry,
    client,
    sessionId,
    sessionPath,
    changes.promptEntryId,
    requestedPath,
  ]);

  const selectedFile = detail?.files.find((file) => file.path === selectedPath);

  if (changes.state === "unavailable")
    return (
      <p className="turn-changes-unavailable" role="status">
        {t("turnChangesUnverified")}
      </p>
    );
  if (changes.files.length === 0)
    return changes.state === "partial" ? (
      <p className="turn-changes-unavailable" role="status">
        {t("turnChangesIncomplete")}
      </p>
    ) : null;
  const partial = changes.state === "partial";
  const files = expanded
    ? changes.files
    : changes.files.slice(0, PREVIEW_FILES);
  const remaining = changes.files.length - files.length;
  return (
    <section className="turn-changes" aria-label={t("turnChangesReview")}>
      <header className="turn-changes-header">
        <span className="turn-changes-icon" aria-hidden="true">
          <FilePenLine />
        </span>
        <span className="turn-changes-summary">
          <strong>
            {t(partial ? "turnChangesPartial" : "turnChanges", {
              count: partial ? changes.files.length : changes.fileCount,
            })}
          </strong>
          {!partial && (
            <span className="turn-changes-totals">
              <span className="review-additions">+{changes.additions}</span>
              <span className="review-deletions">-{changes.deletions}</span>
            </span>
          )}
        </span>
        <button
          type="button"
          className="turn-changes-review-button"
          aria-label={reviewing ? t("turnChangesBack") : t("turnChangesReview")}
          onClick={() => {
            setRequestedPath(null);
            setReviewing((value) => !value);
          }}
        >
          {reviewing ? (
            <ArrowLeft aria-hidden="true" />
          ) : (
            t("turnChangesReviewButton")
          )}
        </button>
      </header>
      {reviewing ? (
        <section
          className="turn-changes-review"
          aria-label={t("turnChangesReview")}
          tabIndex={-1}
          onKeyDown={(event) => {
            if (event.key === "Escape" && !event.nativeEvent.isComposing)
              setReviewing(false);
          }}
        >
          {error && (
            <p role="alert">
              {t("turnChangesUnavailable")}{" "}
              <button
                type="button"
                onClick={() => setRetry((value) => value + 1)}
              >
                {t("gitReviewRetry")}
              </button>
            </p>
          )}
          {!error && !detail && <p role="status">{t("turnChangesLoading")}</p>}
          {detail && (
            <>
              {detail.state === "partial" && (
                <p className="turn-changes-warning">
                  {t("turnChangesIncomplete")}
                </p>
              )}
              <div className="turn-changes-review-files">
                {detail.files.map((file) => (
                  <FileLine
                    key={file.path}
                    file={file}
                    selected={selectedPath === file.path}
                    onClick={() => setSelectedPath(file.path)}
                  />
                ))}
              </div>
              {selectedFile &&
                (selectedFile.diffLoaded === false ? (
                  <p role="alert">{t("turnChangesUnavailable")}</p>
                ) : selectedFile.diff ? (
                  <DiffCodePreview file={selectedFile} />
                ) : (
                  <p className="turn-changes-warning">
                    {t(
                      selectedFile.diffTruncated
                        ? "gitReviewDiffTruncated"
                        : "gitReviewNoDiff",
                    )}
                  </p>
                ))}
            </>
          )}
        </section>
      ) : (
        <div className="turn-changes-list">
          {partial && (
            <p className="turn-changes-warning">{t("turnChangesIncomplete")}</p>
          )}
          {files.map((file) => (
            <FileLine
              key={file.path}
              file={file}
              onClick={() => {
                setRequestedPath(file.path);
                setReviewing(true);
              }}
            />
          ))}
          {remaining > 0 && (
            <button
              type="button"
              className="turn-changes-more"
              onClick={() => setExpanded(true)}
            >
              {t("turnChangesMore", { count: remaining })}{" "}
              <ChevronDown aria-hidden="true" />
            </button>
          )}
          {expanded && changes.files.length > PREVIEW_FILES && (
            <button
              type="button"
              className="turn-changes-more"
              onClick={() => setExpanded(false)}
            >
              {t("turnChangesLess")}{" "}
              <ChevronDown aria-hidden="true" className="up" />
            </button>
          )}
        </div>
      )}
    </section>
  );
}
