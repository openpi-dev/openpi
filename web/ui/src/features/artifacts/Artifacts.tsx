import { Tooltip } from "@astryxdesign/core/Tooltip";
import {
  Check,
  ChevronRight,
  Clipboard,
  Code2,
  Download,
  Eye,
  RotateCcw,
  RefreshCw,
  Save,
  X,
} from "lucide-react";
import {
  forwardRef,
  type ReactNode,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import type {
  ArtifactMetadata,
  ArtifactPreview,
} from "../../../../protocol/artifacts.ts";
import { copyText } from "../../lib/clipboard.ts";
import { WebApiError, WebClient } from "../../protocol/client.ts";
import { sniffPromptImageMime } from "../composer/image-attachments.ts";
import { FileContent, hasVisualFilePreview } from "../files/FileContent.tsx";
import { useFileEditor } from "../files/use-file-editor.ts";
import { ArtifactContext } from "./context.ts";
import { useWorkbarReadingState } from "../workbar/workbar-reading-state.ts";
import "../files/files.css";

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
  const [original, setOriginal] = useState(false);
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
    <div className="artifact-image-preview" data-original={original}>
      <div className="file-preview-toolbar">
        <button
          type="button"
          aria-pressed={!original}
          onClick={() => setOriginal(false)}
        >
          {t("filesFitImage")}
        </button>
        <button
          type="button"
          aria-pressed={original}
          onClick={() => setOriginal(true)}
        >
          {t("filesOriginalImage")}
        </button>
      </div>
      {!image?.loaded && <p role="status">{t("readingFile")}</p>}
      <div className="file-media-viewport">
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
    embedded?: boolean;
    active?: boolean;
    onOpen?: (nested: boolean) => void;
    onClose?: (reason: "user" | "context") => void;
  }
