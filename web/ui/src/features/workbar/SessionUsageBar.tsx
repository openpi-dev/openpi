import { ArrowDown, ArrowUp, Database, Gauge } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { WebSessionUsage } from "../../../../protocol/types.ts";

function compactTokens(value: number) {
  if (value < 1_000) return String(value);
  if (value < 1_000_000) {
    const scaled = value / 1_000;
    return `${scaled >= 10 ? Math.round(scaled) : scaled.toFixed(1).replace(/\.0$/u, "")}k`;
  }
  const scaled = value / 1_000_000;
  return `${scaled >= 10 ? Math.round(scaled) : scaled.toFixed(1).replace(/\.0$/u, "")}m`;
}

export function SessionUsageBar({ usage }: { usage?: WebSessionUsage }) {
  const { t } = useTranslation();
  if (!usage) return null;
  const cache = usage.cacheRead + usage.cacheWrite;
  const context = usage.context;
  return (
    <fieldset className="session-usage">
      <legend className="sr-only">{t("sessionUsage")}</legend>
      <span title={t("sessionInputTokens")}>
        <ArrowUp aria-hidden="true" /> {compactTokens(usage.input)}
      </span>
      <span title={t("sessionOutputTokens")}>
        <ArrowDown aria-hidden="true" /> {compactTokens(usage.output)}
      </span>
      <span title={t("sessionCacheTokens")}>
        <Database aria-hidden="true" /> {compactTokens(cache)}
      </span>
      {context && (
        <span title={t("sessionContextUsage")}>
          <Gauge aria-hidden="true" />
          {context.percent === null ? "?" : `${Math.round(context.percent)}%`}
          <b>/</b>
          {compactTokens(context.contextWindow)}
        </span>
      )}
    </fieldset>
  );
}
