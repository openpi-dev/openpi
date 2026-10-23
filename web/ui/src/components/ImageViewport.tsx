import { ZoomIn, ZoomOut } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

const fitted = { scale: 1, x: 0, y: 0 };

export function ImageViewport({
  children,
  original,
  disabled = false,
}: {
  children?: ReactNode;
  original: boolean;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const viewport = useRef<HTMLElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const motion = useRef<Animation | undefined>(undefined);
  const current = useRef(fitted);
  const [view, setView] = useState(fitted);
  const [loaded, setLoaded] = useState(false);
  const [maximum, setMaximum] = useState(2);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{
    pointerId: number;
    x: number;
    y: number;
    view: typeof fitted;
  } | null>(null);
  const update = useCallback((next: typeof fitted, smooth = false) => {
    const element = layer.current;
    const from =
      element && smooth ? getComputedStyle(element).transform : "none";
    motion.current?.cancel();
    current.current = next;
    setView(next);
    if (
      element?.animate &&
      smooth &&
      !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    ) {
      motion.current = element.animate(
        [
          { transform: from },
          {
            transform: `translate(${next.x}px, ${next.y}px) scale(${next.scale})`,
          },
        ],
        { duration: 160, easing: "cubic-bezier(.16, 1, .3, 1)" },
      );
    }
  }, []);
  const interruptMotion = useCallback(() => {
    if (motion.current?.playState !== "running" || !layer.current) return;
    const matrix = new DOMMatrixReadOnly(
      getComputedStyle(layer.current).transform,
    );
    update({ scale: matrix.a, x: matrix.e, y: matrix.f });
  }, [update]);
  useEffect(() => () => motion.current?.cancel(), []);
  const clamp = useCallback((next: typeof fitted) => {
    const image = layer.current?.querySelector("img");
    if (!image || !layer.current) return fitted;
    const maxX = Math.max(
      0,
      (image.offsetWidth * next.scale - layer.current.clientWidth) / 2,
    );
    const maxY = Math.max(
      0,
      (image.offsetHeight * next.scale - layer.current.clientHeight) / 2,
    );
    return {
      scale: next.scale,
      x: Math.max(-maxX, Math.min(maxX, next.x)),
      y: Math.max(-maxY, Math.min(maxY, next.y)),
    };
  }, []);
  const zoom = useCallback(
    (target: number, point?: { x: number; y: number }, smooth = true) => {
      const image = layer.current?.querySelector("img");
      const rect = viewport.current?.getBoundingClientRect();
      if (!image?.offsetWidth || !rect) return;
      const maxScale = Math.min(
        8,
        Math.max(2, image.naturalWidth / image.offsetWidth),
      );
      setMaximum(maxScale);
      const scale = Math.max(1, Math.min(maxScale, target));
      const factor = scale / current.current.scale;
      const x = point ? point.x - rect.left - rect.width / 2 : 0;
      const y = point ? point.y - rect.top - rect.height / 2 : 0;
      update(
        clamp({
          scale,
          x: x - (x - current.current.x) * factor,
          y: y - (y - current.current.y) * factor,
        }),
        smooth,
      );
    },
    [clamp, update],
  );
  const finishDrag = useCallback(
    (cancel = false) => {
      const previous = drag.current;
      drag.current = null;
      setDragging(false);
      if (!previous) return;
      if (cancel) update(previous.view);
      if (viewport.current?.hasPointerCapture(previous.pointerId))
        viewport.current.releasePointerCapture(previous.pointerId);
    },
    [update],
  );

  useEffect(() => {
    finishDrag();
    update(fitted);
    const element = viewport.current;
    if (!element || original) return;
    const wheel = (event: WheelEvent) => {
      if (!layer.current?.querySelector("img")?.complete) return;
      interruptMotion();
      if (event.ctrlKey) {
        event.preventDefault();
        zoom(
          current.current.scale * Math.exp(-event.deltaY * 0.01),
          {
            x: event.clientX,
            y: event.clientY,
          },
          false,
        );
      } else if (current.current.scale > 1) {
        event.preventDefault();
        const unit =
          event.deltaMode === 1
            ? 16
            : event.deltaMode === 2
              ? element.clientHeight
              : 1;
        update(
          clamp({
            ...current.current,
            x: current.current.x - event.deltaX * unit,
            y: current.current.y - event.deltaY * unit,
          }),
        );
      }
    };
    const resize = () => {
      finishDrag();
      update(fitted);
    };
    element.addEventListener("wheel", wheel, { passive: false });
    window.addEventListener("resize", resize);
    return () => {
      element.removeEventListener("wheel", wheel);
      window.removeEventListener("resize", resize);
    };
  }, [original, clamp, finishDrag, interruptMotion, update, zoom]);

  return (
    <section
      ref={viewport}
      className="draft-image-preview-body"
      aria-label={t("imageViewMode")}
      data-mode={original ? "original" : "fit"}
      data-zoomed={(!original && view.scale > 1) || undefined}
      data-dragging={dragging || undefined}
      tabIndex={!disabled && (original || loaded) ? 0 : undefined}
      onLoadCapture={() => {
        setLoaded(true);
        update(fitted);
      }}
      onErrorCapture={() => {
        setLoaded(false);
        update(fitted);
      }}
      onDoubleClick={(event) => {
        if (original || !(event.target instanceof HTMLImageElement)) return;
        zoom(view.scale > 1 ? 1 : 2, { x: event.clientX, y: event.clientY });
      }}
      onPointerDown={(event) => {
        if (
          original ||
          drag.current ||
          event.button !== 0 ||
          view.scale <= 1 ||
          !(event.target instanceof Node) ||
          !layer.current?.contains(event.target)
        )
          return;
        event.preventDefault();
        event.currentTarget.focus({ preventScroll: true });
        interruptMotion();
        drag.current = {
          pointerId: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          view: current.current,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const start = drag.current;
        if (!start || start.pointerId !== event.pointerId) return;
        const dx = event.clientX - start.x,
          dy = event.clientY - start.y;
        if (!dragging && Math.hypot(dx, dy) < 4) return;
        setDragging(true);
        update(
          clamp({ ...start.view, x: start.view.x + dx, y: start.view.y + dy }),
        );
      }}
      onPointerUp={(event) => {
        if (drag.current?.pointerId === event.pointerId) finishDrag();
      }}
      onPointerCancel={(event) => {
        if (drag.current?.pointerId === event.pointerId) finishDrag(true);
      }}
      onLostPointerCapture={() => finishDrag(true)}
      onKeyDown={(event) => {
        if (
          event.nativeEvent.isComposing ||
          event.nativeEvent.keyCode === 229 ||
          event.ctrlKey ||
          event.metaKey ||
          event.altKey ||
          original ||
          event.target !== event.currentTarget
        )
          return;
        if (event.key === "+" || event.key === "=") zoom(view.scale * 1.25);
        else if (event.key === "-") zoom(view.scale / 1.25);
        else if (event.key === "0") zoom(1);
        else if (event.key === "Escape" && drag.current) finishDrag(true);
        else if (
          view.scale > 1 &&
          ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(
            event.key,
          )
        )
          update(
            clamp({
              ...view,
              x:
                view.x +
                (event.key === "ArrowLeft"
                  ? 40
                  : event.key === "ArrowRight"
                    ? -40
                    : 0),
              y:
                view.y +
                (event.key === "ArrowUp"
                  ? 40
                  : event.key === "ArrowDown"
                    ? -40
                    : 0),
            }),
            true,
          );
        else return;
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <div
        ref={layer}
        className="image-zoom-layer"
        style={
          !original
            ? {
                transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
              }
            : undefined
        }
      >
        {children}
      </div>
      {!original && loaded && (
        <fieldset className="image-zoom-controls" aria-label={t("imageZoom")}>
          <button
            type="button"
            aria-label={t("zoomOut")}
            disabled={view.scale <= 1}
            onClick={() => zoom(view.scale / 1.25)}
          >
            <ZoomOut aria-hidden="true" />
          </button>
          <output aria-label={t("imageZoom")} title={t("imageZoomHelp")}>
            {Math.round(view.scale * 100)}%
          </output>
          <button
            type="button"
            aria-label={t("zoomIn")}
            disabled={view.scale >= maximum}
            onClick={() => zoom(view.scale * 1.25)}
          >
            <ZoomIn aria-hidden="true" />
          </button>
        </fieldset>
      )}
    </section>
  );
}
