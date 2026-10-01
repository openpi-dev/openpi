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
          {running && observed && (
            <span className="context-compaction-spinner" aria-hidden="true" />
          )}
          {t(labels[state])}
        </span>
        {running && observed && compaction.elapsedMs !== undefined && (
          <RunningTurnElapsed
            key={compaction.startedAt}
            elapsedMs={compaction.elapsedMs}
            waiting
          />
        )}
      </div>
      {running && (
        <p>
          {t(unavailable ? "compactionReconnectHelp" : "compactionRunningHelp")}
        </p>
      )}
    </div>
  );
}
