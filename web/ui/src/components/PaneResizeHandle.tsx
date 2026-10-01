import { useRef } from "react";
import { useTranslation } from "react-i18next";

interface PaneResizeHandleProps {
  side: "left" | "right";
  value: number;
  min: number;
  max: number;
  defaultValue: number;
  collapseThreshold?: number;
  onCollapse?: () => void;
  onExpandPastMax?: () => void;
  onChange: (value: number) => void;
  onDraggingChange: (dragging: boolean) => void;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function PaneResizeHandle({
  side,
  value,
  min,
  max,
  defaultValue,
  collapseThreshold,
  onCollapse,
  onExpandPastMax,
  onChange,
  onDraggingChange,
}: PaneResizeHandleProps) {
  const { t } = useTranslation();
  const drag = useRef<{
    pointerId: number;
    startX: number;
    startValue: number;
  } | null>(null);

  const finishDrag = (element: HTMLElement, pointerId: number) => {
    if (drag.current?.pointerId !== pointerId) return;
    drag.current = null;
    if (element.hasPointerCapture(pointerId))
      element.releasePointerCapture(pointerId);
    onDraggingChange(false);
  };

  const update = (next: number) => onChange(clamp(next, min, max));

  return (
    <hr
      className={`pane-resizer ${side}`}
      tabIndex={0}
      aria-label={t(side === "left" ? "resizeSidebar" : "resizeWorkbar")}
      aria-orientation="vertical"
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      data-pane-resizer={side}
      onKeyDown={(event) => {
        let next: number;
        switch (event.key) {
          case "ArrowLeft":
          case "ArrowRight": {
            const direction = event.key === "ArrowRight" ? 1 : -1;
            next = value + direction * (side === "left" ? 16 : -16);
            break;
          }
          case "Home":
            next = min;
            break;
          case "End":
            next = max;
            break;
          case "Enter":
            next = defaultValue;
            break;
          default:
            return;
        }
        event.preventDefault();
        update(next);
      }}
      onDoubleClick={() => update(defaultValue)}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        drag.current = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startValue: value,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
        onDraggingChange(true);
      }}
      onPointerMove={(event) => {
        const current = drag.current;
        if (!current || current.pointerId !== event.pointerId) return;
        const delta = event.clientX - current.startX;
        const next = current.startValue + (side === "left" ? delta : -delta);
        if (onExpandPastMax && next >= max + 48) {
          finishDrag(event.currentTarget, event.pointerId);
          onExpandPastMax();
          return;
        }
        if (
          onCollapse &&
          collapseThreshold !== undefined &&
          next <= collapseThreshold
        ) {
          finishDrag(event.currentTarget, event.pointerId);
          onCollapse();
          return;
        }
        update(next);
      }}
      onPointerUp={(event) => finishDrag(event.currentTarget, event.pointerId)}
      onPointerCancel={(event) =>
        finishDrag(event.currentTarget, event.pointerId)
      }
      onLostPointerCapture={() => {
        if (!drag.current) return;
        drag.current = null;
        onDraggingChange(false);
      }}
    />
  );
}
