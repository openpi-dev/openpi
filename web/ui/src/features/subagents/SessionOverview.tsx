import {
  Popover,
  type PopoverTriggerRenderProps,
} from "@astryxdesign/core/Popover";
import { ChevronRight, Folder, GitBranch } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { WebGitReviewResult } from "../../../../protocol/types.ts";
import { SubagentAvatar } from "./SubagentAvatar.tsx";
import type { subagentOverview } from "./subagent-overview.ts";

export function SessionOverview({
  sessionId,
  workspace,
  cwd,
  agents,
  omitted,
  review,
  onSubagents,
  onReview,
  onFiles,
}: {
  sessionId: string;
  workspace: string;
  cwd: string;
  agents: ReturnType<typeof subagentOverview>;
  omitted: number;
  review: WebGitReviewResult | null;
  onSubagents: () => void;
  onReview: () => void;
  onFiles: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement | null>(null);
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
            title={cwd}
            onClick={() => activate(onFiles)}
          >
            <Folder aria-hidden="true" />
            <span>{t("files")}</span>
            <ChevronRight aria-hidden="true" />
          </button>
          <button
            type="button"
            className="session-overview-row"
            onClick={() => activate(onReview)}
          >
            <GitBranch aria-hidden="true" />
            <span>{t("workspaceChanges")}</span>
            {review?.ok ? (
              <span
                className="session-overview-diff"
                title={t("sessionOverviewChanges")}
              >
                <span>
                  {review.snapshot.truncated
                    ? t("gitReviewPartialLabel")
                    : (review.snapshot.totalFiles ??
                      review.snapshot.files.length)}
                </span>
              </span>
            ) : (
              <ChevronRight aria-hidden="true" />
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
  );
}
