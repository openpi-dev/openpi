import { Dialog } from "@astryxdesign/core/Dialog";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import { ChevronLeft, ChevronRight, Maximize2, Scan, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ImageViewport } from "../../components/ImageViewport.tsx";
import type { StagedPromptImage } from "./image-attachments.ts";
import { animatePreviewImage } from "./image-preview-motion.ts";

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
  const thumbnails = useRef(new Map<string, HTMLImageElement>());
  const flight = useRef<{ owner: string; id: string; stop: () => void } | null>(
    null,
  );
  const previousImage = useRef<string | null>(null);
  const [selection, setSelection] = useState<{
    ownerKey: string;
    id: string;
    trigger: HTMLButtonElement;
    open: boolean;
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
  const previewOpen = Boolean(image && selection?.open);
  useLayoutEffect(() => {
    const current = flight.current;
    if (
      current &&
      (current.owner !== ownerKey ||
        !images.some((item) => item.id === current.id))
    ) {
      current.stop();
      flight.current = null;
    }
  }, [ownerKey, images]);
  useLayoutEffect(() => () => flight.current?.stop(), []);
  useEffect(() => {
    if (!previewOpen) {
      previousImage.current = null;
      return;
    }
    flight.current?.stop();
    const switching = previousImage.current !== null;
    previousImage.current = identity;
    const target = dialog.current?.querySelector<HTMLImageElement>(
      ".image-zoom-layer img",
    );
    const thumbnail = image && thumbnails.current.get(image.id);
    if (!target || !thumbnail || !image) return;
    let frame = 0;
    let fade: Animation | undefined;
    const reveal = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (!dialog.current?.open) return;
        if (switching) {
          if (!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches)
            fade = target.animate?.([{ opacity: 0 }, { opacity: 1 }], {
              duration: 160,
              easing: "ease-out",
            });
          return;
        }
        const stop = animatePreviewImage(target, thumbnail, true);
        if (stop) flight.current = { owner: ownerKey, id: image.id, stop };
      });
    };
    if (target.complete) reveal();
    else target.addEventListener("load", reveal, { once: true });
    return () => {
      cancelAnimationFrame(frame);
      target.removeEventListener("load", reveal);
      fade?.cancel();
    };
  }, [previewOpen, identity, ownerKey, image]);
  const imageIndex = images.findIndex(
    (candidate) => candidate.id === image?.id,
  );
  const showImage = (offset: number) => {
    const next = images[imageIndex + offset];
    if (!selection || !next) return;
    setFailedImage(null);
    setMode("fit");
    setSelection({ ...selection, id: next.id });
  };

  const close = () => {
    if (!previewOpen) return;
    flight.current?.stop();
    flight.current = null;
    const target = dialog.current?.querySelector<HTMLImageElement>(
      ".image-zoom-layer img",
    );
    const thumbnail = image && thumbnails.current.get(image.id);
    if (target && thumbnail && image) {
      const stop = animatePreviewImage(target, thumbnail, false);
      if (stop) flight.current = { owner: ownerKey, id: image.id, stop };
    }
    returnFocus.current = selection;
    setSelection((current) => current && { ...current, open: false });
  };

  useEffect(() => {
    if (selection && !image) {
      returnFocus.current = null;
      setSelection(null);
      return;
    }
    if (previewOpen || !returnFocus.current) return;
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
  }, [selection, image, previewOpen, ownerKey, images]);

  return (
    <>
      {images.length > 0 && (
        <section
          className="composer-attachment-group"
          aria-label={t("imageAttachments")}
        >
          {images.map((attachment) => (
            <div className="composer-attachment" key={attachment.id}>
              <Tooltip content={t("previewAttachment")} placement="above">
                <button
                  type="button"
                  className="composer-attachment-preview"
                  aria-label={`${t("previewAttachment")} ${attachment.name}`}
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
                      open: true,
                    });
                  }}
                >
                  <img
                    ref={(element) => {
                      if (element)
                        thumbnails.current.set(attachment.id, element);
                      else thumbnails.current.delete(attachment.id);
                    }}
                    src={attachment.previewUrl}
                    alt=""
                  />
                  <span title={attachment.name}>
                    {attachment.name}
                    <small>{(attachment.size / 1024).toFixed(1)} KB</small>
                  </span>
                </button>
              </Tooltip>
              <Tooltip content={t("removeAttachment")} placement="below">
                <button
                  type="button"
                  className="composer-attachment-remove"
                  aria-label={`${t("removeAttachment")} ${attachment.name}`}
                  onClick={() => onRemove(attachment.id)}
                >
                  <X aria-hidden="true" />
                </button>
              </Tooltip>
            </div>
          ))}
        </section>
      )}
      <Dialog
        ref={dialog}
        className="draft-image-dialog"
        isOpen={previewOpen}
        onOpenChange={(next: boolean) => !next && close()}
        purpose="info"
        width={800}
        maxHeight="calc(100dvh - 32px)"
        padding={0}
        aria-label={`${t("previewAttachment")} ${image?.name ?? ""}`.trim()}
      >
        {image && (
          <section
            className="draft-image-preview"
            inert={!previewOpen}
            aria-label={t("imageAttachments")}
            onKeyDown={(event) => {
              if (
                mode === "original" ||
                event.defaultPrevented ||
                event.nativeEvent.isComposing ||
                event.nativeEvent.keyCode === 229 ||
                event.altKey ||
                event.ctrlKey ||
                event.metaKey ||
                !(event.target instanceof HTMLElement) ||
                !event.target.classList.contains("draft-image-preview-body")
              )
                return;
              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight")
                return;
              event.preventDefault();
              showImage(event.key === "ArrowLeft" ? -1 : 1);
            }}
          >
            <header>
              <strong title={image.name}>{image.name}</strong>
              {images.length > 1 && (
                <div className="image-gallery-navigation">
                  <Tooltip content={t("previousImage")} placement="below">
                    <button
                      type="button"
                      aria-label={t("previousImage")}
                      disabled={imageIndex <= 0}
                      onClick={() => showImage(-1)}
                    >
                      <ChevronLeft aria-hidden="true" />
                    </button>
                  </Tooltip>
                  <output
                    aria-label={t("imagePosition", {
                      current: imageIndex + 1,
                      total: images.length,
                    })}
                  >
                    {imageIndex + 1} / {images.length}
                  </output>
                  <Tooltip content={t("nextImage")} placement="below">
                    <button
                      type="button"
                      aria-label={t("nextImage")}
                      disabled={imageIndex >= images.length - 1}
                      onClick={() => showImage(1)}
                    >
                      <ChevronRight aria-hidden="true" />
                    </button>
                  </Tooltip>
                </div>
              )}
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
              <Tooltip content={t("closeImagePreview")} placement="below">
                <button
                  type="button"
                  data-autofocus
                  aria-label={t("closeImagePreview")}
                  onClick={close}
                >
                  <X aria-hidden="true" />
                </button>
              </Tooltip>
            </header>
            <ImageViewport
              key={identity}
              original={mode === "original"}
              disabled={failedImage === identity}
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
                  draggable={false}
                  onError={() => setFailedImage(identity)}
                />
              )}
            </ImageViewport>
          </section>
        )}
      </Dialog>
    </>
  );
}
