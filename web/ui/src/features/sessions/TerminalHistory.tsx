import "./terminal-history.css";
import { Dialog } from "@astryxdesign/core/Dialog";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  WebTerminalSessionDetail,
  WebTerminalSessionPage,
} from "../../../../protocol/types.ts";
import { WebClient } from "../../protocol/client.ts";

function textContent(content: unknown) {
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .filter(
              (part) => part?.type === "text" && typeof part.text === "string",
            )
            .map((part) => part.text)
            .join("\n")
        : "";
  return { text: text.slice(0, 12000), truncated: text.length > 12000 };
}

export function TerminalHistory({
  open,
  workspace,
  onClose,
}: {
  open: boolean;
  workspace: string | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const client = useMemo(() => new WebClient(), []);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState<WebTerminalSessionPage>();
  const [detailPath, setDetailPath] = useState<string>();
  const [detail, setDetail] = useState<WebTerminalSessionDetail>();
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const request = useRef<AbortController | undefined>(undefined);
  const scope = JSON.stringify([open, workspace, query, revision]);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const [pageScope, setPageScope] = useState("");
  const scopedPage = pageScope === scope ? page : undefined;
  useEffect(() => {
    request.current?.abort();
    setPage(undefined);
    setDetailPath(undefined);
    setDetail(undefined);
    setError(false);
    if (!open || !workspace) return;
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    void client
      .terminalSessions(workspace, query, 0, controller.signal)
      .then((value) => {
        if (controller.signal.aborted || currentScope.current !== scope) return;
        if (
          value.sessions.some(
            (row) =>
              row.cwd !== workspace ||
              row.origin !== "terminal" ||
              row.source !== "pi-default" ||
              row.readOnly !== true,
          )
        )
          throw new Error("History scope mismatch");
        setPage(value);
        setPageScope(scope);
      })
      .catch(() => {
        if (!controller.signal.aborted && currentScope.current === scope)
          setError(true);
      })
      .finally(() => {
        if (!controller.signal.aborted && currentScope.current === scope)
          setLoading(false);
      });
    return () => controller.abort();
  }, [client, open, query, scope, workspace]);
  useEffect(() => {
    setDetail(undefined);
    if (!open || !workspace || !detailPath) return;
    const controller = new AbortController();
    void client
      .terminalSession(workspace, detailPath, controller.signal)
      .then((value) => {
        if (controller.signal.aborted || currentScope.current !== scope) return;
        if (
          value.path !== detailPath ||
          value.cwd !== workspace ||
          value.origin !== "terminal" ||
          value.source !== "pi-default" ||
          value.readOnly !== true
        )
          throw new Error("History scope mismatch");
        setDetail(value);
      })
      .catch(() => {
        if (!controller.signal.aborted && currentScope.current === scope)
          setError(true);
      });
    return () => controller.abort();
  }, [client, detailPath, open, scope, workspace]);
  const more = async () => {
    if (
      !workspace ||
      !scopedPage ||
      scopedPage.nextCursor === undefined ||
      loading
    )
      return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError(false);
    try {
      const value = await client.terminalSessions(
        workspace,
        query,
        scopedPage.nextCursor,
        controller.signal,
      );
      if (controller.signal.aborted || currentScope.current !== scope) return;
      if (
        value.sessions.some(
          (row) =>
            row.cwd !== workspace ||
            row.origin !== "terminal" ||
            row.source !== "pi-default" ||
            row.readOnly !== true,
        )
      )
        throw new Error("History scope mismatch");
      setPage({
        ...value,
        sessions: [...scopedPage.sessions, ...value.sessions],
        partial: scopedPage.partial || value.partial,
      });
    } catch {
      if (!controller.signal.aborted && currentScope.current === scope)
        setError(true);
    } finally {
      if (!controller.signal.aborted && currentScope.current === scope)
        setLoading(false);
    }
  };
  const occurrences = new Map<string, number>();
  const previewMessages = detail?.preview.messages.map((message) => {
    const content = textContent(message.content);
    const text = `${message.role}: ${content.text}`;
    const occurrence = occurrences.get(text) ?? 0;
    occurrences.set(text, occurrence + 1);
    return {
      text,
      truncated: content.truncated,
      key: `${detail.path}:${text}:${occurrence}`,
    };
  });
  return (
    <Dialog
      isOpen={open}
      onOpenChange={(next: boolean) => !next && onClose()}
      aria-label={t("terminalHistory")}
      width={680}
      className="terminal-history-dialog"
    >
      <div className="openpi-dialog terminal-history">
        <h2>{t("terminalHistory")}</h2>
        <p>{t("terminalHistoryReadOnly")}</p>
        <input
          aria-label={t("terminalHistorySearch")}
          value={query}
          maxLength={200}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button type="button" onClick={onClose}>
          {t("close")}
        </button>
        {error && (
          <p role="alert">
            {t("terminalHistoryError")}{" "}
            <button
              type="button"
              onClick={() => setRevision((value) => value + 1)}
            >
              {t("retry")}
            </button>
          </p>
        )}
        {loading && <p role="status">{t("loading")}</p>}
        {scopedPage?.partial && (
          <p role="status">{t("terminalHistoryPartial")}</p>
        )}
        <div className="terminal-history-list">
          {scopedPage?.sessions.map((row) => (
            <button
              type="button"
              key={row.path}
              onClick={() => {
                setError(false);
                setDetailPath(row.path);
              }}
            >
              {row.name || row.firstMessage || row.id} ·{" "}
              {t("terminalHistoryOrigin")}
              {row.metadataPartial ? ` · ${t("terminalHistoryPartial")}` : ""}
            </button>
          ))}
        </div>
        {scopedPage?.sessions.length === 0 && (
          <p>{t("terminalHistoryEmpty")}</p>
        )}
        {scopedPage?.nextCursor !== undefined && (
          <button type="button" disabled={loading} onClick={() => void more()}>
            {t("terminalHistoryMore")}
          </button>
        )}
        {detail &&
          detail.cwd === workspace &&
          detail.path === detailPath &&
          pageScope === scope && (
            <section aria-label={t("terminalHistoryPreview")}>
              <h3>{detail.name || detail.id}</h3>
              <p>{t("terminalHistoryReadOnly")}</p>
              {detail.preview.truncatedBytes > 0 && (
                <p>{t("terminalHistoryPartial")}</p>
              )}
              {previewMessages?.map((message) => (
                <pre key={message.key}>
                  {message.text}
                  {message.truncated ? `\n${t("terminalHistoryPartial")}` : ""}
                </pre>
              ))}
            </section>
          )}
      </div>
    </Dialog>
  );
}
