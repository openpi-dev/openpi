import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { ArtifactPreview } from "../../../../protocol/artifacts.ts";
import { WebClient } from "../../protocol/client.ts";
import { Markdown } from "../../components/Markdown.tsx";
import { ArtifactContext } from "./context.ts";

export function ArtifactProvider({
  sessionId,
  children,
}: {
  sessionId?: string;
  children?: ReactNode;
}) {
  const client = useMemo(() => new WebClient(), []);
  const [request, setRequest] = useState<{
    sessionId?: string;
    reference: string;
    parent?: string;
  } | null>(null);
  const [preview, setPreview] = useState<ArtifactPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const opener = useRef<HTMLElement | null>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const downloadAbort = useRef<AbortController | null>(null);
  const blobUrls = useRef(new Set<string>());
  const nextParent = useRef<string | undefined>(undefined);
  const open = useCallback(
    (reference: string, parent?: string) => {
      opener.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      setPreview(null);
      setError(null);
      nextParent.current = parent;
      setRequest({ reference, parent, sessionId });
    },
    [sessionId],
  );
  const close = useCallback(() => {
    setRequest(null);
    setPreview(null);
    opener.current?.focus();
  }, []);
  useEffect(() => {
    if (request && request.sessionId !== sessionId) {
      setRequest(null);
      setPreview(null);
    }
  }, [sessionId, request]);
  useEffect(() => {
    if (!request || !sessionId || request.sessionId !== sessionId) return;
    const controller = new AbortController();
    let handle: string | undefined;
    let parent = request.parent;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
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
        const next = await client.artifactPreview(
          sessionId,
          handle,
          controller.signal,
        );
        if (!stopped) {
          setPreview(next);
          setError(null);
        }
      } catch (reason) {
        if (!stopped)
          setError(
            reason instanceof Error ? reason.message : "Unable to read file",
          );
      } finally {
        // One outstanding read per open preview. No server watcher survives it.
        if (!stopped) timer = setTimeout(update, 2_000);
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
        <dialog
          open
          className="artifact-panel"
          aria-label="File preview"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              close();
            }
          }}
        >
          <header>
            <h2>File preview</h2>
            <button ref={closeButton} type="button" onClick={close}>
              Close preview
            </button>
          </header>
          <p className="artifact-source">
            {preview?.artifact.path ?? request.reference}
          </p>
          <p>Read-only access · Session {sessionId}</p>
          <div className="artifact-actions">
            <button
              type="button"
              onClick={() => {
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
              Refresh
            </button>
            <button
              type="button"
              disabled={!preview || busy}
              onClick={() => void download()}
            >
              {busy ? "Downloading…" : "Download"}
            </button>
          </div>
          {error && (
            <p role="status" className="evidence-warning">
              {preview ? "Showing an older preview. " : ""}
              {error}
            </p>
          )}
          {!preview && !error && <p role="status">Reading file…</p>}
          {preview && (
            <>
              <p className="artifact-revision">
                Version: <code>{preview.artifact.revision}</code> ·{" "}
                {preview.artifact.bytes} bytes
              </p>
              {preview.truncated && (
                <p className="evidence-warning">
                  Preview truncated. Download the file for the complete content.
                </p>
              )}
              {preview.text === undefined ? (
                <p>This file type cannot be previewed. Use Download.</p>
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
        </dialog>
      )}
    </ArtifactContext.Provider>
  );
}
