/** DeepSeek-style three-lane overview; upstream source and MIT terms in LICENSE.dsh. */
import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { trajectoryTimeline } from "./timeline.ts";
import { type TrajectoryNode, trajectoryDuration } from "./trajectory.ts";

export function TrajectoryTimeline({
  nodes,
  selectedKey,
  range,
  onSelect,
  onRange,
}: {
  nodes: readonly TrajectoryNode[];
  selectedKey?: string;
  range: { start: number; end: number } | null;
  onSelect: (key: string) => void;
  onRange: (range: { start: number; end: number } | null) => void;
}) {
  const { t } = useTranslation();
  const spans = trajectoryTimeline(nodes);
  const drag = useRef<{ start: number; key: string | null } | null>(null);
  const domain = Math.max(1, spans.length);
  function position(event: React.PointerEvent<SVGSVGElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    return Math.max(
      0,
      Math.min(
        domain,
        ((event.clientX - bounds.left) / Math.max(1, bounds.width)) * domain,
      ),
    );
  }
  return (
    <section
      className="trajectory-overview"
      aria-label={t("trajectoryOverview")}
    >
      <div className="trajectory-overview-track">
        <div className="trajectory-lane-labels">
          <span>{t("trajectoryContextLane")}</span>
          <span>{t("trajectoryModelLane")}</span>
          <span>{t("trajectoryToolLane")}</span>
        </div>
        <svg
          viewBox={`0 0 ${domain} 3`}
          preserveAspectRatio="none"
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            drag.current = {
              start: position(event),
              key: (event.target as Element).getAttribute("data-record-key"),
            };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerUp={(event) => {
            const selection = drag.current;
            drag.current = null;
            if (selection === null) return;
            const start = selection.start;
            const end = position(event);
            if (Math.abs(end - start) > domain / 100)
              onRange({
                start: Math.min(start, end),
                end: Math.max(start, end),
              });
            else if (selection.key) onSelect(selection.key);
          }}
          onPointerCancel={() => {
            drag.current = null;
          }}
        >
          <title>{t("trajectoryOverview")}</title>
          {[0, 1, 2].map((lane) => (
            <line
              key={lane}
              x1="0"
              x2={domain}
              y1={lane + 0.5}
              y2={lane + 0.5}
            />
          ))}
          {spans.map((span, index) => (
            // biome-ignore lint/a11y/useSemanticElements: SVG rects implement keyboard activation and cannot contain HTML buttons.
            <rect
              key={span.key}
              x={span.start + 0.08}
              y={span.lane + 0.39}
              width={0.84}
              height={0.22}
              rx={0.04}
              className={`${span.error ? "error" : ""} ${selectedKey === span.key ? "selected" : ""}`}
              data-lane={span.lane}
              data-kind={nodes[index]!.kind}
              data-record-key={span.key}
              role="button"
              tabIndex={0}
              aria-label={t("trajectorySelectRecord", {
                number: index + 1,
                name: nodes[index]!.title,
              })}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelect(span.key);
                }
              }}
            >
              <title>{`${index + 1} · ${nodes[index]!.title} · ${trajectoryDuration(nodes[index]!.durationMs)}`}</title>
            </rect>
          ))}
          {range && (
            <rect
              className="trajectory-range"
              x={range.start}
              y="0"
              width={range.end - range.start}
              height="3"
            />
          )}
        </svg>
        {range && (
          <button
            type="button"
            className="trajectory-clear-range"
            onClick={() => onRange(null)}
          >
            {t("trajectoryClearRange")}
          </button>
        )}
      </div>
    </section>
  );
}
