import {
  Popover,
  type PopoverTriggerRenderProps,
} from "@astryxdesign/core/Popover";
import { ArrowDown, ArrowUp, ChevronDown, Gauge, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { WebSessionUsage } from "../../../../protocol/types.ts";

export function SessionUsageBar({
  usage,
  workspace,
  sessionId,
}: {
  usage?: WebSessionUsage;
  workspace?: string;
  sessionId?: string;
}) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  if (!usage) return null;
  const context = usage.context;
  const format = (value: number) =>
    new Intl.NumberFormat(i18n.resolvedLanguage).format(value);
  const compact = (value: number) =>
    new Intl.NumberFormat("en", {
      notation: "compact",
      maximumFractionDigits: 0,
    })
      .format(value)
      .toLowerCase();
  const percent =
    context?.percent == null
      ? t("usageUnknown")
      : `${Math.round(context.percent)}%`;
  const precisePercent =
    context?.percent == null
      ? t("usageUnknown")
      : `${new Intl.NumberFormat(i18n.resolvedLanguage, {
          maximumFractionDigits: 1,
        }).format(context.percent)}%`;
  const capacity = context ? compact(context.contextWindow) : t("usageUnknown");
  return (
    <div className="session-usage">
      <Popover
        isOpen={open}
        onOpenChange={setOpen}
        placement="below"
        alignment="end"
        width="min(360px, calc(100vw - 24px))"
        label={t("sessionUsage")}
        isModal={false}
        hasCloseButton={false}
        content={
          <div className="session-usage-details">
            <div className="usage-details-heading">
              <h2>{t("sessionOverview")}</h2>
              <button
                className="icon-button"
                type="button"
                aria-label={t("close")}
                onClick={() => setOpen(false)}
              >
                <X aria-hidden="true" />
              </button>
            </div>
            <section className="usage-section">
              <div className="usage-context-heading">
                <h3>{t("usageContextLabel")}</h3>
                <span>{precisePercent}</span>
              </div>
              <p className="usage-context-value">
                <strong>
                  {context?.tokens == null
                    ? t("usageUnknown")
                    : format(context.tokens)}
                </strong>
                {context && (
                  <span> / {format(context.contextWindow)} tokens</span>
                )}
              </p>
              {context?.percent != null && (
                <progress
                  value={Math.max(0, Math.min(100, context.percent))}
                  max={100}
                  aria-label={t("sessionContextUsage")}
                />
              )}
              <p className="usage-help">{t("usageContextHelp")}</p>
            </section>
            <section className="usage-section">
              <h3>{t("usageSessionTotals")}</h3>
              <dl className="usage-metrics">
                <div>
                  <dt>{t("usageInputLabel")}</dt>
                  <dd>{format(usage.input)}</dd>
                </div>
                <div>
                  <dt>{t("usageOutputLabel")}</dt>
                  <dd>{format(usage.output)}</dd>
                </div>
                <div>
                  <dt>{t("usageTotalLabel")}</dt>
                  <dd>{format(usage.total)}</dd>
                </div>
              </dl>
              <p className="usage-help">{t("usageTotalsHelp")}</p>
            </section>
            {workspace && (
              <dl className="usage-workspace">
                <dt>{t("usageWorkspaceLabel")}</dt>
                <dd>{workspace}</dd>
              </dl>
            )}
            {sessionId && (
              <details className="usage-identity">
                <summary>
                  <span>{t("usageSessionId")}</span>
                  <ChevronDown aria-hidden="true" />
                </summary>
                <code>{sessionId}</code>
              </details>
            )}
          </div>
        }
      >
        {(props: PopoverTriggerRenderProps) => (
          <button
            {...props}
            className="session-usage-trigger"
            type="button"
            aria-label={t("usageOpenDetails", {
              input: compact(usage.input),
              output: compact(usage.output),
              percent,
              capacity,
            })}
          >
            <span
              className="usage-stat"
              title={`${t("sessionInputTokens")}: ${format(usage.input)}`}
            >
              <ArrowUp aria-hidden="true" />
              <span>{compact(usage.input)}</span>
            </span>
            <span
              className="usage-stat"
              title={`${t("sessionOutputTokens")}: ${format(usage.output)}`}
            >
              <ArrowDown aria-hidden="true" />
              <span>{compact(usage.output)}</span>
            </span>
            <span
              className="usage-stat"
              title={`${t("sessionContextUsage")}: ${precisePercent}`}
            >
              <Gauge aria-hidden="true" />
              <span>
                {percent}
                {context && (
                  <span className="usage-capacity"> / {capacity}</span>
                )}
              </span>
            </span>
          </button>
        )}
      </Popover>
    </div>
  );
}
