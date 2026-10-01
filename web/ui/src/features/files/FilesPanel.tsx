import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import {
  ChevronDown,
  ChevronRight,
  File,
  FileCode2,
  FileImage,
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Link,
  MoreHorizontal,
  RefreshCw,
  Search,
  Sheet,
  Upload,
} from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import type {
  WorkspaceFileEntry,
  WorkspaceFileListing,
  WorkspaceFileMutationResult,
} from "../../../../protocol/artifacts.ts";
import { ARTIFACT_MAX_BYTES } from "../../../../protocol/artifacts.ts";
import { WEB_PROMPT_FILE_MAX_BYTES } from "../../../../protocol/prompt-files.ts";
import { copyText } from "../../lib/clipboard.ts";
import { WebApiError, WebClient } from "../../protocol/client.ts";
import { ArtifactProvider } from "../artifacts/Artifacts.tsx";
import { ArtifactContext } from "../artifacts/context.ts";
import { useWorkbarReadingState } from "../workbar/workbar-reading-state.ts";
import "./files.css";

function fileBase64(file: File, signal: AbortSignal) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    const finish = (error?: Error) => {
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else if (typeof reader.result === "string")
        resolve(reader.result.slice(reader.result.indexOf(",") + 1));
      else reject(new Error("File read failed"));
    };
    const abort = () => {
      reader.abort();
      finish(new DOMException("File read cancelled", "AbortError"));
    };
    reader.onload = () => finish();
    reader.onerror = () => finish(new Error("File read failed"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    else reader.readAsDataURL(file);
  });
}

