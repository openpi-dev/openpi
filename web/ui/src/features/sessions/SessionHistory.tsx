import { Dialog } from "@astryxdesign/core/Dialog";
import { ArchiveRestore, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  WebArchivedSessionSummary,
  WebTerminalSessionDetail,
  WebTerminalSessionSummary,
} from "../../../../protocol/types.ts";
import { relativeTime, sessionTitle } from "../../lib/format.ts";
import { WebClient } from "../../protocol/client.ts";
import type { WebStoreActions } from "../../store/web-store.ts";

type HistoryKind = "archived" | "terminal";
type HistoryItem = WebArchivedSessionSummary | WebTerminalSessionSummary;

function messageText(message: { role: string; content?: unknown }) {
  const content = message.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .filter(
              (part): part is { type: "text"; text: string } =>
                part !== null &&
                typeof part === "object" &&
                part.type === "text" &&
                typeof part.text === "string",
            )
            .map((part) => part.text)
            .join("\n")
        : "";
  return { text: text.slice(0, 12_000), truncated: text.length > 12_000 };
}

export function SessionHistory({
  kind,
  query,
  workspace,
  actions,
}: {
  kind: HistoryKind;
  query: string;
  workspace: string | null;
  actions: WebStoreActions;
}) {
  const { t } = useTranslation();
  const client = useMemo(() => new WebClient(), []);
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [cursor, setCursor] = useState<string | number | undefined>();
  const [partial, setPartial] = useState(false);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [moreLoading, setMoreLoading] = useState(false);
  const [revision, refresh] = useState(0);
  const request = useRef<AbortController | null>(null);
  const [detailPath, setDetailPath] = useState<string | null>(null);
  const [detail, setDetail] = useState<WebTerminalSessionDetail | null>(null);
  const [detailStatus, setDetailStatus] = useState<"loading" | "error">(
    "loading",
  );
  const [restorePath, setRestorePath] = useState<string | null>(null);
  const restoreInFlight = useRef(false);
  const [restoreFailed, setRestoreFailed] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Revision explicitly retries the current history query.
  useEffect(() => {
    const controller = new AbortController();
    request.current = controller;
    setItems([]);
    setCursor(undefined);
    setPartial(false);
    setStatus("loading");
    setMoreLoading(false);
    setDetailPath(null);
    setDetail(null);
    setRestoreFailed(false);
    if (kind === "terminal" && !workspace) {
      setStatus("ready");
      return () => controller.abort();
    }
    const read =
      kind === "archived"
        ? client
            .archivedSessions(query, undefined, controller.signal)
            .then((page) => ({
              sessions: page.sessions,
              nextCursor: page.nextCursor,
              partial: page.truncation.recordsUnscanned > 0,
            }))
        : client.terminalSessions(query, 0, controller.signal).then((page) => ({
            sessions: page.sessions,
            nextCursor: page.nextCursor,
            partial: page.partial,
          }));
    void read.then(
      (page) => {
        if (controller.signal.aborted) return;
        setItems(page.sessions);
        setCursor(page.nextCursor);
        setPartial(page.partial);
        setStatus("ready");
      },
      () => {
        if (!controller.signal.aborted) setStatus("error");
      },
    );
    return () => controller.abort();
  }, [client, kind, query, workspace, revision]);

  useEffect(() => {
    if (!detailPath || kind !== "terminal" || !workspace) return;
    const controller = new AbortController();
    setDetail(null);
    setDetailStatus("loading");
    void client.terminalSession(detailPath, controller.signal).then(
      (result) => {
        if (controller.signal.aborted) return;
        if (
          result.path !== detailPath ||
          result.cwd !== workspace ||
          !result.readOnly
        ) {
          setDetailStatus("error");
          return;
        }
        setDetail(result);
      },
      () => {
        if (!controller.signal.aborted) setDetailStatus("error");
      },
    );
    return () => controller.abort();
  }, [client, detailPath, kind, workspace]);

  const loadMore = async () => {
    if (cursor === undefined || moreLoading || request.current?.signal.aborted)
      return;
    const controller = request.current;
    if (!controller) return;
    setMoreLoading(true);
    try {
      const page =
        kind === "archived"
          ? await client
              .archivedSessions(query, String(cursor), controller.signal)
              .then((result) => ({
                sessions: result.sessions,
                nextCursor: result.nextCursor,
                partial: result.truncation.recordsUnscanned > 0,
              }))
          : await client
              .terminalSessions(query, Number(cursor), controller.signal)
              .then((result) => ({
                sessions: result.sessions,
                nextCursor: result.nextCursor,
                partial: result.partial,
              }));
      if (controller.signal.aborted) return;
      setItems((current) => [
        ...current,
        ...page.sessions.filter(
          (item) => !current.some((prior) => prior.path === item.path),
        ),
      ]);
      setCursor(page.nextCursor);
      setPartial(page.partial);
      setStatus("ready");
    } catch {
      if (!controller.signal.aborted) setStatus("error");
    } finally {
      if (!controller.signal.aborted) setMoreLoading(false);
    }
  };

  const restore = async (path: string) => {
    if (restoreInFlight.current) return;
    restoreInFlight.current = true;
    setRestorePath(path);
    setRestoreFailed(false);
    try {
      if (await actions.unarchiveSession(path)) {
        setItems((current) => current.filter((item) => item.path !== path));
      } else setRestoreFailed(true);
    } catch {
      setRestoreFailed(true);
    } finally {
      restoreInFlight.current = false;
      setRestorePath(null);
    }
  };

  return (
    <>
      <section
        className="workspace-tree session-history"
        aria-label={t(
          kind === "archived" ? "archivedConversations" : "terminalHistory",
        )}
      >
        {kind === "terminal" && !workspace && (
          <p className="sidebar-scope-note">{t("terminalChooseWorkspace")}</p>
        )}
        {status === "loading" && (
          <p className="sidebar-scope-note" role="status">
            {t("historyLoading")}
          </p>
        )}
        {status === "error" && (
          <p className="sidebar-scope-note" role="alert">
            {t("historyLoadFailed")}{" "}
            <button type="button" onClick={() => refresh((value) => value + 1)}>
              {t("historyRetry")}
            </button>
          </p>
        )}
        {restoreFailed && (
          <p className="sidebar-scope-note" role="alert">
            {t("restoreFailed")}
          </p>
        )}
        {items.map((item) => (
          <div className="session-history-row" key={item.path}>
            <button
              type="button"
              className="session-history-select"
              onClick={() =>
                kind === "archived"
                  ? void actions.selectSession(item.path)
                  : setDetailPath(item.path)
              }
            >
              <strong>{sessionTitle(item, t("untitledSession"))}</strong>
              <small>
                {item.cwd} · {relativeTime(item.modified)} ·{" "}
                {kind === "terminal"
                  ? t("terminalSource")
                  : t("archivedConversations")}
              </small>
            </button>
            {kind === "archived" && (
              <button
                type="button"
                className="session-history-restore"
                disabled={restorePath === item.path}
                aria-label={`${t("restoreConversation")} ${sessionTitle(item, t("untitledSession"))}`}
                onClick={() => void restore(item.path)}
              >
                <ArchiveRestore />
              </button>
            )}
          </div>
        ))}
        {status === "ready" &&
          items.length === 0 &&
          (kind !== "terminal" || workspace) && (
            <p className="sidebar-scope-note">
              {query
                ? t("noMatching")
                : t(
                    kind === "archived"
                      ? "noLoadedArchives"
                      : "terminalHistoryEmpty",
                  )}
            </p>
          )}
        {partial && <p className="sidebar-scope-note">{t("historyPartial")}</p>}
        {cursor !== undefined && (
          <button
            type="button"
            className="history-more"
            disabled={moreLoading}
            onClick={() => void loadMore()}
          >
            {moreLoading ? t("historyLoading") : t("historyMore")}
          </button>
        )}
        {status === "ready" && cursor === undefined && items.length > 0 && (
          <p className="sidebar-scope-note">{t("historyEnd")}</p>
        )}
      </section>
      <Dialog
        isOpen={Boolean(detailPath)}
        onOpenChange={(open: boolean) => !open && setDetailPath(null)}
        width={720}
        aria-label={t("terminalHistoryDetail")}
      >
        <section className="terminal-history-detail">
          <header>
            <div>
              <h2>{detail?.name || t("terminalHistoryDetail")}</h2>
              <p>
                {t("terminalSource")} · {detail?.cwd ?? workspace}
              </p>
            </div>
            <button
              type="button"
              aria-label={t("close")}
              onClick={() => setDetailPath(null)}
            >
              <X />
            </button>
          </header>
          {detailStatus === "loading" && !detail && (
            <p role="status">{t("historyLoading")}</p>
          )}
          {detailStatus === "error" && (
            <p role="alert">{t("historyLoadFailed")}</p>
          )}
          {detail && (
            <>
              <p className="history-boundary">{t("terminalTextOnly")}</p>
              {(detail.metadataPartial ||
                detail.preview.truncatedBytes > 0 ||
                detail.preview.messages.length <
                  detail.preview.totalMessages) && (
                <p className="history-boundary">
                  {t("terminalHistoryPartial", {
                    shown: detail.preview.messages.length,
                    total: detail.preview.totalMessages,
                  })}
                </p>
              )}
              {detail.preview.messages.map((message, index) => {
                const content = messageText(message);
                return (
                  <section
                    className="terminal-history-message"
                    // biome-ignore lint/suspicious/noArrayIndexKey: The immutable read-only preview has no message ID and is replaced as a whole.
                    key={`${index}:${message.role}`}
                  >
                    <strong>{message.role}</strong>
                    <pre>{content.text || t("terminalNonText")}</pre>
                    {content.truncated && <small>{t("historyPartial")}</small>}
                  </section>
                );
              })}
            </>
          )}
        </section>
      </Dialog>
    </>
  );
}
