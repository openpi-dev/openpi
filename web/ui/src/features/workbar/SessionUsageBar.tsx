import { ChevronDown, Gauge } from "lucide-react";
import { useId } from "react";
import { useTranslation } from "react-i18next";
import type { WebSessionUsage } from "../../../../protocol/types.ts";

export function SessionUsageBar({ usage }: { usage?: WebSessionUsage }) {
  const { t, i18n } = useTranslation();
  const id = useId();
  if (!usage) return null;
  const context = usage.context;
  const format = (value: number) =>
    new Intl.NumberFormat(i18n.resolvedLanguage).format(value);
  const percent =
    context?.percent == null
      ? t("usageUnknown")
      : `${Math.round(context.percent)}%`;
  return (
    <div className="session-usage">
      <button
        type="button"
        popoverTarget={id}
        aria-label={t("usageOpenDetails", { percent })}
      >
        <Gauge aria-hidden="true" />
        {t("usageContextLabel")} {percent}
        <ChevronDown aria-hidden="true" />
      </button>
      <section
        id={id}
        popover="auto"
        className="session-usage-details"
        aria-label={t("sessionUsage")}
      >
        <div className="usage-context-heading">
          <h2>{t("usageContextWindow")}</h2>
          <strong>{percent}</strong>
        </div>
        {context?.percent != null && (
          <progress
            value={Math.max(0, Math.min(100, context.percent))}
            max={100}
            aria-label={t("usageContextWindow")}
          />
        )}
        <p className="usage-context-value">
          {context?.tokens == null ? t("usageUnknown") : format(context.tokens)}
          {context && ` / ${format(context.contextWindow)}`} token
        </p>
        <p>{t("usageContextHelp")}</p>
        <details className="usage-totals">
          <summary>{t("usageSessionTotals")}</summary>
          <dl>
            <div>
              <dt>{t("sessionInputTokens")}</dt>
              <dd>{format(usage.input)}</dd>
            </div>
            <div>
              <dt>{t("sessionOutputTokens")}</dt>
              <dd>{format(usage.output)}</dd>
            </div>
            <div>
              <dt>{t("usageCacheRead")}</dt>
              <dd>{format(usage.cacheRead)}</dd>
            </div>
            <div>
              <dt>{t("usageCacheWrite")}</dt>
              <dd>{format(usage.cacheWrite)}</dd>
            </div>
          </dl>
          <p>{t("usageTotalsHelp")}</p>
        </details>
      </section>
    </div>
  );
}