interface ImportedFile {
  id: number;
  name: string;
  directory: string;
  file?: File;
  state: "pending" | "running" | "done" | "error";
  message?: string;
}

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
  cwd,
  canWrite,
  active,
  selected,
  onSelect,
  dropTarget,
  onShowTree,
}: {
  sessionId: string;
  sessionPath: string;
  cwd: string;
  canWrite: boolean;
  active: boolean;
  selected: string;
  onSelect: (path: string) => void;
  dropTarget: RefObject<HTMLDivElement | null>;
  onShowTree: (visible: boolean) => void;
}) {
  const { t } = useTranslation();
  const artifacts = useContext(ArtifactContext);
  const reading = useWorkbarReadingState();
  const client = useMemo(() => new WebClient(), []);
  const [query, setQuery] = useState(reading?.files?.query ?? "");
  const [expanded, setExpanded] = useState<string[]>(
    reading?.files?.expanded ?? ["."],
  );
  const [listings, setListings] = useState<
    Record<string, WorkspaceFileListing>
  >({});
  const [results, setResults] = useState<WorkspaceFileListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [directory, setDirectory] = useState(
    selected.includes("/") ? selected.slice(0, selected.lastIndexOf("/")) : ".",
  );
  const [creating, setCreating] = useState<
    "create-file" | "create-directory" | null
  >(null);
  const [name, setName] = useState("");
  const [operationMessage, setOperationMessage] = useState<string | null>(null);
  const [operationError, setOperationError] = useState(false);
  const [mutationBusy, setMutationBusy] = useState(false);
  const [imports, setImports] = useState<ImportedFile[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [copyMessage, setCopyMessage] = useState("");
  const uploadInput = useRef<HTMLInputElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const createOpener = useRef<HTMLButtonElement | null>(null);
  const mutationBusyRef = useRef(false);
  const importId = useRef(0);
  const pendingFocus = useRef<string | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const scope = JSON.stringify([sessionId, sessionPath, cwd]);
  const mutationScope = useRef(scope);
  mutationScope.current = scope;
  const writable = useRef(canWrite);
  writable.current = canWrite;
  const importRead = useRef<AbortController | null>(null);
  useEffect(() => {
    mutationScope.current = scope;
    return () => {
      mutationScope.current = "";
      importRead.current?.abort();
      clearTimeout(copyTimer.current);
    };
  }, [scope]);
  useEffect(() => {
    if (creating) nameInput.current?.focus();
  }, [creating]);
  const tree = useRef<HTMLDivElement>(null);
  const restoreScroll = useRef<number | null>(reading?.files?.treeScroll ?? 0);
  useLayoutEffect(() => {
    if (reading?.files) Object.assign(reading.files, { query, expanded });
  }, [reading, query, expanded]);
  useLayoutEffect(() => {
    if (!active || !(results || listings["."])) return;
    if (restoreScroll.current !== null && tree.current) {
      tree.current.scrollTop = restoreScroll.current;
      restoreScroll.current = null;
    }
  }, [active, results, listings]);
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
  useLayoutEffect(() => {
    const path = pendingFocus.current;
    if (!path || !active) return;
    const row = [
      ...(tree.current?.querySelectorAll<HTMLButtonElement>(
        "[data-file-row]",
      ) ?? []),
    ].find((button) => button.dataset.fileRow === path);
    if (row) {
      row.focus({ preventScroll: true });
      pendingFocus.current = null;
    }
  });

  const mutationFailure = (reason: unknown) =>
    reason instanceof WebApiError && reason.code === "ARTIFACT_EXISTS"
      ? t("filesNameExists")
      : reason instanceof Error
        ? reason.message
        : t("filesMutationFailed");
  const reveal = (result: WorkspaceFileMutationResult) => {
    setQuery("");
    const parts = result.path.split("/");
    const count = result.kind === "directory" ? parts.length : parts.length - 1;
    setExpanded((current) => [
      ...new Set([
        ...current,
        ".",
        ...parts
          .slice(0, count)
          .map((_, index) => parts.slice(0, index + 1).join("/")),
      ]),
    ]);
    pendingFocus.current = result.path;
    setRefresh((value) => value + 1);
    if (result.kind === "file" && (result.bytes ?? 0) <= ARTIFACT_MAX_BYTES) {
      onSelect(result.path);
      artifacts?.open(encodeURI(result.path));
    }
  };
  const closeCreate = () => {
    if (mutationBusyRef.current) return;
    setCreating(null);
    setOperationMessage(null);
    createOpener.current?.focus({ preventScroll: true });
  };
  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (!creating || !writable.current || mutationBusyRef.current) return;
    if (
      !name ||
      name === "." ||
      name === ".." ||
      /[\\/\u0000-\u001f\u007f]/u.test(name)
    ) {
      setOperationError(true);
      setOperationMessage(t("filesNameInvalid"));
      nameInput.current?.focus();
      return;
    }
    mutationBusyRef.current = true;
    setMutationBusy(true);
    setOperationMessage(null);
    const owner = scope;
    try {
      const result = await client.mutateWorkspaceFile(sessionId, sessionPath, {
        kind: creating,
        directory,
        name,
      });
      if (
        mutationScope.current !== owner ||
        result.sessionId !== sessionId ||
        result.sessionPath !== sessionPath
      )
        return;
      setCreating(null);
      setName("");
      setOperationError(false);
      setOperationMessage(t("filesCreated", { path: result.path }));
      reveal(result);
    } catch (reason) {
      if (mutationScope.current === owner) {
        setOperationError(true);
        setOperationMessage(mutationFailure(reason));
        nameInput.current?.focus();
      }
    } finally {
      if (mutationScope.current === owner) {
        mutationBusyRef.current = false;
        setMutationBusy(false);
      }
    }
  };
  const importItems = async (items: ImportedFile[]) => {
    if (!writable.current || mutationBusyRef.current) return;
    const owner = scope;
    mutationBusyRef.current = true;
    setMutationBusy(true);
    const controller = new AbortController();
    importRead.current = controller;
    const update = (item: ImportedFile, change: Partial<ImportedFile>) =>
      setImports((current) =>
        current.map((value) =>
          value.id === item.id ? { ...value, ...change } : value,
        ),
      );
    try {
      for (const item of items) {
        if (mutationScope.current !== owner) return;
        if (!writable.current) {
          update(item, { state: "error", message: t("filesWriteUnavailable") });
          continue;
        }
        if (!item.file) continue;
        update(item, { state: "running", message: undefined });
        try {
          if (item.file.size > WEB_PROMPT_FILE_MAX_BYTES)
            throw new Error(t("filesImportTooLarge"));
          const data = await fileBase64(item.file, controller.signal);
          if (mutationScope.current !== owner) return;
          if (!writable.current) {
            update(item, {
              state: "error",
              message: t("filesWriteUnavailable"),
            });
            continue;
          }
          const result = await client.mutateWorkspaceFile(
            sessionId,
            sessionPath,
            {
              kind: "import-file",
              directory: item.directory,
              name: item.name,
              data,
            },
          );
          if (
            mutationScope.current !== owner ||
            result.sessionId !== sessionId ||
            result.sessionPath !== sessionPath
          )
            return;
          update(item, {
            state: "done",
            file: undefined,
            message:
              (result.bytes ?? 0) > ARTIFACT_MAX_BYTES
                ? t("filesImportedNoPreview")
                : t("filesImported"),
          });
          reveal(result);
        } catch (reason) {
          if (mutationScope.current !== owner) return;
          update(item, { state: "error", message: mutationFailure(reason) });
        }
      }
    } finally {
      if (importRead.current === controller) importRead.current = null;
      if (mutationScope.current === owner) {
        mutationBusyRef.current = false;
        setMutationBusy(false);
      }
    }
  };
  const stageImports = (files: File[], directories: string[] = []) => {
    if (!writable.current || mutationBusyRef.current) return;
    onShowTree(true);
    const pending = files.map((file) => ({
      id: ++importId.current,
      name: file.name,
      directory,
      file,
      state: "pending" as const,
    }));
    setImports((current) => [
      ...current,
      ...directories.map((name) => ({
        id: ++importId.current,
        name,
        directory,
        state: "error" as const,
        message: t("filesImportDirectoryUnsupported"),
      })),
      ...pending,
    ]);
    void importItems(pending);
  };
  const importDrop = useRef(stageImports);
  importDrop.current = stageImports;
  useEffect(() => {
    const target = dropTarget.current;
    if (!target) return;
    const over = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes("Files")) return;
      event.preventDefault();
      const available = writable.current && !mutationBusyRef.current;
      event.dataTransfer.dropEffect = available ? "copy" : "none";
      setDragOver(available);
    };
    const leave = (event: DragEvent) => {
      if (
        !(event.relatedTarget instanceof Node) ||
        !target.contains(event.relatedTarget)
      )
        setDragOver(false);
    };
    const drop = (event: DragEvent) => {
      const transfer = event.dataTransfer;
      if (!transfer?.types.includes("Files")) return;
      event.preventDefault();
      setDragOver(false);
      if (!writable.current || mutationBusyRef.current) return;
      const files: File[] = [];
      const directories: string[] = [];
      for (const item of transfer.items) {
        if (item.kind !== "file") continue;
        const entry = item.webkitGetAsEntry?.();
        if (entry?.isDirectory) directories.push(entry.name);
        else {
          const file = item.getAsFile();
          if (file) files.push(file);
        }
      }
      importDrop.current(
        transfer.items.length ? files : [...transfer.files],
        directories,
      );
    };
    target.addEventListener("dragover", over);
    target.addEventListener("dragleave", leave);
    target.addEventListener("drop", drop);
    return () => {
      target.removeEventListener("dragover", over);
      target.removeEventListener("dragleave", leave);
      target.removeEventListener("drop", drop);
    };
  }, [dropTarget]);
  const copyPath = async (path: string, absolute: boolean) => {
    const owner = scope;
    const separator = cwd.includes("\\") ? "\\" : "/";
    const value = absolute
      ? `${cwd.replace(/[\\/]$/u, "")}${separator}${path.split("/").join(separator)}`
      : path;
    const copied = await copyText(value);
    if (mutationScope.current !== owner) return;
    clearTimeout(copyTimer.current);
    setCopyMessage(t(copied ? "filesPathCopied" : "copyFailed", { path }));
    copyTimer.current = setTimeout(() => setCopyMessage(""), 3_000);
  };
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
          <div className="file-tree-item">
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
                  setDirectory(entry.path);
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
                  setDirectory(
                    entry.path.includes("/")
                      ? entry.path.slice(0, entry.path.lastIndexOf("/"))
                      : ".",
                  );
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
            <DropdownMenu
              button={{
                label: t("filesPathActions", { name: entry.name }),
                icon: <MoreHorizontal aria-hidden="true" />,
                isIconOnly: true,
                size: "sm",
                variant: "ghost",
                className: "file-path-actions",
              }}
              items={[
                {
                  label: t("filesCopyRelativePath"),
                  onClick: () => void copyPath(entry.path, false),
                },
                {
                  label: t("filesCopyAbsolutePath"),
                  onClick: () => void copyPath(entry.path, true),
                },
              ]}
              menuWidth={200}
              alignment="end"
              hasChevron={false}
            />
          </div>
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
    <aside
      className="file-explorer"
      aria-label={t("filesExplorer")}
      data-drag-over={dragOver || undefined}
    >
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
      <div className="file-create-toolbar">
        <fieldset
          className="file-write-actions"
          aria-label={t("filesWorkspaceActions")}
        >
          {(["create-file", "create-directory"] as const).map((kind) => {
            const label = t(
              kind === "create-file" ? "filesNewFile" : "filesNewDirectory",
            );
            const Icon = kind === "create-file" ? FilePlus2 : FolderPlus;
            return (
              <button
                key={kind}
                type="button"
                className="icon-button"
                aria-label={label}
                title={canWrite ? label : t("filesWriteUnavailable")}
                disabled={!canWrite || mutationBusy}
                onClick={(event) => {
                  createOpener.current = event.currentTarget;
                  setCreating(kind);
                  setName("");
                  setOperationMessage(null);
                }}
              >
                <Icon aria-hidden="true" />
              </button>
            );
          })}
          <button
            type="button"
            className="icon-button"
            aria-label={t("filesImport")}
            title={canWrite ? t("filesImport") : t("filesWriteUnavailable")}
            disabled={!canWrite || mutationBusy}
            onClick={() => uploadInput.current?.click()}
          >
            <Upload aria-hidden="true" />
          </button>
          <input
            ref={uploadInput}
            type="file"
            multiple
            hidden
            aria-label={t("filesImportChoose")}
            onChange={(event) => {
              stageImports([...(event.currentTarget.files ?? [])]);
              event.currentTarget.value = "";
            }}
          />
        </fieldset>
        <p className="file-write-directory" title={directory}>
          <span>
            {t("filesTargetDirectory")}:{" "}
            {directory === "." ? t("filesWorkspaceRoot") : directory}
          </span>
          {directory !== "." && (
            <button type="button" onClick={() => setDirectory(".")}>
              {t("filesWorkspaceRoot")}
            </button>
          )}
        </p>
      </div>
      {creating && (
        <form
          className="file-create-form"
          onSubmit={(event) => void create(event)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              event.stopPropagation();
              closeCreate();
            }
          }}
        >
          <label>
            {t(
              creating === "create-file"
                ? "filesFileName"
                : "filesDirectoryName",
            )}
            <input
              ref={nameInput}
              value={name}
              maxLength={255}
              disabled={mutationBusy}
              aria-invalid={Boolean(operationMessage && operationError)}
              onChange={(event) => setName(event.currentTarget.value)}
            />
          </label>
          <div>
            <button type="submit" disabled={!canWrite || mutationBusy}>
              {t(mutationBusy ? "filesCreating" : "filesCreate")}
            </button>
            <button type="button" disabled={mutationBusy} onClick={closeCreate}>
              {t("cancel")}
            </button>
          </div>
        </form>
      )}
      {operationMessage && (
        <p
          className={`file-tree-note${operationError ? " evidence-warning" : ""}`}
          role={operationError ? "alert" : "status"}
        >
          {operationMessage}
        </p>
      )}
      {imports.length > 0 && (
        <div className="file-import-results">
          <p>{t("filesImportLimit")}</p>
          <ol aria-label={t("filesImportResults")} aria-live="polite">
            {imports.map((item) => (
              <li key={item.id} data-import-state={item.state}>
                <span title={`${item.directory}/${item.name}`}>
                  {item.name}
                </span>
                <small>
                  {item.message ??
                    t(
                      item.state === "running"
                        ? "filesImporting"
                        : "filesImportPending",
                    )}
                </small>
                {item.state === "error" && item.file && (
                  <button
                    type="button"
                    disabled={!canWrite || mutationBusy}
                    onClick={() => void importItems([item])}
                  >
                    {t("filesRetryImport")}
                  </button>
                )}
              </li>
            ))}
          </ol>
          <button
            type="button"
            disabled={mutationBusy}
            onClick={() =>
              setImports((current) =>
                current.filter((item) => item.state !== "done"),
              )
            }
          >
            {t("filesClearImported")}
          </button>
        </div>
      )}
      <span className="sr-only" role="status">
        {copyMessage}
      </span>
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
        onScroll={(event) => {
          if (reading?.files)
            reading.files.treeScroll = event.currentTarget.scrollTop;
        }}
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
  canWrite = true,
}: {
  sessionId: string;
  sessionPath: string;
  cwd: string;
  active: boolean;
  canWrite?: boolean;
}) {
  const { t } = useTranslation();
  const reading = useWorkbarReadingState();
  const [selected, setSelected] = useState(reading?.files?.selected ?? "");
  const [treeVisible, setTreeVisible] = useState(
    reading?.files?.treeVisible ?? true,
  );
  const dropTarget = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (reading)
      reading.files = {
        query: "",
        expanded: ["."],
        treeScroll: 0,
        ...reading.files,
        selected,
        treeVisible,
      };
  }, [reading, selected, treeVisible]);
  return (
    <div
      ref={dropTarget}
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
            key={JSON.stringify([sessionId, sessionPath, cwd])}
            sessionId={sessionId}
            sessionPath={sessionPath}
            cwd={cwd}
            canWrite={canWrite}
            active={active && treeVisible}
            selected={selected}
            onSelect={setSelected}
            dropTarget={dropTarget}
            onShowTree={setTreeVisible}
          />
        </div>
      </ArtifactProvider>
    </div>
  );
}
