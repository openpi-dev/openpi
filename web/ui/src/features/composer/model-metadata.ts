import type { TFunction } from "i18next";
import type { WebModelSummary } from "../../../../protocol/types.ts";

export function modelMetadata(model: WebModelSummary, t: TFunction) {
  const parts: string[] = [];
  const context = model.contextWindow;
  if (context && Number.isSafeInteger(context) && context > 0) {
    const value =
      context >= 1_000_000
        ? `${Math.round(context / 100_000) / 10}M`
        : context >= 1_000
          ? `${Math.round(context / 1000)}k`
          : String(context);
    parts.push(`${value} ctx`);
  }
  if (model.reasoning === true) parts.push(t("modelMetaReasoning"));
  if (model.imageInput === true) parts.push(t("modelMetaImageInput"));
  return parts.join(" · ");
}
