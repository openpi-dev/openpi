import { ChevronRight, RotateCcw } from "lucide-react";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  WebModelSummary,
  WebSnapshot,
} from "../../../../protocol/types.ts";
import type { WebStoreActions } from "../../store/web-store.ts";

export function ThinkingPicker({
  snapshot,
  model,
  pending,
  disabled,
  actions,
  onChooseModel,
  onClose,
}: {
  snapshot: WebSnapshot | null;
  model?: WebModelSummary | null;
  pending: string | null;
  disabled: boolean;
  actions: WebStoreActions;
  onChooseModel: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const thinking = snapshot?.thinking;
  const levels = thinking?.available ?? [];
  const shown = pending ?? thinking?.level ?? "";
  const [openedLevel] = useState(thinking?.level ?? "");
  const [preview, setPreview] = useState<number | null>(null);
  const previewRef = useRef<number | null>(null);
  const slider = useRef<HTMLInputElement>(null);
  const label = (level: string) =>
    level ? level[0]!.toUpperCase() + level.slice(1) : t("unknownState");
  const clearPreview = () => {
    previewRef.current = null;
    setPreview(null);
  };
  useEffect(() => {
    slider.current?.focus();
    return () => {
      previewRef.current = null;
    };
  }, []);
  const commit = () => {
    const index = previewRef.current;
    clearPreview();
    if (index === null || disabled || !thinking?.supported) return;
    const level = levels[index];
    if (level && level !== shown) actions.selectThinking(level);
  };
  const index = preview ?? Math.max(0, levels.indexOf(shown));
  const displayed = preview === null ? shown : (levels[index] ?? shown);
  return (
    <div className="thinking-controls">
      <div className="thinking-strength" aria-live="polite">
        {label(displayed)}
      </div>
      <div
        className="thinking-slider"
        style={
          {
            "--thinking-progress": `${levels.length > 1 ? (index / (levels.length - 1)) * 100 : 0}%`,
          } as CSSProperties
        }
      >
        <div className="thinking-slider-dots" aria-hidden="true">
          {levels.map((level, at) => (
            <span key={level} data-filled={at <= index} />
          ))}
        </div>
        <input
          ref={slider}
          type="range"
          aria-label={t("thinkingLevel")}
          aria-valuetext={label(displayed)}
          min={0}
          max={Math.max(0, levels.length - 1)}
          step={1}
          value={index}
          disabled={disabled || !thinking?.supported || levels.length < 2}
          onChange={(event) => {
            previewRef.current = Number(event.target.value);
            setPreview(previewRef.current);
          }}
          onPointerUp={commit}
          onPointerCancel={clearPreview}
          onBlur={commit}
          onKeyUp={(event) => {
            if (
              [
                "ArrowLeft",
                "ArrowRight",
                "ArrowUp",
                "ArrowDown",
                "Home",
                "End",
                "PageUp",
                "PageDown",
              ].includes(event.key)
            )
              commit();
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              clearPreview();
              onClose();
              event.preventDefault();
              event.stopPropagation();
            }
          }}
        />
      </div>
      <button
        type="button"
        className="thinking-model-link"
        disabled={pending !== null}
        title={t("selectModel")}
        onClick={onChooseModel}
      >
        <span>{model?.name || model?.id || t("selectModel")}</span>
        <ChevronRight aria-hidden="true" />
      </button>
      <button
        type="button"
        className="thinking-reset"
        aria-label={t("resetThinking", { level: label(openedLevel) })}
        title={t("resetThinking", { level: label(openedLevel) })}
        disabled={
          disabled || !levels.includes(openedLevel) || shown === openedLevel
        }
        onClick={() => {
          clearPreview();
          actions.selectThinking(openedLevel);
        }}
      >
        <RotateCcw aria-hidden="true" />
      </button>
      {thinking && !levels.includes(thinking.level) && (
        <p className="thinking-control-notice" role="status">
          {t("thinkingLevelMismatch")}
        </p>
      )}
    </div>
  );
}
