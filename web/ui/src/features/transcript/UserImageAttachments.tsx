import { Image as ImageIcon } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { WebSessionSource } from "../../../../protocol/session-sources.ts";
import type {
  WebLiveMessage,
  WebMessagePart,
} from "../../../../protocol/types.ts";
import { SourceImage, SourcesDialog } from "../subagents/session-sources.tsx";

export function UserImageAttachments({
  message,
  sessionId,
  path,
  entryId,
}: {
  message: WebLiveMessage;
  sessionId?: string;
  path?: string;
  entryId?: string;
}) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<{
    scope: string;
    source: WebSessionSource;
    open: boolean;
  } | null>(null);
  const scope = JSON.stringify([sessionId, path, entryId]);
  const images =
    message.parts?.filter(
      (part): part is Extract<WebMessagePart, { type: "image" }> =>
        part.type === "image",
    ) ?? [];
  if (images.length === 0) return null;
  const occurrences = new Map<string, number>();
  const current = selected?.scope === scope ? selected : null;
  const close = () =>
    setSelected((value) => (value ? { ...value, open: false } : null));
  return (
    <>
      <section
        className="message-attachments"
        aria-label={t("imageAttachments")}
      >
        {images.map((image) => {
          const identity = `${image.mimeType}:${image.name ?? ""}:${image.previewUrl ?? ""}`;
          const occurrence = occurrences.get(identity) ?? 0;
          occurrences.set(identity, occurrence + 1);
          const key = `${identity}:${occurrence}`;
          const source: WebSessionSource | null =
            sessionId &&
            path &&
            entryId &&
            typeof image.sourcePartIndex === "number" &&
            Number.isSafeInteger(image.sourcePartIndex) &&
            image.sourcePartIndex >= 0
              ? {
                  id: `${entryId}:${image.sourcePartIndex}`,
                  entryId,
                  partIndex: image.sourcePartIndex,
                  kind: "image",
                  name: image.name ?? t("attachedImage"),
                }
              : null;
          const preview = image.previewUrl ? (
            <img
              key="preview"
              src={image.previewUrl}
              alt={image.name ?? t("attachedImage")}
            />
          ) : source && sessionId && path ? (
            <span key="preview" className="message-attachment-preview">
              <SourceImage
                sessionId={sessionId}
                path={path}
                source={source}
                thumbnail
              />
            </span>
          ) : (
            <ImageIcon key="preview" aria-hidden="true" />
          );
          const name = (
            <span key="name">{image.name ?? t("attachedImage")}</span>
          );
          return source ? (
            <button
              className="message-attachment"
              key={key}
              type="button"
              title={source.name}
              aria-label={source.name}
              onClick={() => setSelected({ scope, source, open: true })}
            >
              {preview}
              {name}
            </button>
          ) : (
            <div className="message-attachment" key={key}>
              {preview}
              {name}
            </div>
          );
        })}
      </section>
      {sessionId && path && current && (
        <SourcesDialog
          sessionId={sessionId}
          path={path}
          source={current.source}
          open={current.open}
          onSelect={close}
          onClose={close}
        />
      )}
    </>
  );
}
