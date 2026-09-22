import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { WebTurnTiming } from "../../../../protocol/turn-timing.ts";

export function formatTurnDuration(
  elapsedMs: number,
  language: string,
  running: boolean,
) {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  const rest = seconds % 60;
  if (running && language.startsWith("zh")) {
    return `${hours ? `${hours}小时` : ""}${minutes || hours ? `${minutes}分钟` : ""}${rest}秒`;
  }
  return `${hours ? `${hours}h` : ""}${minutes || hours ? `${minutes}m` : ""}${rest}s`;
}

/** One ticker for the active Pi run; snapshots reconcile its monotonic clock. */
export function RunningTurnElapsed({ elapsedMs }: { elapsedMs: number }) {
  const { t, i18n } = useTranslation();
  const baseline = useRef({ elapsedMs, clock: performance.now() });
  const [elapsed, setElapsed] = useState(elapsedMs);
  useEffect(() => {
    const now = performance.now();
    baseline.current = {
      elapsedMs: Math.max(
        elapsedMs,
        baseline.current.elapsedMs + now - baseline.current.clock,
      ),
      clock: now,
    };
    setElapsed(baseline.current.elapsedMs);
  }, [elapsedMs]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      setElapsed(
        baseline.current.elapsedMs + performance.now() - baseline.current.clock,
      );
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <span className="turn-elapsed-running" role="timer" aria-live="off">
      {t("turnElapsedRunning", {
        duration: formatTurnDuration(elapsed, i18n.language, true),
      })}
    </span>
  );
}

export function SettledTurnElapsed({ timing }: { timing: WebTurnTiming }) {
  const { t, i18n } = useTranslation();
  return (
    <div className="turn-duration" data-outcome={timing.outcome}>
      <span>
        {t("turnElapsedFinished", {
          duration: formatTurnDuration(timing.elapsedMs, i18n.language, false),
        })}
      </span>
    </div>
  );
}
