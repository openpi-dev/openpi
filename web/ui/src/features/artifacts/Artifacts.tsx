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
import type {
  ArtifactMetadata,
  ArtifactPreview,
} from "../../../../protocol/artifacts.ts";
import { Markdown } from "../../components/Markdown.tsx";
import { copyText } from "../../lib/clipboard.ts";
import { WebApiError, WebClient } from "../../protocol/client.ts";
import { sniffPromptImageMime } from "../composer/image-attachments.ts";
import { ArtifactContext } from "./context.ts";

export interface ArtifactProviderHandle {
  close: (options?: { restoreFocus?: boolean }) => void;
}

function ArtifactImagePreview({
  artifact,
  client,
}: {
  artifact: ArtifactMetadata;
  client: WebClient;
}) {
  const { t } = useTranslation();
  const [image, setImage] = useState<{ url: string; loaded: boolean } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const { sessionId, handle, revision } = artifact;
  useEffect(() => {
    const controller = new AbortController();
    let url: string | undefined;
    setImage(null);
    setError(null);
    void client
      .downloadArtifact({ sessionId, handle, revision }, controller.signal)
      .then(async (blob) => {
        const mime = sniffPromptImageMime(
          new Uint8Array(await blob.slice(0, 12).arrayBuffer()),
        );
        if (controller.signal.aborted) return;
        if (!mime) throw new Error(t("artifactImagePreviewFailed"));
        url = URL.createObjectURL(new Blob([blob], { type: mime }));
        setImage({ url, loaded: false });
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted)
          setError(
            reason instanceof Error
              ? reason.message
              : t("artifactImagePreviewFailed"),
          );
      });
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [sessionId, handle, revision, client, t]);

  if (error)
    return (
      <div role="alert" className="evidence-warning">
        <p>{t("artifactImagePreviewFailed")}</p>
        {error !== t("artifactImagePreviewFailed") && <small>{error}</small>}
      </div>
    );
  return (
    <div className="artifact-image-preview">
      {!image?.loaded && <p role="status">{t("readingFile")}</p>}
      {image && (
        <img
          src={image.url}
          alt={artifact.name}
          hidden={!image.loaded}
          onLoad={() =>
            setImage((current) =>
              current ? { ...current, loaded: true } : null,
            )
          }
          onError={() => setError(t("artifactImagePreviewFailed"))}
        />
      )}
    </div>
  );
}

export const ArtifactProvider = forwardRef<
  ArtifactProviderHandle,
  {
    sessionId?: string;
    sessionPath?: string;
    children?: ReactNode;
    disabled?: boolean;
    onOpen?: (nested: boolean) => void;
    onClose?: (reason: "user" | "context") => void;
  }
