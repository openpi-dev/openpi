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
  } | null>(null);
  const returnFocus = useRef<typeof selection>(null);
  const file =
    selection?.ownerKey === ownerKey
      ? files.find((item) => item.id === selection.id)
      : undefined;
  const close = () => {
    returnFocus.current = selection;
    setSelection(null);
  };
  useEffect(() => {
    if (selection && !file) {
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
      files.some((candidate) => candidate.id === target.id) &&
      target.trigger.isConnected &&
      (focused === document.body || dialog.current?.contains(focused))
    )
      target.trigger.focus();
  }, [selection, file, ownerKey, files]);
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
          className="composer-attachments"
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
                  });
                }}
              >
                <FileText aria-hidden="true" />
              </button>
              <span title={attachment.name}>
                {attachment.name}
                <small>{status(attachment)}</small>
              </span>
              <button
                type="button"
                className="composer-attachment-remove"
                aria-label={`${t("removeAttachment")} ${attachment.name}`}
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
        isOpen={Boolean(file)}
        onOpenChange={(open: boolean) => !open && close()}
        purpose="info"
        width={720}
        maxHeight="calc(100dvh - 32px)"
        aria-label={`${t("previewFileAttachment")} ${file?.name ?? ""}`.trim()}
      >
        {file && (
          <div className="draft-file-preview">
            <strong>{file.name}</strong>
            <p>
              {status(file)} · {(file.size / 1024).toFixed(1)} KB
            </p>
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
        )}
      </Dialog>
    </>
  );
}
