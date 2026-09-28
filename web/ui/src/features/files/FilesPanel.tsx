import {
  ChevronDown,
  ChevronRight,
  File,
  FileCode2,
  FileImage,
  FileText,
  Folder,
  FolderOpen,
  Link,
  RefreshCw,
  Search,
  Sheet,
} from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import type {
  WorkspaceFileEntry,
  WorkspaceFileListing,
} from "../../../../protocol/artifacts.ts";
import { WebClient } from "../../protocol/client.ts";
import { ArtifactProvider } from "../artifacts/Artifacts.tsx";
import { ArtifactContext } from "../artifacts/context.ts";
import "./files.css";

export function FileIcon({
  name,
  kind = "file",
  expanded = false,
}: {
  name: string;
  kind?: WorkspaceFileEntry["kind"];
  expanded?: boolean;
}) {
  const category =
    kind === "directory"
      ? "folder"
      : kind === "symlink"
        ? "link"
        : /\.(?:md|markdown)$/iu.test(name)
          ? "markdown"
          : /\.(?:csv|tsv|xlsx?)$/iu.test(name)
            ? "sheet"
            : /\.(?:png|jpe?g|gif|webp|svg|bmp|ico)$/iu.test(name)
              ? "image"
              : /\.(?:pdf|docx?|pptx?)$/iu.test(name)
                ? "document"
                : /\.(?:[cm]?[jt]sx?|json|html?|css|py|rs|go|sh|ya?ml|toml|xml)$/iu.test(
                      name,
                    )
                  ? "code"
                  : "file";
  const Icon =
    category === "folder"
      ? expanded
        ? FolderOpen
        : Folder
      : category === "link"
        ? Link
        : category === "sheet"
          ? Sheet
          : category === "image"
            ? FileImage
            : category === "markdown" || category === "document"
              ? FileText
              : category === "code"
                ? FileCode2
                : File;
  return (
    <Icon className={`file-icon file-icon-${category}`} aria-hidden="true" />
  );
}

