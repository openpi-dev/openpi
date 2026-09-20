import { Dialog } from "@astryxdesign/core/Dialog";
import { TextInput } from "@astryxdesign/core/TextInput";
import { FileText } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { WebApiError, WebClient } from "../../protocol/client.ts";

const artifactErrorKeys = {
  ARTIFACT_DENIED: "fileReferenceDenied",
  ARTIFACT_MISSING: "fileReferenceMissing",
  ARTIFACT_UNSUPPORTED: "fileReferenceUnsupported",
  ARTIFACT_EXPIRED: "fileReferenceExpired",
  ARTIFACT_LIMIT: "fileReferenceBusy",
  ARTIFACT_BUSY: "fileReferenceBusy",
} as const;

export function FileReferenceDialog({
  open,
  sessionId,
  onClose,
  onInsert,
}: {
  open: boolean;
  sessionId?: string;
  onClose: () => void;
  onInsert: (reference: string) => void;
}) {
  const { t } = useTranslation();
  const client = useMemo(() => new WebClient(), []);
  const request = useRef<AbortController | null>(null);
  const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void open;
    void sessionId;
    setReference("");
    setBusy(false);
    setError(null);
    return () => {
      request.current?.abort();
      request.current = null;
    };
  }, [open, sessionId]);

  const close = () => {
    request.current?.abort();
    request.current = null;
    onClose();
  };

  const insert = async () => {
    const value = reference.trim();
    if (!value || request.current) return;
    setError(null);
    if (!sessionId) {
      onInsert(value);
      onClose();
      return;
    }

    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    let handle: string | undefined;
    try {
      handle = (
        await client.resolveArtifact(
          sessionId,
          value,
          undefined,
          controller.signal,
        )
      ).handle;
      if (controller.signal.aborted) return;
      await client.artifactMetadata(sessionId, handle, controller.signal);
      if (controller.signal.aborted) return;
      onInsert(value);
      onClose();
    } catch (reason) {
      if (!controller.signal.aborted) {
        const key =
          reason instanceof WebApiError && reason.code
            ? artifactErrorKeys[reason.code as keyof typeof artifactErrorKeys]
            : undefined;
        setError(
          key
            ? t(key)
            : reason instanceof Error
              ? reason.message
              : t("fileReferenceFailed"),
        );
      }
    } finally {
      if (request.current === controller) request.current = null;
      if (handle)
        void client.releaseArtifact(sessionId, handle).catch(() => undefined);
      if (!controller.signal.aborted) setBusy(false);
    }
  };

  return (
    <Dialog
      isOpen={open}
      onOpenChange={(next: boolean) => !next && close()}
      purpose="form"
      width={460}
      aria-label={t("fileReferenceTitle")}
    >
      <form
        className="openpi-dialog file-reference-dialog"
        onSubmit={(event) => {
          event.preventDefault();
          void insert();
        }}
      >
        <div className="file-reference-heading">
          <FileText aria-hidden="true" />
          <div>
            <strong>{t("fileReferenceTitle")}</strong>
            <p>{t("fileReferenceDetail")}</p>
          </div>
        </div>
        <TextInput
          label={t("fileReferenceLabel")}
          value={reference}
          placeholder={t("fileReferencePlaceholder")}
          description={t(
            sessionId ? "fileReferenceValidatedHint" : "fileReferenceDraftHint",
          )}
          hasAutoFocus
          hasClear
          isDisabled={busy}
          onChange={(value: string) => {
            setReference(value.slice(0, 4096));
            setError(null);
          }}
        />
        {error && (
          <p className="file-reference-error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" onClick={close}>
            {t("cancel")}
          </button>
          <button
            type="submit"
            className="primary"
            disabled={busy || !reference.trim()}
          >
            {busy ? t("fileReferenceChecking") : t("insertReference")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
