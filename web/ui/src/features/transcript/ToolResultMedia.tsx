import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type {
  WebLiveMessage,
  WebMessagePart,
} from "../../../../protocol/types.ts";

const DISPLAY_LIMIT = "10 MB";

type ImagePart = Extract<WebMessagePart, { type: "image" }>;

export function toolResultImages(message?: WebLiveMessage) {
  return (
    message?.parts?.filter(
      (part): part is ImagePart => part.type === "image",
    ) ?? []
  );
}

export function toolResultMediaFacts(message?: WebLiveMessage) {
  const images = toolResultImages(message);
  const unsupported = message?.unsupportedParts ?? 0;
  const omitted = message?.truncation?.partsOmitted ?? 0;
  return {
    images,
    unsupported,
    omitted,
    present: images.length > 0 || unsupported > 0 || omitted > 0,
  };
}

/** Visible summary of image evidence. Bytes are never included. */
export function toolResultMediaSummary(
  message: WebLiveMessage | undefined,
  t: TFunction,
) {
  const facts = toolResultMediaFacts(message);
  if (!facts.present) return undefined;
  const parts: string[] = [];
  if (facts.images.length > 0) {
    const types = [...new Set(facts.images.map((image) => image.mimeType))]
      .slice(0, 4)
      .join(", ");
    parts.push(
      t("toolResultImageSummary", { count: facts.images.length, types }),
    );
    const oversized = facts.images.filter((image) => image.bytesOmitted).length;
    if (facts.images.length > oversized)
      parts.push(t("toolResultImagePreviewUnavailable"));
    if (oversized > 0)
      parts.push(t("toolResultImageOversized", { count: oversized }));
  }
  if (facts.unsupported > 0)
    parts.push(t("toolResultUnsupportedParts", { count: facts.unsupported }));
  if (facts.omitted > 0)
    parts.push(t("toolResultPartsOmitted", { count: facts.omitted }));
  return parts.join(" · ");
}

export function ToolResultMedia({ message }: { message?: WebLiveMessage }) {
  const { t } = useTranslation();
  const images = toolResultImages(message);
  if (images.length === 0) return null;
  return (
    <section
      className="tool-result-media"
      aria-label={t("toolResultImagesLabel")}
    >
      <ul className="tool-result-images">
        {images.map((image) => (
          <li
            key={`${image.sourcePartIndex ?? "image"}:${image.mimeType}:${image.name ?? ""}`}
          >
            <span>{image.name || t("toolResultImageItem")}</span>
            <span>{image.mimeType}</span>
            <span>
              {image.bytesOmitted
                ? t("toolResultImageOversizedDetail", { limit: DISPLAY_LIMIT })
                : t("toolResultImagePreviewDetail")}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