>(function ArtifactProvider(
  { sessionId, sessionPath, children, disabled = false, onOpen, onClose },
  ref,
) {
  const { t } = useTranslation();
  const client = useMemo(() => new WebClient(), []);
  const [request, setRequest] = useState<{
    sessionId?: string;
    sessionPath?: string;
    reference: string;
    parent?: string;
    external?: boolean;
  } | null>(null);
  const [preview, setPreview] = useState<ArtifactPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [accessDenied, setAccessDenied] = useState(false);
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
  const focusClose = useRef(false);
  const focusReturnFrame = useRef<number | null>(null);
  const scope = JSON.stringify([sessionId, sessionPath, disabled]);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const requestInScope = Boolean(
    request &&
      !disabled &&
      request.sessionId === sessionId &&
      request.sessionPath === sessionPath,
  );
  useEffect(() => {
    void scope;
    return () => {
      if (focusReturnFrame.current !== null) {
        window.cancelAnimationFrame(focusReturnFrame.current);
        focusReturnFrame.current = null;
      }
    };
  }, [scope]);
  const open = useCallback(
    (reference: string, parent?: string, source?: HTMLElement) => {
      if (disabled) return;
      const active = document.activeElement;
      const trigger = source ?? (active instanceof HTMLElement ? active : null);
      const nested = Boolean(parent || trigger?.closest(".artifact-panel"));
      if (!nested) opener.current = trigger;
      onOpen?.(nested);
      if (focusReturnFrame.current !== null) {
        window.cancelAnimationFrame(focusReturnFrame.current);
        focusReturnFrame.current = null;
      }
      focusClose.current = true;
      copyGeneration.current++;
      setPreview(null);
      setError(null);
      setAccessDenied(false);
      setCopyStatus(null);
      nextParent.current = parent;
      setRequest({ reference, parent, sessionId, sessionPath });
    },
    [disabled, onOpen, sessionId, sessionPath],
  );
  const close = useCallback(
    ({ restoreFocus = true }: { restoreFocus?: boolean } = {}) => {
      if (!request) return;
      const generation = ++copyGeneration.current;
      const trigger = opener.current;
      const focusedAtClose = document.activeElement;
      const reason = requestInScope ? "user" : "context";
      opener.current = null;
      focusClose.current = false;
      nextParent.current = undefined;
      setRequest(null);
      setPreview(null);
      setCopyStatus(null);
      onClose?.(reason);
      if (focusReturnFrame.current !== null)
        window.cancelAnimationFrame(focusReturnFrame.current);
      if (reason === "context" || !restoreFocus) {
        focusReturnFrame.current = null;
        return;
      }
      focusReturnFrame.current = window.requestAnimationFrame(() => {
        focusReturnFrame.current = null;
        if (
          generation === copyGeneration.current &&
          currentScope.current === scope &&
          (document.activeElement === document.body ||
            document.activeElement === focusedAtClose ||
            document.activeElement === trigger) &&
          trigger?.isConnected &&
          trigger.checkVisibility({ visibilityProperty: true })
        )
          trigger.focus();
      });
    },
    [onClose, request, requestInScope, scope],
  );
  useImperativeHandle(ref, () => ({ close }), [close]);
  useEffect(() => {
    if (!request || requestInScope) return;
    copyGeneration.current++;
    setRequest(null);
    setPreview(null);
    setCopyStatus(null);
    focusClose.current = false;
    opener.current = null;
    nextParent.current = undefined;
    onClose?.("context");
  }, [request, requestInScope, onClose]);
  useEffect(() => {
    if (!request || !sessionId || !requestInScope) return;
    const controller = new AbortController();
    let handle: string | undefined;
    let parent = request.parent;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let identity: string | undefined;
    let delay = 2_000;
    if (focusClose.current) {
      focusClose.current = false;
      closeButton.current?.focus();
    }
    const update = async () => {
      if (document.visibilityState === "hidden") {
        timer = setTimeout(update, 2_000);
        return;
      }
      try {
        if (!handle)
          handle = (
            await (request.external
              ? client.authorizeArtifact(
                  sessionId,
                  request.reference,
                  controller.signal,
                )
              : client.resolveArtifact(
                  sessionId,
                  request.reference,
                  parent,
                  controller.signal,
                ))
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
        const revoked =
          reason instanceof WebApiError &&
          [401, 403, 410].includes(reason.status);
        if (!stopped && revoked) {
          setPreview(null);
          downloadAbort.current?.abort();
        }
        if (!stopped)
          setAccessDenied(
            reason instanceof WebApiError && reason.code === "ARTIFACT_DENIED",
          );
        delay = Math.min(delay * 2, 30_000);
        if (!stopped)
          setError(
            reason instanceof Error ? reason.message : "Unable to read file",
          );
        if (revoked) stopped = true;
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
  }, [client, request, requestInScope, sessionId]);
  const context = useMemo(() => ({ open, disabled }), [open, disabled]);
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
      {request && requestInScope && (
        <aside
          className="artifact-panel"
          aria-label={t("filePreview")}
          onKeyDown={(event) => {
            if (
              event.key === "Escape" &&
              !event.nativeEvent.isComposing &&
              !event.defaultPrevented
            ) {
              event.preventDefault();
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
              onClick={() => close()}
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
            <div className="artifact-actions">
              <button
                type="button"
                onClick={() => {
                  copyGeneration.current++;
                  setCopyStatus(null);
                  setError(null);
                  setAccessDenied(false);
                  nextParent.current = undefined;
                  setRequest((value) =>
                    value
                      ? {
                          sessionId,
                          sessionPath,
                          reference: preview
                            ? encodeURI(preview.artifact.path)
                            : value.reference,
                          ...(value.external ? { external: true } : {}),
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
            {accessDenied &&
              !request.external &&
              /^(?:\/(?!\/)|[a-z]:[\\/])/iu.test(request.reference) && (
                <div className="artifact-external-access">
                  <p>{t("artifactExternalAccess")}</p>
                  <button
                    type="button"
                    onClick={() => {
                      focusClose.current = true;
                      setError(null);
                      setAccessDenied(false);
                      setRequest({
                        ...request,
                        parent: undefined,
                        external: true,
                      });
                    }}
                  >
                    {t("artifactAuthorizeFile")}
                  </button>
                </div>
              )}
            {!preview && !error && <p role="status">{t("readingFile")}</p>}
            {preview && (
              <>
                {preview.truncated && (
                  <p className="evidence-warning">
                    {t("artifactPreviewTruncated")}
                  </p>
                )}
                {/\.(?:png|jpe?g|gif|webp)$/iu.test(preview.artifact.name) ? (
                  <ArtifactImagePreview
                    key={JSON.stringify([
                      preview.artifact.sessionId,
                      preview.artifact.path,
                      preview.artifact.handle,
                      preview.artifact.revision,
                    ])}
                    artifact={preview.artifact}
                    client={client}
                  />
                ) : preview.text === undefined ? (
                  <p>{t("artifactUnsupported")}</p>
                ) : /\.(?:md|markdown)$/iu.test(preview.artifact.name) ? (
                  <ArtifactContext.Provider
                    value={{ open, disabled, parent: preview.artifact.handle }}
                  >
                    <Markdown>{preview.text}</Markdown>
                  </ArtifactContext.Provider>
                ) : (
                  <section
                    aria-label="File preview content"
                    // biome-ignore lint/a11y/noNoninteractiveTabindex: Long files need a keyboard-focusable scroll region.
                    tabIndex={0}
                  >
                    <pre>{preview.text}</pre>
                  </section>
                )}
                <details className="artifact-file-details">
                  <summary>{t("artifactFileDetails")}</summary>
                  <p className="artifact-session">
                    {t("artifactSession", { sessionId })}
                  </p>
                  <p className="artifact-revision">
                    {t("artifactVersion")}:{" "}
                    <code>{preview.artifact.revision}</code> ·{" "}
                    {t("artifactBytes", { count: preview.artifact.bytes })}
                  </p>
                </details>
              </>
            )}
          </div>
        </aside>
      )}
    </ArtifactContext.Provider>
  );
});
