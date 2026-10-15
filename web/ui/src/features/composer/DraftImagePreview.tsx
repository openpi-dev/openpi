import { Dialog } from "@astryxdesign/core/Dialog";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import { Maximize2, Scan, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { StagedPromptImage } from "./image-attachments.ts";

export function DraftImagePreview({
  ownerKey,
  images,
  onRemove,
}: {
  ownerKey: string;
  images: readonly StagedPromptImage[];
  onRemove: (id: string) => void;
}) {
  const { t } = useTranslation();
  const dialog = useRef<HTMLDialogElement>(null);
  const [selection, setSelection] = useState<{
    ownerKey: string;
    id: string;
    trigger: HTMLButtonElement;
  } | null>(null);
  const returnFocus = useRef<typeof selection>(null);
  const [failedImage, setFailedImage] = useState<string | null>(null);
  const [mode, setMode] = useState<"fit" | "original">("fit");
  const image =
    selection?.ownerKey === ownerKey
      ? images.find((candidate) => candidate.id === selection.id)
      : undefined;
  const identity = selection
    ? JSON.stringify([selection.ownerKey, selection.id])
    : "";

  const close = () => {
    returnFocus.current = selection;
    setSelection(null);
  };

  useEffect(() => {
    if (selection && !image) {
      returnFocus.current = null;
      setSelection(null);
      return;
    }
    if (selection || !returnFocus.current) return;
    const target = returnFocus.current;
    returnFocus.current = null;
    const focused = document.activeElement;
    if (
      target.ownerKey === ownerKey &&
      images.some((candidate) => candidate.id === target.id) &&
      target.trigger.isConnected &&
      (focused === document.body || dialog.current?.contains(focused))
    )
      target.trigger.focus();
  }, [selection, image, ownerKey, images]);

  return (
    <>
      {images.length > 0 && (
        <section
          className="composer-attachments"
          aria-label={t("imageAttachments")}
        >
          {images.map((attachment) => (
            <div className="composer-attachment" key={attachment.id}>
              <button
                type="button"
                className="composer-attachment-preview"
                aria-label={`${t("previewAttachment")} ${attachment.name}`}
                title={t("previewAttachment")}
                onClick={(event) => {
                  // Dialog restores its opening focus unconditionally; keep
                  // that return from crossing draft ownership.
                  event.currentTarget.focus();
                  event.currentTarget.blur();
                  returnFocus.current = null;
                  setFailedImage(null);
                  setMode("fit");
                  setSelection({
                    ownerKey,
                    id: attachment.id,
                    trigger: event.currentTarget,
                  });
                }}
              >
                <img src={attachment.previewUrl} alt="" />
              </button>
              <span title={attachment.name}>{attachment.name}</span>
              <button
                type="button"
                className="composer-attachment-remove"
                aria-label={`${t("removeAttachment")} ${attachment.name}`}
                title={t("removeAttachment")}
                onClick={() => onRemove(attachment.id)}
              >
                <X aria-hidden="true" />
              </button>
            </div>
          ))}
        </section>
      )}
      <Dialog
        ref={dialog}
        isOpen={Boolean(image)}
        onOpenChange={(next: boolean) => !next && close()}
        purpose="info"
        width={800}
        maxHeight="calc(100dvh - 32px)"
        padding={0}
        aria-label={`${t("previewAttachment")} ${image?.name ?? ""}`.trim()}
      >
        {image && (
          <div className="draft-image-preview">
            <header>
              <strong title={image.name}>{image.name}</strong>
              <fieldset
                className="draft-image-preview-modes"
                aria-label={t("imageViewMode")}
              >
                <Tooltip content={t("fitImage")} placement="below">
                  <button
                    type="button"
                    aria-label={t("fitImage")}
                    aria-pressed={mode === "fit"}
                    disabled={failedImage === identity}
                    onClick={() => setMode("fit")}
                  >
                    <Scan aria-hidden="true" />
                  </button>
                </Tooltip>
                <Tooltip content={t("originalImageSize")} placement="below">
                  <button
                    type="button"
                    aria-label={t("originalImageSize")}
                    aria-pressed={mode === "original"}
                    disabled={failedImage === identity}
                    onClick={() => setMode("original")}
                  >
                    <Maximize2 aria-hidden="true" />
                  </button>
                </Tooltip>
              </fieldset>
              <button
                type="button"
                data-autofocus
                aria-label={t("closeImagePreview")}
                title={t("closeImagePreview")}
                onClick={close}
              >
                <X aria-hidden="true" />
              </button>
            </header>
            <section
              className="draft-image-preview-body"
              aria-label={t("imageViewMode")}
              data-mode={mode}
              tabIndex={
                mode === "original" && failedImage !== identity ? 0 : undefined
              }
            >
              {failedImage === identity ? (
                <p className="composer-attachment-error" role="alert">
                  {t("imagePreviewFailed")}
                </p>
              ) : (
                <img
                  key={identity}
                  src={image.previewUrl}
                  alt={image.name}
                  onError={() => setFailedImage(identity)}
                />
              )}
            </section>
          </div>
        )}
      </Dialog>
    </>
  );
}
