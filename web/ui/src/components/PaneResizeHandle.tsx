import { useRef } from "react";

interface PaneResizeHandleProps {
  side: "left" | "right";
  value: number;
  min: number;
  max: number;
  defaultValue: number;
  collapseThreshold?: number;
  onCollapse?: () => void;
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
  onChange,
  onDraggingChange,
}: PaneResizeHandleProps) {
  const drag = useRef<{
    pointerId: number;
    startX: number;
    startValue: number;
  } | null>(null);

  const finishDrag = (element: HTMLDivElement, pointerId: number) => {
    if (drag.current?.pointerId !== pointerId) return;
    drag.current = null;
    if (element.hasPointerCapture(pointerId))
      element.releasePointerCapture(pointerId);
    onDraggingChange(false);
  };

  const update = (next: number) => onChange(clamp(next, min, max));

  return (
    <div
      className={`pane-resizer ${side}`}
      aria-hidden="true"
      data-pane-resizer={side}
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
