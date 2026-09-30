import { Dialog } from "@astryxdesign/core/Dialog";
import { ArrowLeft, FileText, Image as ImageIcon, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  WebSessionSource,
  WebSessionSources,
} from "../../../../protocol/session-sources.ts";
import { WebClient } from "../../protocol/client.ts";

export function useSessionSources(
  sessionId: string,
  path: string,
  active: boolean,
  revision?: string,
) {
  const client = useMemo(() => new WebClient(), []);
  const [page, setPage] = useState<WebSessionSources | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!active) return;
    void revision;
    void retry;
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError(false);
    void client
      .sessionSources(sessionId, path, controller.signal)
      .then((next) => {
        if (
          !controller.signal.aborted &&
          next.sessionId === sessionId &&
          next.path === path
        )
          setPage(next);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false);
          request.current = null;
        }
      });
    return () => {
      controller.abort();
      request.current?.abort();
      request.current = null;
    };
  }, [client, sessionId, path, active, revision, retry]);
  const loadMore = async () => {
    if (request.current || !page || page.nextOffset === undefined) return;
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError(false);
    try {
      const next = await client.sessionSources(
        sessionId,
        path,
        controller.signal,
        page.nextOffset,
        page.revision,
      );
      if (
        !controller.signal.aborted &&
        next.sessionId === sessionId &&
        next.path === path &&
        next.revision === page.revision
      )
        setPage({ ...next, sources: [...page.sources, ...next.sources] });
    } catch {
      if (!controller.signal.aborted) setError(true);
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false);
        request.current = null;
      }
    }
  };
  return {
    page: page?.sessionId === sessionId && page.path === path ? page : null,
    loading,
    error,
    loadMore,
    refresh: () => setRetry((n) => n + 1),
  };
}

export function SourceImage({
  sessionId,
  path,
  source,
  thumbnail = false,
}: {
  sessionId: string;
  path: string;
  source: WebSessionSource;
  thumbnail?: boolean;
}) {
  const { t } = useTranslation();
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | undefined;
    setUrl(null);
    setFailed(false);
    void new WebClient()
      .sourceImage(
        sessionId,
        path,
        source.entryId,
        source.partIndex,
        controller.signal,
      )
      .then((image) => {
        if (controller.signal.aborted) return;
        if (
          !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(
            image.mimeType,
          ) ||
          image.data.length > 12 * 1024 * 1024
        )
          throw new Error("Invalid image");
        const bytes = Uint8Array.from(atob(image.data), (char) =>
          char.charCodeAt(0),
        );
        objectUrl = URL.createObjectURL(
          new Blob([bytes], { type: image.mimeType }),
        );
        setUrl(objectUrl);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [sessionId, path, source.entryId, source.partIndex]);
  return url && !failed ? (
    <img
      src={url}
      alt={thumbnail ? "" : source.name || t("attachedImage")}
      onError={() => setFailed(true)}
    />
  ) : thumbnail ? (
    <ImageIcon aria-hidden="true" />
  ) : (
    <p role={failed ? "alert" : "status"}>
      {t(failed ? "imagePreviewFailed" : "readingFile")}
    </p>
  );
}

export function SourceRow({
  source,
  sessionId,
  path,
  onOpen,
  thumbnail = true,
}: {
  source: WebSessionSource;
  sessionId: string;
  path: string;
  onOpen: () => void;
  thumbnail?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      className="session-overview-row session-source-row"
      title={source.reference || source.name || t("attachedImage")}
      onClick={onOpen}
    >
      <span className="session-source-icon">
        {source.kind === "image" ? (
          thumbnail ? (
            <SourceImage
              sessionId={sessionId}
              path={path}
              source={source}
              thumbnail
            />
          ) : (
            <ImageIcon aria-hidden="true" />
          )
        ) : (
          <FileText aria-hidden="true" />
        )}
      </span>
      <span>{source.name || t("attachedImage")}</span>
    </button>
  );
}

export function SourcesDialog({
  sessionId,
  path,
  open,
  source,
  data,
  onSelect,
  onClose,
}: {
  sessionId: string;
  path: string;
  open: boolean;
  source: WebSessionSource | null;
  data: ReturnType<typeof useSessionSources>;
  onSelect: (source: WebSessionSource | null) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [original, setOriginal] = useState(false);
  useEffect(() => {
    void source?.id;
    setOriginal(false);
  }, [source?.id]);
  return (
    <Dialog
      isOpen={open}
      onOpenChange={(next: boolean) => !next && onClose()}
      purpose="info"
      width={800}
      maxHeight="calc(100dvh - 32px)"
      padding={0}
      aria-label={t("sessionSources")}
    >
      <div className="session-sources-dialog draft-image-preview">
        <header>
          {source && (
            <button
              type="button"
              aria-label={t("sourcesBack")}
              onClick={() => onSelect(null)}
            >
              <ArrowLeft />
            </button>
          )}
          <strong title={source?.name}>
            {source ? source.name || t("attachedImage") : t("sessionSources")}
          </strong>
          {source && (
            <button
              type="button"
              aria-pressed={original}
              onClick={() => setOriginal((value) => !value)}
            >
              {t(original ? "fitImage" : "originalImageSize")}
            </button>
          )}
          <button
            type="button"
            data-autofocus
            aria-label={t("close")}
            onClick={onClose}
          >
            <X />
          </button>
        </header>
        {source ? (
          <section
            className="draft-image-preview-body"
            data-mode={original ? "original" : "fit"}
            aria-label={t("imageViewMode")}
            tabIndex={original ? 0 : undefined}
          >
            <SourceImage
              key={source.id}
              sessionId={sessionId}
              path={path}
              source={source}
            />
          </section>
        ) : (
          <div className="session-sources-list">
            {!data.loading && !data.error && !data.page?.sources.length && (
              <p>{t("sourcesEmpty")}</p>
            )}
            {data.page?.sources.map((item) => (
              <SourceRow
                key={item.id}
                source={item}
                sessionId={sessionId}
                path={path}
                onOpen={() => onSelect(item)}
                thumbnail={false}
              />
            ))}
            {data.error && (
              <p role="alert">
                {t("sourcesFailed")}{" "}
                <button type="button" onClick={data.refresh}>
                  {t("gitReviewRetry")}
                </button>
              </p>
            )}
            {data.loading && <p role="status">{t("readingFile")}</p>}
            {data.page?.nextOffset !== undefined && (
              <button
                className="sources-load-more"
                type="button"
                disabled={data.loading}
                onClick={() => void data.loadMore()}
              >
                {t("sourcesLoadMore")}
              </button>
            )}
            {data.page?.truncated && <p>{t("sourcesPartial")}</p>}
          </div>
        )}
      </div>
    </Dialog>
  );
}
