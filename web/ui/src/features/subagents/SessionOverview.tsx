import {
  Popover,
  type PopoverTriggerRenderProps,
} from "@astryxdesign/core/Popover";
import { ChevronRight, FileDiff, Plus, Link as LinkIcon } from "lucide-react";
import { useContext, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { WebGitReviewResult } from "../../../../protocol/types.ts";
import { SubagentAvatar } from "./SubagentAvatar.tsx";
import type { subagentOverview } from "./subagent-overview.ts";
import { ArtifactContext } from "../artifacts/context.ts";
import type { WebSessionSource } from "../../../../protocol/session-sources.ts";
import {
  SourceRow,
  SourcesDialog,
  useSessionSources,
} from "./session-sources.tsx";

export function SessionOverview({
  sessionId,
  workspace,
  agents,
  omitted,
  review,
  onSubagents,
  onReview,
  sessionPath,
  revision,
  onAddSources,
  reviewLoading = false,
  reviewError,
}: {
  sessionId: string;
  workspace: string;
  agents: ReturnType<typeof subagentOverview>;
  omitted: number;
  review: WebGitReviewResult | null;
  onSubagents: () => void;
  onReview: () => void;
  sessionPath?: string;
  revision?: string;
  onAddSources?: () => void;
  reviewLoading?: boolean;
  reviewError?: string | null;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [source, setSource] = useState<WebSessionSource | null>(null);
  const sources = useSessionSources(
    sessionId,
    sessionPath ?? "",
    Boolean(sessionPath && (open || sourcesOpen)),
    revision,
  );
  const artifacts = useContext(ArtifactContext);
  const totals = review?.ok ? review.snapshot.totals : undefined;
  const openSource = (item: WebSessionSource | null) => {
    if (item?.kind === "file" && item.reference) {
      setSourcesOpen(false);
      activate(() =>
        artifacts?.open(
          item.reference!,
          undefined,
          trigger.current ?? undefined,
        ),
      );
    } else {
      activate(() => {
        setSource(item);
        setSourcesOpen(true);
      });
    }
  };
  const running = agents.filter((agent) => agent.state === "running");
  const completed = agents.filter((agent) => agent.state === "done");
  const other = agents.length - running.length - completed.length;
  const preview = [
    ...running,
    ...agents.filter((agent) => agent.state !== "running"),
  ].slice(0, 4);
  const summary =
    [
      running.length
        ? t("subagentSummaryRunning", { count: running.length })
        : "",
      completed.length
        ? t("subagentSummaryDone", { count: completed.length })
        : "",
      other ? t("subagentSummaryOther", { count: other }) : "",
    ]
      .filter(Boolean)
      .join(" · ") || t("subagentNoneYet");
  const activate = (action: () => void) => {
    // Return focus to the persistent trigger before the destination captures it.
    setOpen(false);
    trigger.current?.focus();
    action();
  };
  return (
    <>
      <Popover
        isOpen={open}
        onOpenChange={setOpen}
        placement="below"
        alignment="end"
        width="min(340px, calc(100vw - 24px))"
        label={t("sessionOverview")}
        closeButtonLabel={t("close")}
        isModal={false}
        content={
          <div className="session-overview">
            <p className="session-overview-title">{workspace}</p>
            <button
              type="button"
              className="session-overview-row"
              title={t("sessionOverviewChanges")}
              onClick={() => activate(onReview)}
            >
              <FileDiff aria-hidden="true" />
              <span>{t("overviewChanges")}</span>
              {totals && !reviewError ? (
                <span
                  className="session-overview-diff"
                  title={t(
                    totals.complete
                      ? "overviewLineTotals"
                      : "overviewPartialTotals",
                  )}
                >
                  <span className="review-additions">
                    +{totals.additions.toLocaleString()}
                  </span>
                  <span className="review-deletions">
                    −{totals.deletions.toLocaleString()}
                  </span>
                  {!totals.complete && (
                    <span className="session-overview-note">
                      {t("gitReviewPartialLabel")}
                    </span>
                  )}
                </span>
              ) : (
                <span className="session-overview-note">
                  {t(
                    reviewLoading
                      ? "overviewCounting"
                      : review?.ok
                        ? "overviewCountsUnknown"
                        : "overviewReviewUnavailable",
                  )}
                </span>
              )}
            </button>
            <div className="session-overview-section">
              <p>{t("subagentDetails")}</p>
              <button
                type="button"
                className="session-overview-row session-overview-agents"
                onClick={() => activate(onSubagents)}
                aria-label={`${t("subagentDetails")}: ${summary}`}
              >
                {preview.length > 0 && (
                  <span className="subagent-avatar-stack">
                    {preview.map((agent) => (
                      <SubagentAvatar
                        key={agent.id}
                        identity={`${sessionId}:${agent.id}`}
                      />
                    ))}
                  </span>
                )}
                <span className="session-overview-agent-counts">
                  {summary.split(" · ").map((part) => (
                    <span key={part}>{part}</span>
                  ))}
                </span>
                <ChevronRight aria-hidden="true" />
              </button>
              {omitted > 0 && (
                <small>{t("subagentListTruncated", { count: omitted })}</small>
              )}
            </div>
            {sessionPath && (
              <div className="session-overview-section">
                <div className="session-overview-section-heading">
                  <span>{t("sessionSources")}</span>
                  {onAddSources && (
                    <button
                      type="button"
                      aria-label={t("sourcesAdd")}
                      title={t("sourcesAdd")}
                      onClick={() => activate(onAddSources)}
                    >
                      <Plus />
                    </button>
                  )}
                </div>
                {sources.page?.sources.slice(0, 3).map((item) => (
                  <SourceRow
                    key={item.id}
                    source={item}
                    sessionId={sessionId}
                    path={sessionPath}
                    onOpen={() => openSource(item)}
                  />
                ))}
                {sources.error ? (
                  <p role="alert">
                    {t("sourcesFailed")}{" "}
                    <button type="button" onClick={sources.refresh}>
                      {t("gitReviewRetry")}
                    </button>
                  </p>
                ) : (
                  !sources.page?.sources.length && (
                    <p>{t(sources.loading ? "readingFile" : "sourcesEmpty")}</p>
                  )
                )}
                {Boolean(
                  sources.page &&
                    (sources.page.sources.length > 3 ||
                      sources.page.nextOffset !== undefined),
                ) && (
                  <button
                    type="button"
                    className="session-overview-row sources-view-all"
                    onClick={() => openSource(null)}
                  >
                    <LinkIcon />
                    <span>{t("sourcesViewAll")}</span>
                    <ChevronRight />
                  </button>
                )}
              </div>
            )}
          </div>
        }
      >
        {(props: PopoverTriggerRenderProps) => (
          <button
            {...props}
            ref={(element) => {
              props.ref(element);
              trigger.current = element;
            }}
            type="button"
            className="task-tools-trigger"
            title={t("sessionOverview")}
            aria-label={t("sessionOverview")}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <circle cx="5.5" cy="7" r="2.8" />
              <circle cx="5.5" cy="17" r="2.8" />
              <path d="M12 7h8M12 17h8" />
            </svg>
          </button>
        )}
      </Popover>
      {sessionPath && (
        <SourcesDialog
          sessionId={sessionId}
          path={sessionPath}
          open={sourcesOpen}
          source={source}
          data={sources}
          onSelect={openSource}
          onClose={() => {
            setSourcesOpen(false);
            setSource(null);
          }}
        />
      )}
    </>
  );
}