function FileTree({
  sessionId,
  sessionPath,
  active,
  selected,
  onSelect,
}: {
  sessionId: string;
  sessionPath: string;
  active: boolean;
  selected: string;
  onSelect: (path: string) => void;
}) {
  const { t } = useTranslation();
  const artifacts = useContext(ArtifactContext);
  const client = useMemo(() => new WebClient(), []);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<string[]>(["."]);
  const [listings, setListings] = useState<
    Record<string, WorkspaceFileListing>
  >({});
  const [results, setResults] = useState<WorkspaceFileListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const tree = useRef<HTMLDivElement>(null);
  const listingRef = useRef(listings);
  listingRef.current = listings;
  const resultRef = useRef(results);
  resultRef.current = results;
  const resultQuery = useRef("");
  const listRequest = useRef<AbortController | null>(null);
  const cursors = useRef(new Set<string>());
  const loadingMore = useRef(false);
  const [moreBusy, setMoreBusy] = useState(false);
  const searching = Boolean(query.trim());
  useEffect(() => {
    void refresh;
    if (!active) return;
    const controller = new AbortController();
    listRequest.current = controller;
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      if (document.visibilityState === "hidden") return;
      setLoading(true);
      try {
        const readPages = async (
          path: string,
          search: string,
          count: number,
        ) => {
          let response = await client.workspaceFiles(
            sessionId,
            sessionPath,
            path,
            search,
            controller.signal,
          );
          if (response.nextCursor) cursors.current.add(response.nextCursor);
          while (
            response.nextCursor &&
            response.entries.length < count &&
            !controller.signal.aborted
          ) {
            const cursor = response.nextCursor;
            const next = await client.workspaceFiles(
              sessionId,
              sessionPath,
              path,
              search,
              controller.signal,
              cursor,
            );
            cursors.current.delete(cursor);
            if (next.nextCursor) cursors.current.add(next.nextCursor);
            response = {
              ...next,
              entries: [...response.entries, ...next.entries],
            };
          }
          return response;
        };
        if (searching) {
          const response = await readPages(
            ".",
            query.trim(),
            resultRef.current?.entries.length ?? 0,
          );
          if (!controller.signal.aborted) setResults(response);
        } else {
          // Sequential directory reads stay below the shared host read bound.
          const next: Record<string, WorkspaceFileListing> = {};
          let directoryError: unknown;
          for (const path of expanded) {
            try {
              next[path] = await readPages(
                path,
                "",
                listingRef.current[path]?.entries.length ?? 0,
              );
            } catch (reason) {
              if (path === ".") throw reason;
              directoryError = reason;
              next[path] = { path, entries: [], truncated: false };
            }
            if (controller.signal.aborted) return;
          }
          if (!controller.signal.aborted) setListings(next);
          if (directoryError) throw directoryError;
        }
        if (!controller.signal.aborted) setError(null);
      } catch (reason) {
        if (!controller.signal.aborted)
          setError(
            reason instanceof Error ? reason.message : t("filesReadFailed"),
          );
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    if (resultQuery.current !== query.trim()) {
      resultQuery.current = query.trim();
      resultRef.current = null;
      setResults(null);
    }
    timer = setTimeout(read, searching ? 180 : 0);
    const focus = () => {
      if (document.visibilityState !== "hidden")
        setRefresh((value) => value + 1);
    };
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", focus);
    return () => {
      controller.abort();
      clearTimeout(timer);
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", focus);
      for (const cursor of cursors.current)
        void client.releaseFileListing(cursor).catch(() => undefined);
      cursors.current.clear();
      loadingMore.current = false;
      setMoreBusy(false);
    };
  }, [
    active,
    client,
    expanded,
    query,
    searching,
    sessionId,
    sessionPath,
    refresh,
    t,
  ]);

  const toggle = (path: string) =>
    setExpanded((current) =>
      current.includes(path)
        ? current.filter(
            (item) => item !== path && !item.startsWith(`${path}/`),
          )
        : [...current, path],
    );
  const more = async (path: string) => {
    const current = searching ? resultRef.current : listingRef.current[path];
    const controller = listRequest.current;
    if (
      !current?.nextCursor ||
      !controller ||
      controller.signal.aborted ||
      loadingMore.current ||
      loading
    )
      return;
    loadingMore.current = true;
    setMoreBusy(true);
    setError(null);
    try {
      const next = await client.workspaceFiles(
        sessionId,
        sessionPath,
        path,
        searching ? query.trim() : "",
        controller.signal,
        current.nextCursor,
      );
      cursors.current.delete(current.nextCursor);
      if (next.nextCursor) cursors.current.add(next.nextCursor);
      if (controller.signal.aborted) return;
      const entries = [
        ...new Map(
          [...current.entries, ...next.entries].map((entry) => [
            entry.path,
            entry,
          ]),
        ).values(),
      ];
      // Append in page order so newly discovered names never move rows the user is reading.
      const updated = { ...next, entries };
      if (searching) setResults(updated);
      else setListings((value) => ({ ...value, [path]: updated }));
    } catch (reason) {
      if (!controller.signal.aborted)
        setError(
          reason instanceof Error ? reason.message : t("filesReadFailed"),
        );
    } finally {
      if (!controller.signal.aborted) {
        loadingMore.current = false;
        setMoreBusy(false);
      }
    }
  };
  const moreButton = (path: string, listing?: WorkspaceFileListing | null) =>
    listing?.nextCursor ? (
      <li className="file-tree-more">
        <button
          type="button"
          disabled={loading || moreBusy}
          onClick={() => void more(path)}
        >
          {t(moreBusy ? "loading" : "filesLoadMore")}
        </button>
        <small>{t("filesLoaded", { count: listing.entries.length })}</small>
      </li>
    ) : null;
  const keydown = (event: KeyboardEvent<HTMLDivElement>) => {
    const buttons = [
      ...(tree.current?.querySelectorAll<HTMLButtonElement>(
        "button[data-file-row]:not(:disabled)",
      ) ?? []),
    ];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const row = buttons[index];
    if (!row) return;
    let next: HTMLButtonElement | undefined;
    if (event.key === "ArrowDown")
      next = buttons[Math.min(index + 1, buttons.length - 1)];
    else if (event.key === "ArrowUp") next = buttons[Math.max(index - 1, 0)];
    else if (event.key === "Home") next = buttons[0];
    else if (event.key === "End") next = buttons.at(-1);
    else if (
      event.key === "ArrowRight" &&
      row.getAttribute("aria-expanded") === "false"
    )
      row.click();
    else if (event.key === "ArrowLeft") {
      if (row.getAttribute("aria-expanded") === "true") row.click();
      else
        next = buttons.find(
          (button) =>
            button.dataset.fileRow ===
            row.dataset.fileRow?.split("/").slice(0, -1).join("/"),
        );
    } else return;
    event.preventDefault();
    next?.focus();
  };
  const rows = (items: WorkspaceFileEntry[], depth = 0): ReactNode =>
    items.map((entry) => {
      const directory = entry.kind === "directory";
      const open = expanded.includes(entry.path);
      return (
        <li key={entry.path}>
          <button
            type="button"
            data-file-row={entry.path}
            className="file-tree-row"
            style={{ paddingInlineStart: 10 + depth * 16 }}
            aria-expanded={directory ? open : undefined}
            aria-current={
              !directory && selected === entry.path ? "true" : undefined
            }
            disabled={entry.kind === "symlink" || entry.kind === "other"}
            title={entry.kind === "symlink" ? t("filesSymlink") : entry.path}
            onClick={(event) => {
              if (directory) {
                if (searching) {
                  setQuery("");
                  setExpanded([
                    ".",
                    ...entry.path
                      .split("/")
                      .map((_, index, parts) =>
                        parts.slice(0, index + 1).join("/"),
                      ),
                  ]);
                } else toggle(entry.path);
              } else {
                onSelect(entry.path);
                artifacts?.open(
                  encodeURI(entry.path),
                  undefined,
                  event.currentTarget,
                );
              }
            }}
          >
            {directory ? (
              open ? (
                <ChevronDown className="file-chevron" aria-hidden="true" />
              ) : (
                <ChevronRight className="file-chevron" aria-hidden="true" />
              )
            ) : (
              <span className="file-chevron" />
            )}
            <FileIcon name={entry.name} kind={entry.kind} expanded={open} />
            <span className="file-tree-name">
              {entry.name}
              {searching && <small>{entry.path}</small>}
            </span>
          </button>
          {!searching && directory && open && (
            <ul>
              {listings[entry.path] ? (
                rows(listings[entry.path].entries, depth + 1)
              ) : (
                <li className="file-tree-note">{t("loading")}</li>
              )}
              {moreButton(entry.path, listings[entry.path])}
            </ul>
          )}
        </li>
      );
    });
  return (
    <aside className="file-explorer" aria-label={t("filesExplorer")}>
      <div className="file-search">
        <Search aria-hidden="true" />
        <input
          value={query}
          onChange={(event) =>
            setQuery(event.currentTarget.value.slice(0, 200))
          }
          placeholder={t("filesSearch")}
          aria-label={t("filesSearch")}
        />
        <span
          className="file-search-progress"
          aria-hidden="true"
          data-loading={loading || undefined}
        />
        <button
          type="button"
          className="icon-button"
          aria-label={t("refreshFiles")}
          title={t("refreshFiles")}
          onClick={() => setRefresh((value) => value + 1)}
          disabled={loading}
        >
          <RefreshCw aria-hidden="true" />
        </button>
      </div>
      {error && (
        <p className="file-tree-note evidence-warning" role="alert">
          {error}
        </p>
      )}
      <section
        className="file-tree"
        aria-label={t("filesExplorer")}
        ref={tree}
        onKeyDown={keydown}
        aria-busy={loading}
      >
        <ul>
          {rows(
            searching
              ? (results?.entries ?? [])
              : (listings["."]?.entries ?? []),
          )}
          {moreButton(".", searching ? results : listings["."])}
        </ul>
        {(searching ? results?.truncated : listings["."]?.truncated) && (
          <p className="file-tree-note">{t("filesTruncated")}</p>
        )}
        {!loading &&
          !error &&
          (searching
            ? results?.entries.length === 0
            : listings["."]?.entries.length === 0) && (
            <p className="file-tree-note">
              {t(searching ? "filesNoMatches" : "filesEmpty")}
            </p>
          )}
      </section>
    </aside>
  );
}

export function FilesPanel({
  sessionId,
  sessionPath,
  cwd,
  active,
}: {
  sessionId: string;
  sessionPath: string;
  cwd: string;
  active: boolean;
}) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState("");
  const [treeVisible, setTreeVisible] = useState(true);
  return (
    <div
      className="files-workspace"
      data-tree-visible={treeVisible}
      data-preview-open={Boolean(selected)}
    >
      <ArtifactProvider
        sessionId={sessionId}
        sessionPath={sessionPath}
        embedded
        active={active}
        onClose={() => {
          setSelected("");
          setTreeVisible(true);
        }}
      >
        <button
          type="button"
          className="files-tree-toggle icon-button"
          aria-label={t(treeVisible ? "filesHideTree" : "filesShowTree")}
          title={t(treeVisible ? "filesHideTree" : "filesShowTree")}
          aria-pressed={treeVisible}
          onClick={() => setTreeVisible((value) => !value)}
        >
          {treeVisible ? (
            <FolderOpen aria-hidden="true" />
          ) : (
            <Folder aria-hidden="true" />
          )}
        </button>
        {!selected && (
          <div className="files-empty-header" title={cwd}>
            <FolderOpen aria-hidden="true" />
            {cwd.split(/[\\/]/u).filter(Boolean).at(-1) || cwd}
          </div>
        )}
        {!selected && (
          <div className="files-preview-empty">
            <FileText aria-hidden="true" />
            <h3>{t("filesChoose")}</h3>
            <p>{t("filesChooseDetail")}</p>
          </div>
        )}
        <div className="files-tree-container" hidden={!treeVisible}>
          <FileTree
            sessionId={sessionId}
            sessionPath={sessionPath}
            active={active && treeVisible}
            selected={selected}
            onSelect={setSelected}
          />
        </div>
      </ArtifactProvider>
    </div>
  );
}
