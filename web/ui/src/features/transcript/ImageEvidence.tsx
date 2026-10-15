import { useTranslation } from "react-i18next";
import type { WebLiveMessage } from "../../../../protocol/types.ts";

/** Describe retained native image parts, never recover omitted content or payloads. */
export function imageEvidence(message?: WebLiveMessage) {
  const count =
    message?.parts?.filter((part) => part.type === "image").length ?? 0;
  const omitted = (message?.truncation?.partsOmitted ?? 0) > 0;
  return { count, omitted, present: count > 0 || omitted };
}

export function ImageEvidence({
  message,
  messages,
}: {
  message?: WebLiveMessage;
  messages?: readonly (WebLiveMessage | undefined)[];
}) {
  const { t } = useTranslation();
  const views = (messages ?? [message]).map(imageEvidence);
  const count = views.reduce((sum, view) => sum + view.count, 0);
  const omitted = views.some((view) => view.omitted);
  const present = count > 0 || omitted;
  if (!present) return null;
  return (
    <span className="tool-summary image-evidence" role="status">
      {count > 0 && t("toolImageEvidence", { count })}
      {omitted && ` ${t("toolImageEvidenceOmitted")}`}
    </span>
  );
}
