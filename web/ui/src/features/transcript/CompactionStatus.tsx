import { useTranslation } from "react-i18next";
import type { WebSessionExecution } from "../../../../runtime/types.ts";
import { RunningTurnElapsed } from "./TurnElapsed.tsx";
import "./compaction-status.css";

export function CompactionStatus({
  compaction,
  observed = true,
}: {
  compaction: NonNullable<WebSessionExecution["compaction"]>;
  observed?: boolean;
}) {
  const { t } = useTranslation();
  const running = compaction.state === "running";
  const unavailable = running && !observed;
  const state = unavailable ? "unavailable" : compaction.state;
  const labels = {
    running: "compactionRunning",
    completed: "compactionCompleted",
    failed: "compactionFailed",
    cancelled: "compactionCancelled",
    unchanged: "compactionUnchanged",
    unavailable: "compactionUnavailable",
  } as const;
  return (
    <div className="context-compaction" data-state={state}>
      <div className="context-compaction-heading">
        <span className="context-compaction-label" role="status">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M4 4v13a3 3 0 0 0 3 3h3M14 4h3a3 3 0 0 1 3 3v13M8 10h8M8 14h4" />
            <circle cx="4" cy="4" r="1.7" fill="currentColor" stroke="none" />
            <circle cx="20" cy="20" r="1.7" fill="currentColor" stroke="none" />
          </svg>
          <span className="context-compaction-text">{t(labels[state])}</span>
        </span>
        {running && observed && compaction.elapsedMs !== undefined && (
          <RunningTurnElapsed
            key={compaction.startedAt}
            elapsedMs={compaction.elapsedMs}
            waiting
          />
        )}
      </div>
      {unavailable && <p>{t("compactionReconnectHelp")}</p>}
    </div>
  );
}
