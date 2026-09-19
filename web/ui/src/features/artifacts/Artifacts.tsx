import { Check, Clipboard, Download, RefreshCw, X } from "lucide-react";
import {
  forwardRef,
  type ReactNode,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import type { ArtifactPreview } from "../../../../protocol/artifacts.ts";
import { Markdown } from "../../components/Markdown.tsx";
import { copyText } from "../../lib/clipboard.ts";
import { WebClient } from "../../protocol/client.ts";
import { ArtifactContext } from "./context.ts";

export interface ArtifactProviderHandle {
  close: () => void;
}

export const ArtifactProvider = forwardRef<
  ArtifactProviderHandle,
  {
    sessionId?: string;
    children?: ReactNode;
    disabled?: boolean;
    onOpen?: () => void;
    onClose?: () => void;
  }
>(function ArtifactProvider(
  { sessionId, children, disabled = false, onOpen, onClose },
  ref,
) {
  const { t } = useTranslation();
  const client = useMemo(() => new WebClient(), []);
  const [request, setRequest] = useState<{
    sessionId?: string;
    reference: string;
    parent?: string;
  } | null>(null);
  const [preview, setPreview] = useState<ArtifactPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copyStatus, setCopyStatus] = useState<"copied" | "failed" | null>(
    null,
  );
  const opener = useRef<HTMLElement | null>(null);
  const copyGeneration = useRef(0);
  const closeButton = useRef<HTMLButtonElement>(null);
  const downloadAbort = useRef<AbortController | null>(null);
  const blobUrls = useRef(new Set<string>());
  const nextParent = useRef<string | undefined>(undefined);
  const open = useCallback(
    (reference: string, parent?: string) => {
      if (disabled) return;
      onOpen?.();
      const active = document.activeElement;
      if (!(active instanceof HTMLElement && active.closest(".artifact-panel")))
        opener.current = active instanceof HTMLElement ? active : null;
      copyGeneration.current++;
      setPreview(null);
      setError(null);
      setCopyStatus(null);
      nextParent.current = parent;
      setRequest({ reference, parent, sessionId });
    },
    [disabled, onOpen, sessionId],
  );
  const close = useCallback(() => {
    copyGeneration.current++;
    setRequest(null);
    setPreview(null);
    setCopyStatus(null);
    onClose?.();
    opener.current?.focus();
  }, [onClose]);
  useImperativeHandle(ref, () => ({ close }), [close]);
  useEffect(() => {
    if (request && request.sessionId !== sessionId) {
      copyGeneration.current++;
      setRequest(null);
      setPreview(null);
      setCopyStatus(null);
    }
  }, [sessionId, request]);
  useEffect(() => {
    if (!disabled || !request) return;
    copyGeneration.current++;
    setRequest(null);
    setPreview(null);
    setCopyStatus(null);
  }, [disabled, request]);
  useEffect(() => {
    if (!request || !sessionId || request.sessionId !== sessionId) return;
    const controller = new AbortController();
    let handle: string | undefined;
    let parent = request.parent;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let identity: string | undefined;
    let delay = 2_000;
    closeButton.current?.focus();
    const update = async () => {
      if (document.visibilityState === "hidden") {
        timer = setTimeout(update, 2_000);
        return;
      }
      try {
        if (!handle)
          handle = (
            await client.resolveArtifact(
              sessionId,
              request.reference,
              parent,
              controller.signal,
            )
          ).handle;
        if (parent) {
          void client.releaseArtifact(sessionId, parent).catch(() => undefined);
          parent = undefined;
        }
        if (stopped) {
          void client.releaseArtifact(sessionId, handle).catch(() => undefined);
          return;
        }
        if (identity) {
          const metadata = await client.artifactMetadata(
            sessionId,
            handle,
            controller.signal,
          );
          if (metadata.identity === identity) {
            if (!stopped) setError(null);
            delay = Math.min(delay * 2, 30_000);
            return;
          }
        }
        const next = await client.artifactPreview(
          sessionId,
          handle,
          controller.signal,
        );
        if (!stopped) {
          identity = next.identity;
          delay = 2_000;
          setPreview(next);
          setError(null);
        }
      } catch (reason) {
        delay = Math.min(delay * 2, 30_000);
        if (!stopped)
          setError(
            reason instanceof Error ? reason.message : "Unable to read file",
          );
      } finally {
        // One outstanding read per open preview. No server watcher survives it.
        if (!stopped) timer = setTimeout(update, delay);
      }
    };
    void update();
    return () => {
      stopped = true;
      controller.abort();
      clearTimeout(timer);
      downloadAbort.current?.abort();
      setBusy(false);
      if (handle && handle !== nextParent.current)
        void client.releaseArtifact(sessionId, handle).catch(() => undefined);
      if (parent)
        void client.releaseArtifact(sessionId, parent).catch(() => undefined);
      for (const url of blobUrls.current) URL.revokeObjectURL(url);
      blobUrls.current.clear();
    };
  }, [client, request, sessionId]);
  const context = useMemo(() => ({ open }), [open]);
  const path = preview?.artifact.path ?? request?.reference ?? "";
  const name = preview?.artifact.name ?? path.split(/[\\/]/u).at(-1) ?? path;
  const download = async () => {
    if (!preview || busy) return;
    const controller = new AbortController();
    downloadAbort.current = controller;
    setBusy(true);
    try {
      const blob = await client.downloadArtifact(
        preview.artifact,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      const url = URL.createObjectURL(blob);
      blobUrls.current.add(url);
      const link = document.createElement("a");
      link.href = url;
      link.download = preview.artifact.name;
      link.click();
      setTimeout(() => {
        URL.revokeObjectURL(url);
        blobUrls.current.delete(url);
      }, 1_000);
    } catch (reason) {
      if (!controller.signal.aborted)
        setError(reason instanceof Error ? reason.message : "Download failed");
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  return (
    <ArtifactContext.Provider value={context}>
      {children}
      {request && (
        <aside
          className="artifact-panel"
          aria-label={t("filePreview")}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              close();
            }
          }}
        >
          <header>
            <div>
              <small>
                {t("filePreview")} · {t("artifactReadOnly")}
              </small>
              <h2 title={name}>{name}</h2>
            </div>
            <button
              ref={closeButton}
              type="button"
              aria-label={t("closePreview")}
              title={t("closePreview")}
              onClick={close}
            >
              <X aria-hidden="true" />
            </button>
          </header>
          <div className="artifact-panel-body">
            <div className="artifact-source">
              <code title={path}>{path}</code>
              <button
                type="button"
                aria-label={t("copyFilePath")}
                title={t("copyFilePath")}
                onClick={() => {
                  const generation = ++copyGeneration.current;
                  void copyText(path).then((success) => {
                    if (generation === copyGeneration.current)
                      setCopyStatus(success ? "copied" : "failed");
                  });
                }}
              >
                {copyStatus === "copied" ? (
                  <Check aria-hidden="true" />
                ) : (
                  <Clipboard aria-hidden="true" />
                )}
              </button>
            </div>
            {copyStatus && (
              <p role="status">
                {t(copyStatus === "copied" ? "filePathCopied" : "copyFailed")}
              </p>
            )}
            <p className="artifact-session">
              {t("artifactSession", { sessionId })}
            </p>
            <div className="artifact-actions">
              <button
                type="button"
                onClick={() => {
                  copyGeneration.current++;
                  setCopyStatus(null);
                  nextParent.current = undefined;
                  setRequest((value) =>
                    value
                      ? {
                          sessionId,
                          reference: preview?.artifact.path ?? value.reference,
                          ...(preview ? {} : { parent: value.parent }),
                        }
                      : null,
                  );
                }}
              >
                <RefreshCw aria-hidden="true" /> {t("refreshFile")}
              </button>
              <button
                type="button"
                disabled={!preview || busy}
                onClick={() => void download()}
              >
                <Download aria-hidden="true" />{" "}
                {busy ? t("downloadingFile") : t("downloadFile")}
              </button>
            </div>
            {error && (
              <p role="status" className="evidence-warning">
                {preview ? t("artifactOlderPreview") : ""}
                {error}
              </p>
            )}
            {!preview && !error && <p role="status">{t("readingFile")}</p>}
            {preview && (
              <>
                <p className="artifact-revision">
                  {t("artifactVersion")}:{" "}
                  <code>{preview.artifact.revision}</code> ·{" "}
                  {t("artifactBytes", { count: preview.artifact.bytes })}
                </p>
                {preview.truncated && (
                  <p className="evidence-warning">
                    {t("artifactPreviewTruncated")}
                  </p>
                )}
                {preview.text === undefined ? (
                  <p>{t("artifactUnsupported")}</p>
                ) : /\.(?:md|markdown)$/iu.test(preview.artifact.name) ? (
                  <ArtifactContext.Provider
                    value={{ open, parent: preview.artifact.handle }}
                  >
                    <Markdown>{preview.text}</Markdown>
                  </ArtifactContext.Provider>
                ) : (
                  <section aria-label="File preview content">
                    <pre>{preview.text}</pre>
                  </section>
                )}
              </>
            )}
          </div>
        </aside>
      )}
    </ArtifactContext.Provider>
  );
});
