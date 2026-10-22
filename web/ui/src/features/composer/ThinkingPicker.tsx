import { Tooltip } from "@astryxdesign/core/Tooltip";
import { ChevronRight, RotateCcw } from "lucide-react";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  WebModelSummary,
  WebSnapshot,
} from "../../../../protocol/types.ts";
import type { WebStoreActions } from "../../store/web-store.ts";
import { ProviderIcon } from "../settings/ProviderIcon.tsx";
import { modelIdentity } from "./model-identity.ts";

export function ThinkingPicker({
  snapshot,
  model,
  pending,
  disabled,
  actions,
  onChooseModel,
  onClose,
  active = true,
}: {
  active?: boolean;
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
  const shown = pending ?? thinking?.level ?? "";
  const hidden = snapshot?.preferences.hiddenThinkingLevels ?? [];
  const levels = (thinking?.available ?? []).filter(
    (level) =>
      !hidden.some((item) => item === level) ||
      level === shown ||
      level === thinking?.level,
  );
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
    if (active) slider.current?.focus();
    return () => {
      previewRef.current = null;
    };
  }, [active]);
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
        <small>{t("thinkingLevel")}</small>
        <span>{label(displayed)}</span>
      </div>
      <div
        className="thinking-slider"
        style={
          {
            "--thinking-position":
              levels.length > 1 ? index / (levels.length - 1) : 0,
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
      <Tooltip
        content={`${model ? modelIdentity(model) : t("selectModel")} · ${t("selectModel")}`}
        placement="above"
      >
        <button
          type="button"
          className="thinking-model-link"
          disabled={pending !== null}
          onClick={onChooseModel}
        >
          {model && (
            <ProviderIcon
              id={model.provider}
              modelId={model.id}
              modelName={model.name}
            />
          )}
          <span>{model?.name || model?.id || t("selectModel")}</span>
          <ChevronRight aria-hidden="true" />
        </button>
      </Tooltip>
      <Tooltip
        content={t("resetThinking", { level: label(openedLevel) })}
        placement="above"
      >
        <button
          type="button"
          className="thinking-reset"
          aria-label={t("resetThinking", { level: label(openedLevel) })}
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
      </Tooltip>
      {thinking && !levels.includes(thinking.level) && (
        <p className="thinking-control-notice" role="status">
          {t("thinkingLevelMismatch")}
        </p>
      )}
    </div>
  );
}
