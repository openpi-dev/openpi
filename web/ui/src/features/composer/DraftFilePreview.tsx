import { Tooltip } from "@astryxdesign/core/Tooltip";
import { Dialog } from "@astryxdesign/core/Dialog";
import { FileText, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { StagedPromptFile } from "./file-attachments.ts";

export function DraftFilePreview({
  ownerKey,
  files,
  onRemove,
}: {
  ownerKey: string;
  files: readonly StagedPromptFile[];
  onRemove: (id: string) => void;
}) {
  const { t } = useTranslation();
  const dialog = useRef<HTMLDialogElement>(null);
  const [selection, setSelection] = useState<{
    ownerKey: string;
    id: string;
    trigger: HTMLButtonElement;
    open: boolean;
  } | null>(null);
  const returnFocus = useRef<typeof selection>(null);
  const file =
    selection?.ownerKey === ownerKey
      ? files.find((item) => item.id === selection.id)
      : undefined;
  const previewOpen = Boolean(file && selection?.open);
  const close = () => {
    if (!previewOpen) return;
    returnFocus.current = selection;
    setSelection((current) => current && { ...current, open: false });
  };
  useEffect(() => {
    if (selection && !file) {
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
      files.some((candidate) => candidate.id === target.id) &&
      target.trigger.isConnected &&
      (focused === document.body || dialog.current?.contains(focused))
    )
      target.trigger.focus();
  }, [selection, file, previewOpen, ownerKey, files]);
  const status = (item: StagedPromptFile) =>
    t(
      item.extractionError
        ? "fileAttachmentExtractionFailed"
        : item.extraction === "truncated"
          ? "fileAttachmentTextTruncated"
          : item.extraction === "text"
            ? "fileAttachmentTextReady"
            : "fileAttachmentOriginalReady",
    );
  return (
    <>
      {files.length > 0 && (
        <section
          className="composer-attachment-group"
          aria-label={t("fileAttachments")}
        >
          {files.map((attachment) => (
            <div
              className="composer-attachment composer-file-attachment"
              key={attachment.id}
            >
              <button
                type="button"
                className="composer-attachment-preview"
                aria-label={`${t("previewFileAttachment")} ${attachment.name}`}
                onClick={(event) => {
                  // Keep Core Dialog's unconditional focus return from
                  // crossing an exact draft creation handoff.
                  event.currentTarget.focus();
                  event.currentTarget.blur();
                  returnFocus.current = null;
                  setSelection({
                    ownerKey,
                    id: attachment.id,
                    trigger: event.currentTarget,
                    open: true,
                  });
                }}
              >
                <FileText aria-hidden="true" />
                <span title={attachment.name}>
                  {attachment.name}
                  <small>
                    {(attachment.size / 1024).toFixed(1)} KB ·{" "}
                    {status(attachment)}
                  </small>
                </span>
              </button>
              <Tooltip
                content={`${t("removeAttachment")} ${attachment.name}`}
                placement="below"
              >
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
        isOpen={previewOpen}
        onOpenChange={(open: boolean) => !open && close()}
        purpose="info"
        width={720}
        maxHeight="calc(100dvh - 32px)"
        padding={0}
        aria-label={`${t("previewFileAttachment")} ${file?.name ?? ""}`.trim()}
      >
        {file && (
          <div className="draft-file-preview" inert={!previewOpen}>
            <header>
              <div className="draft-preview-heading">
                <strong title={file.name}>{file.name}</strong>
                <p>
                  {status(file)} · {(file.size / 1024).toFixed(1)} KB
                </p>
              </div>
              <Tooltip content={t("closePreview")} placement="below">
                <button
                  type="button"
                  data-autofocus
                  aria-label={t("closePreview")}
                  onClick={close}
                >
                  <X aria-hidden="true" />
                </button>
              </Tooltip>
            </header>
            <div className="draft-file-preview-content">
              {file.extractionError && (
                <p>
                  {t(
                    file.extractionError === "encoding"
                      ? "fileAttachmentEncodingUnavailable"
                      : "fileAttachmentDocumentUnavailable",
                  )}
                </p>
              )}
              {file.text !== undefined ? (
                <pre>
                  {file.text.slice(0, 20_000)}
                  {file.text.length > 20_000
                    ? `\n${t("fileAttachmentPreviewTruncated")}`
                    : ""}
                </pre>
              ) : (
                <p>{t("fileAttachmentNoText")}</p>
              )}
            </div>
          </div>
        )}
      </Dialog>
    </>
  );
}
