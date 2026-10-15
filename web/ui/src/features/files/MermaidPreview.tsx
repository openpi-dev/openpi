import DOMPurify from "dompurify";
import { Expand, Minus, Plus, X } from "lucide-react";
import mermaid from "mermaid";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

// Mermaid's renderer is shared; serialize rendering and keep its strict
// configuration outside document control. Images cannot execute SVG actions.
mermaid.initialize({
  startOnLoad: false,
  securityLevel: "strict",
  suppressErrorRendering: true,
  maxTextSize: 50_000,
  maxEdges: 500,
  theme: "neutral",
  htmlLabels: false,
  secure: [
    "securityLevel",
    "startOnLoad",
    "maxTextSize",
    "maxEdges",
    "suppressErrorRendering",
    "htmlLabels",
  ],
});
let rendering = Promise.resolve();

export default function MermaidPreview({ source }: { source: string }) {
  const { t } = useTranslation();
  const id = `diagram-${useId().replace(/[^a-z0-9]/giu, "")}`;
  const [image, setImage] = useState("");
  const [error, setError] = useState("");
  const [zoom, setZoom] = useState(1);
  const dialog = useRef<HTMLDialogElement>(null);
  const viewport = useRef<HTMLElement>(null);
  const drag = useRef<{
    x: number;
    y: number;
    left: number;
    top: number;
  } | null>(null);
  useEffect(() => {
    let stopped = false;
    rendering = rendering.then(async () => {
      if (stopped) return;
      try {
        if (source.length > 50_000) throw new Error(t("filesDocumentLimit"));
        const result = await mermaid.render(id, source);
        const svg = DOMPurify.sanitize(result.svg, {
          USE_PROFILES: { svg: true, svgFilters: true },
          FORBID_TAGS: ["foreignObject", "a", "image", "use"],
        });
        if (!stopped)
          setImage(
            `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
          );
      } catch (reason) {
        if (!stopped)
          setError(
            reason instanceof Error ? reason.message : t("filesPreviewFailed"),
          );
      }
    });
    return () => {
      stopped = true;
    };
  }, [id, source, t]);
  if (error)
    return (
      <div className="evidence-warning">
        <p>{error}</p>
        <pre>{source}</pre>
      </div>
    );
  return (
    <div className="file-diagram">
      {image ? (
        <>
          <img src={image} alt={t("filesDiagram")} />
          <button
            type="button"
            aria-label={t("filesExpandDiagram")}
            onClick={() => {
              setZoom(1);
              dialog.current?.showModal();
            }}
          >
            <Expand />
          </button>
        </>
      ) : (
        <p role="status">{t("readingFile")}</p>
      )}
      <dialog
        ref={dialog}
        className="file-diagram-dialog"
        aria-label={t("filesDiagram")}
        onCancel={(event) => {
          event.stopPropagation();
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") event.stopPropagation();
        }}
      >
        <div className="file-preview-toolbar">
          <button
            type="button"
            aria-label={t("filesZoomOut")}
            onClick={() => setZoom((value) => Math.max(0.25, value - 0.25))}
          >
            <Minus />
          </button>
          <button type="button" onClick={() => setZoom(1)}>
            {Math.round(zoom * 100)}%
          </button>
          <button
            type="button"
            aria-label={t("filesZoomIn")}
            onClick={() => setZoom((value) => Math.min(4, value + 0.25))}
          >
            <Plus />
          </button>
          <button
            type="button"
            aria-label={t("close")}
            onClick={() => dialog.current?.close()}
          >
            <X />
          </button>
        </div>
        <section
          ref={viewport}
          className="file-media-viewport"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: Enlarged diagrams need keyboard scrolling.
          tabIndex={0}
          aria-label={t("filesDiagram")}
          onWheel={(event) => {
            if (event.ctrlKey || event.metaKey)
              setZoom((value) =>
                Math.max(
                  0.25,
                  Math.min(4, value + (event.deltaY > 0 ? -0.1 : 0.1)),
                ),
              );
          }}
          onPointerDown={(event) => {
            const target = event.currentTarget;
            drag.current = {
              x: event.clientX,
              y: event.clientY,
              left: target.scrollLeft,
              top: target.scrollTop,
            };
            target.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            if (drag.current) {
              event.currentTarget.scrollLeft =
                drag.current.left + drag.current.x - event.clientX;
              event.currentTarget.scrollTop =
                drag.current.top + drag.current.y - event.clientY;
            }
          }}
          onPointerUp={() => {
            drag.current = null;
          }}
          onPointerCancel={() => {
            drag.current = null;
          }}
        >
          {image && (
            <img
              src={image}
              alt={t("filesDiagram")}
              draggable={false}
              style={{ width: `${zoom * 100}%` }}
            />
          )}
        </section>
      </dialog>
    </div>
  );
}