>(function ArtifactProvider(
  {
    sessionId,
    sessionPath,
    children,
    disabled = false,
    embedded = false,
    active = true,
    onOpen,
    onClose,
  },
  ref,
) {
  const { t } = useTranslation();
  const client = useMemo(() => new WebClient(), []);
  const reading = useWorkbarReadingState();
  const savedReading = embedded ? reading?.artifact : undefined;
  const [request, setRequest] = useState<{
    sessionId?: string;
    sessionPath?: string;
    reference: string;
    parent?: string;
    external?: boolean;
  } | null>(() =>
    savedReading
      ? {
          sessionId,
          sessionPath,
          reference: savedReading.reference,
        }
      : null,
  );
  const [preview, setPreview] = useState<ArtifactPreview | null>(null);
  const [source, setSource] = useState(savedReading?.source ?? false);
  const [editing, setEditing] = useState(savedReading?.editing ?? false);
  const [error, setError] = useState<string | null>(null);
  const [accessDenied, setAccessDenied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copyStatus, setCopyStatus] = useState<"copied" | "failed" | null>(
    null,
  );
  const [changed, setChanged] = useState(false);
  const [readingMore, setReadingMore] = useState(false);
  const moreAbort = useRef<AbortController | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const copyGeneration = useRef(0);
  const closeButton = useRef<HTMLButtonElement>(null);
  const editorInput = useRef<HTMLTextAreaElement>(null);
  const previewBody = useRef<HTMLDivElement>(null);
  const previewScroll = useRef(savedReading?.scroll ?? 0);
  const restoringScroll = useRef(Boolean(savedReading));
  useLayoutEffect(() => {
    if (!embedded || !reading) return;
    reading.artifact = request
      ? {
          reference: preview?.artifact.path
            ? encodeURI(preview.artifact.path)
            : request.reference,
          source,
          editing,
          scroll: previewScroll.current,
          document: reading.artifact?.document,
        }
      : undefined;
  }, [embedded, reading, request, preview?.artifact.path, source, editing]);
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
      setSource(false);
      setEditing(false);
      previewScroll.current = 0;
      restoringScroll.current = false;
      setError(null);
      setAccessDenied(false);
      setCopyStatus(null);
      setChanged(false);
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
      moreAbort.current?.abort();
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
  useLayoutEffect(() => {
    if (editing) editorInput.current?.focus({ preventScroll: true });
    else if (previewBody.current)
      previewBody.current.scrollTop = previewScroll.current;
  }, [editing]);
  useLayoutEffect(() => {
    if (!active || !preview || !restoringScroll.current || !previewBody.current)
      return;
    previewBody.current.scrollTop = previewScroll.current;
    restoringScroll.current = false;
  }, [active, preview]);
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
    if (!request || !sessionId || !requestInScope || !active) return;
    const controller = new AbortController();
    let handle: string | undefined;
    let parent = request.parent;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let identity: string | undefined;
    let readingText = false;
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
          if (readingText) {
            if (!stopped) setChanged(true);
            delay = 30_000;
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
          readingText = next.text !== undefined;
          delay = 2_000;
          setPreview((current) =>
            current?.artifact.path === next.artifact.path &&
            current.artifact.revision === next.artifact.revision
              ? {
                  ...next,
                  text: current.text,
                  truncated: current.truncated,
                  nextOffset: current.nextOffset,
                }
              : next,
          );
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
      moreAbort.current?.abort();
      setReadingMore(false);
      setBusy(false);
      if (handle && handle !== nextParent.current)
        void client.releaseArtifact(sessionId, handle).catch(() => undefined);
      if (parent)
        void client.releaseArtifact(sessionId, parent).catch(() => undefined);
      for (const url of blobUrls.current) URL.revokeObjectURL(url);
      blobUrls.current.clear();
    };
  }, [client, request, requestInScope, sessionId, active]);
  const context = useMemo(() => ({ open, disabled }), [open, disabled]);
  const path = preview?.artifact.path ?? request?.reference ?? "";
  const name = preview?.artifact.name ?? path.split(/[\\/]/u).at(-1) ?? path;
  const editor = useFileEditor(
    preview,
    sessionPath,
    client,
    (text, revision) => {
      setPreview((value) =>
        value
          ? {
              ...value,
              text,
              truncated: false,
              nextOffset: undefined,
              artifact: {
                ...value.artifact,
                revision,
                bytes: new TextEncoder().encode(text).length,
              },
            }
          : value,
      );
      setChanged(false);
      setRequest((value) => (value ? { ...value } : value));
    },
  );
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
  const readMore = async () => {
    if (!preview?.nextOffset || moreAbort.current) return;
    const current = preview;
    const controller = new AbortController();
    moreAbort.current = controller;
    setReadingMore(true);
    try {
      const next = await client.artifactPreview(
        current.artifact.sessionId,
        current.artifact.handle,
        controller.signal,
        { offset: current.nextOffset!, revision: current.artifact.revision },
      );
      if (!controller.signal.aborted)
        setPreview((value) =>
          value?.artifact.handle === current.artifact.handle &&
          value.artifact.revision === next.artifact.revision
            ? { ...next, text: (value.text ?? "") + (next.text ?? "") }
            : value,
        );
    } catch (reason) {
      if (!controller.signal.aborted)
        setError(
          reason instanceof Error ? reason.message : t("filesReadFailed"),
        );
    } finally {
      if (moreAbort.current === controller) {
        moreAbort.current = null;
        setReadingMore(false);
      }
    }
  };
  return (
    <ArtifactContext.Provider value={context}>
      {children}
      {request && requestInScope && (
        <aside
          className={`artifact-panel${embedded ? " artifact-panel-embedded" : ""}`}
          aria-label={t("filePreview")}
          onKeyDown={(event) => {
            if (
              embedded &&
              (event.metaKey || event.ctrlKey) &&
              event.key.toLowerCase() === "s"
            ) {
              event.preventDefault();
              event.stopPropagation();
              void editor.save();
              return;
            }
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
            <div className="artifact-title">
              <small title={path}>
                {embedded
                  ? path.split(/[\\/]/u).slice(0, -1).at(-1) || t("files")
                  : `${t("filePreview")} · ${t("artifactReadOnly")}`}
              </small>
              {embedded && <ChevronRight aria-hidden="true" />}
              <h2 title={path}>{name}</h2>
              {editor.dirty && (
                <span
                  className="file-unsaved"
                  role="img"
                  title={t("filesUnsaved")}
                  aria-label={t("filesUnsaved")}
                >
                  ●
                </span>
              )}
            </div>
            <div className="artifact-header-actions">
              {embedded && preview?.text !== undefined && (
                <>
                  <fieldset
                    className="file-mode-switch"
                    aria-label={t("filesMode")}
                  >
                    <button
                      type="button"
                      aria-pressed={!editing}
                      onClick={() => setEditing(false)}
                    >
                      {t("filesPreview")}
                    </button>
                    <button
                      type="button"
                      aria-pressed={editing}
                      disabled={!editor.canEdit}
                      title={t(
                        preview.truncated
                          ? "filesEditLoadFirst"
                          : !preview.artifact.editable
                            ? "filesEditUnavailable"
                            : "filesEdit",
                      )}
                      onClick={() => {
                        previewScroll.current =
                          previewBody.current?.scrollTop ?? 0;
                        setEditing(true);
                      }}
                    >
                      {t("filesEdit")}
                    </button>
                  </fieldset>
                  {(editing || editor.dirty || editor.saving) && (
                    <button
                      type="button"
                      className="file-save-button"
                      title={`${t("filesSave")} (Cmd/Ctrl+S)`}
                      disabled={
                        !editor.dirty || editor.saving || !editor.canEdit
                      }
                      onClick={() => void editor.save()}
                    >
                      <Save aria-hidden="true" />
                      {t(
                        editor.saving
                          ? "filesSaving"
                          : editor.dirty
                            ? "filesSave"
                            : "filesSaved",
                      )}
                    </button>
                  )}
                  {editor.dirty && (
                    <button
                      type="button"
                      title={t("filesDiscard")}
                      aria-label={t("filesDiscard")}
                      disabled={editor.saving}
                      onClick={() => {
                        if (window.confirm(t("filesDiscardConfirm")))
                          editor.discard();
                      }}
                    >
                      <RotateCcw aria-hidden="true" />
                    </button>
                  )}
                </>
              )}
              {!embedded &&
                preview?.text !== undefined &&
                hasVisualFilePreview(name) && (
                  <button
                    type="button"
                    className="file-source-toggle"
                    aria-pressed={source}
                    onClick={() => setSource((value) => !value)}
                  >
                    {source ? (
                      <Eye aria-hidden="true" />
                    ) : (
                      <Code2 aria-hidden="true" />
                    )}
                    {t(source ? "filesPreview" : "filesSource")}
                  </button>
                )}
              <Tooltip content={t("copyFilePath")} placement="below">
                <button
                  className="artifact-icon-button"
                  type="button"
                  aria-label={t("copyFilePath")}
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
              </Tooltip>
              <Tooltip content={t("refreshFile")} placement="below">
                <button
                  className="artifact-icon-button"
                  type="button"
                  aria-label={t("refreshFile")}
                  onClick={() => {
                    copyGeneration.current++;
                    setCopyStatus(null);
                    setError(null);
                    setAccessDenied(false);
                    setChanged(false);
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
              </Tooltip>
              <Tooltip content={t("downloadFile")} placement="below">
                <button
                  className="artifact-icon-button"
                  type="button"
                  aria-label={t(busy ? "downloadingFile" : "downloadFile")}
                  disabled={!preview || busy}
                  onClick={() => void download()}
                >
                  <Download aria-hidden="true" />{" "}
                  {busy ? t("downloadingFile") : t("downloadFile")}
                </button>
              </Tooltip>
              <Tooltip content={t("closePreview")} placement="below">
                <button
                  className="artifact-icon-button"
                  ref={closeButton}
                  type="button"
                  aria-label={t("closePreview")}
                  onClick={() => close()}
                >
                  <X aria-hidden="true" />
                </button>
              </Tooltip>
            </div>
          </header>
          <div
            className="artifact-panel-body"
            ref={previewBody}
            onScroll={(event) => {
              if (restoringScroll.current) return;
              previewScroll.current = event.currentTarget.scrollTop;
              if (embedded && reading?.artifact)
                reading.artifact.scroll = previewScroll.current;
            }}
          >
            {!embedded && (
              <div className="artifact-source">
                <code title={path}>{path}</code>
              </div>
            )}
            {copyStatus && (
              <p role="status">
                {t(copyStatus === "copied" ? "filePathCopied" : "copyFailed")}
              </p>
            )}
            {error && (
              <p role="status" className="evidence-warning">
                {preview ? t("artifactOlderPreview") : ""}
                {error}
              </p>
            )}
            {changed && (
              <p className="evidence-warning" role="status">
                {t("filesContentChanged")}
              </p>
            )}
            {editor.message && (
              <p
                role="status"
                className={
                  editor.message.error ? "evidence-warning" : "file-save-status"
                }
              >
                {editor.message.text}
              </p>
            )}
            {editor.conflict && (
              <div className="file-conflict">
                <p>{t("filesSaveConflict")}</p>
                <details>
                  <summary>{t("filesDiskVersion")}</summary>
                  <pre>{preview?.text}</pre>
                </details>
                <button
                  type="button"
                  disabled={!editor.canEdit || editor.saving}
                  onClick={editor.reconcile}
                >
                  {t("filesReconcile")}
                </button>
              </div>
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
                ) : (
                  <ArtifactContext.Provider
                    value={{
                      open,
                      disabled,
                      parent: preview.artifact.handle,
                      sessionId,
                    }}
                  >
                    {embedded && editor.canEdit && (
                      <textarea
                        ref={editorInput}
                        hidden={!editing}
                        className="file-editor"
                        aria-label={t("filesEditor")}
                        spellCheck={false}
                        autoCapitalize="off"
                        autoCorrect="off"
                        maxLength={1024 * 1024}
                        value={editor.text}
                        disabled={editor.saving}
                        onChange={(event) =>
                          editor.change(event.currentTarget.value)
                        }
                      />
                    )}
                    {!(embedded && editing && editor.canEdit) && (
                      <FileContent
                        key={`${preview.artifact.path}:${preview.artifact.revision}`}
                        preview={
                          editor.dirty
                            ? { ...preview, text: editor.text }
                            : preview
                        }
                        client={client}
                        source={source}
                      />
                    )}
                  </ArtifactContext.Provider>
                )}
                {preview.nextOffset !== undefined && (
                  <button
                    type="button"
                    className="file-read-more"
                    disabled={readingMore || changed}
                    onClick={() => void readMore()}
                  >
                    {t(readingMore ? "readingFile" : "filesReadMore")}
                  </button>
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
