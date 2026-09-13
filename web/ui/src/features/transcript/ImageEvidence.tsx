import type { WebImageMetadata } from "../../../../protocol/types.ts";
import { useTranslation } from "react-i18next";
import { i18n } from "../../i18n.ts";

function imageBytes(value: number | undefined) {
  if (value === undefined || !Number.isSafeInteger(value) || value < 0)
    return undefined;
  if (value < 1_024) return `${value} bytes`;
  if (value < 1_024 * 1_024) return `${Math.round(value / 1_024)} KiB`;
  return `${(value / (1_024 * 1_024)).toFixed(1)} MiB`;
}

export function ImageEvidence({
  images,
  imageCount,
  partsOmitted = 0,
  unsupportedContentBlocks = 0,
}: {
  images?: readonly WebImageMetadata[];
  imageCount?: number;
  partsOmitted?: number;
  unsupportedContentBlocks?: number;
}) {
  const { t } = useTranslation(undefined, { i18n });
  const imageMetadata = images ?? [];
  const count = imageCount ?? imageMetadata.length;
  const omitted = Math.max(0, count - imageMetadata.length);
  const imageKeys = new Map<string, number>();
  if (count <= 0 && unsupportedContentBlocks <= 0 && partsOmitted <= 0)
    return null;
  return (
    <div className="evidence-warning image-evidence" role="status">
      {count > 0 && (
        <p>
          {t(count === 1 ? "toolImageUnavailable" : "toolImagesUnavailable", {
            count,
          })}
        </p>
      )}
      {imageMetadata.map((image) => {
        const size = imageBytes(image.bytes);
        const identity = `${image.mimeType || "unknown"}-${image.bytes ?? "unknown"}`;
        const occurrence = imageKeys.get(identity) ?? 0;
        imageKeys.set(identity, occurrence + 1);
        return (
          <p key={`${identity}-${occurrence}`}>
            {image.mimeType || t("toolImageUnknownType")}
            {size ? ` · ${size}` : ""}
          </p>
        );
      })}
      {omitted > 0 && (
        <p>{t("toolImagesMetadataOmitted", { count: omitted })}</p>
      )}
      {unsupportedContentBlocks > 0 && (
        <p>
          {t("toolUnsupportedContentBlocks", {
            count: unsupportedContentBlocks,
          })}
        </p>
      )}
      {partsOmitted > 0 && (
        <p>{t("toolContentPartsOmitted", { count: partsOmitted })}</p>
      )}
    </div>
  );
}
