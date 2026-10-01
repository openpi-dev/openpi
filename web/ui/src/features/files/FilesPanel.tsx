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
  FolderInput,
  FolderOpen,
  FolderPlus,
  Link,
  ListChecks,
  MoreHorizontal,
  RefreshCw,
  Search,
  Sheet,
  Trash2,
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
  WorkspaceTrashEntry,
} from "../../../../protocol/artifacts.ts";
import { ARTIFACT_MAX_BYTES } from "../../../../protocol/artifacts.ts";
import { WEB_PROMPT_FILE_MAX_BYTES } from "../../../../protocol/prompt-files.ts";
import { copyText } from "../../lib/clipboard.ts";
import { WebApiError, WebClient } from "../../protocol/client.ts";
import {
  ArtifactProvider,
  type ArtifactProviderHandle,
} from "../artifacts/Artifacts.tsx";
import { ArtifactContext } from "../artifacts/context.ts";
import { useWorkbarReadingState } from "../workbar/workbar-reading-state.ts";
import "./files.css";
import { moveFileDrafts } from "./use-file-editor.ts";

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
  createParents?: boolean;
  file?: File;
  kind?: "directory";
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
  onRemoved,
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
  onRemoved: (paths: string[]) => void;
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
  const [selecting, setSelecting] = useState(false);
  const [checked, setChecked] = useState<WorkspaceFileEntry[]>([]);
  const [moving, setMoving] = useState<{
    entries: WorkspaceFileEntry[];
    rename: boolean;
  } | null>(null);
  const [moveDirectory, setMoveDirectory] = useState(".");
  const [moveName, setMoveName] = useState("");
  const [organizationResults, setOrganizationResults] = useState<
    { path: string; error?: string }[]
  >([]);
  const [trashOpen, setTrashOpen] = useState(false);
  const [trashEntries, setTrashEntries] = useState<WorkspaceTrashEntry[]>([]);
  const [trashUnavailable, setTrashUnavailable] = useState(0);
  const [trashLoading, setTrashLoading] = useState(false);
  const [trashCursor, setTrashCursor] = useState<string | undefined>();
  const trashGeneration = useRef(0);
  const [recentTrash, setRecentTrash] = useState<WorkspaceTrashEntry[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [copyMessage, setCopyMessage] = useState("");
  const uploadInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const moveInput = useRef<HTMLInputElement>(null);
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
    folderInput.current?.setAttribute("webkitdirectory", "");
  }, []);
  useEffect(() => {
    void refresh;
    if (!trashOpen || !active) return;
    trashGeneration.current++;
    const controller = new AbortController();
    setTrashLoading(true);
    void client
      .workspaceTrash(sessionId, sessionPath, controller.signal)
      .then((result) => {
        if (
          !controller.signal.aborted &&
          result.sessionId === sessionId &&
          result.sessionPath === sessionPath
        ) {
          setTrashEntries(result.entries);
          setTrashUnavailable(result.unavailable ?? 0);
          setTrashCursor(result.nextCursor);
        }
      })
      .catch((reason) => {
        if (!controller.signal.aborted) {
          setOperationError(true);
          setOperationMessage(
            reason instanceof Error ? reason.message : t("filesReadFailed"),
          );
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setTrashLoading(false);
      });
    return () => controller.abort();
  }, [client, sessionId, sessionPath, active, trashOpen, refresh, t]);
  useEffect(() => {
    if (moving) {
      moveInput.current?.focus();
      moveInput.current?.select();
    }
  }, [moving]);
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
        if (!item.file && item.kind !== "directory") continue;
        update(item, { state: "running", message: undefined });
        try {
          if (item.kind === "directory") {
            try {
              await client.mutateWorkspaceFile(sessionId, sessionPath, {
                kind: "create-directory",
                directory: item.directory,
                name: item.name,
              });
            } catch (reason) {
              if (
                !(reason instanceof WebApiError) ||
                reason.code !== "ARTIFACT_EXISTS"
              )
                throw reason;
              // Existing folders are reusable; a same-name file is not.
              await client.workspaceFiles(
                sessionId,
                sessionPath,
                [item.directory === "." ? "" : item.directory, item.name]
                  .filter(Boolean)
                  .join("/"),
                "",
                controller.signal,
              );
            }
            if (mutationScope.current !== owner) return;
            update(item, { state: "done", message: t("filesImported") });
            setRefresh((value) => value + 1);
            continue;
          }
          if (!item.file) continue;
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
              ...(item.createParents ? { createParents: true } : {}),
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
  const stageImports = (
    files: File[],
    directories: string[] = [],
    relativePaths = new Map<File, string>(),
    folders: string[] = [],
  ) => {
    if (!writable.current || mutationBusyRef.current) return;
    if (files.length + folders.length > 2_000) {
      setOperationError(true);
      setOperationMessage(t("filesImportFolderLimit"));
      return;
    }
    onShowTree(true);
    const pending: ImportedFile[] = [
      ...[...new Set(folders)]
        .sort((a, b) => a.split("/").length - b.split("/").length)
        .map((path) => ({
          id: ++importId.current,
          name: path.split("/").at(-1)!,
          directory:
            [
              directory === "." ? "" : directory,
              ...path.split("/").slice(0, -1),
            ]
              .filter(Boolean)
              .join("/") || ".",
          kind: "directory" as const,
          state: "pending" as const,
        })),
      ...files.map((file) => {
        const relative = relativePaths.get(file) ?? file.webkitRelativePath;
        return {
          id: ++importId.current,
          name: file.name,
          directory: relative
            ? [
                directory === "." ? "" : directory,
                ...relative.split("/").slice(0, -1),
              ]
                .filter(Boolean)
                .join("/") || "."
            : directory,
          createParents: Boolean(relative),
          file,
          state: "pending" as const,
        };
      }),
    ];
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

  const organize = async (
    kind: "move" | "trash",
    entries: WorkspaceFileEntry[],
  ) => {
    if (!writable.current || mutationBusyRef.current) return;
    const owner = scope;
    // Selecting a folder already includes its descendants. Do not operate on
    // the same contents twice when an expanded tree has both selected.
    const targets = entries.filter(
      (entry) =>
        !entries.some(
          (parent) =>
            parent.kind === "directory" &&
            entry.path.startsWith(`${parent.path}/`),
        ),
    );
    mutationBusyRef.current = true;
    setMutationBusy(true);
    setOrganizationResults([]);
    const removed: WorkspaceTrashEntry[] = [];
    const completed = new Set<string>();
    try {
      for (const entry of targets) {
        if (mutationScope.current !== owner || !writable.current) return;
        try {
          if (!entry.identity)
            throw new Error(t("filesRefreshBeforeOrganizing"));
          const result = await client.mutateWorkspaceFile(
            sessionId,
            sessionPath,
            kind === "trash"
              ? { kind, path: entry.path, identity: entry.identity }
              : {
                  kind,
                  path: entry.path,
                  identity: entry.identity,
                  directory: moveDirectory,
                  name: moving?.rename ? moveName : entry.name,
                },
          );
          if (
            mutationScope.current !== owner ||
            result.sessionId !== sessionId ||
            result.sessionPath !== sessionPath
          )
            return;
          completed.add(entry.path);
          if (result.trashed) removed.push(result.trashed);
          if (result.moved)
            moveFileDrafts(
              sessionId,
              sessionPath,
              result.moved.from,
              result.moved.to,
            );
          if (entry.kind === "directory") {
            const contains = (path: string) =>
              path === entry.path || path.startsWith(`${entry.path}/`);
            setExpanded((current) =>
              kind === "trash"
                ? current.filter((path) => !contains(path))
                : current.map((path) =>
                    contains(path)
                      ? `${result.path}${path.slice(entry.path.length)}`
                      : path,
                  ),
            );
            setDirectory((current) =>
              !contains(current)
                ? current
                : kind === "move"
                  ? `${result.path}${current.slice(entry.path.length)}`
                  : entry.path.split("/").slice(0, -1).join("/") || ".",
            );
            if (kind === "move" && contains(selected)) {
              const path = `${result.path}${selected.slice(entry.path.length)}`;
              onSelect(path);
              artifacts?.open(encodeURI(path));
            }
          }
          if (kind === "move") reveal(result);
          setOrganizationResults((current) => [
            ...current,
            { path: entry.path },
          ]);
        } catch (reason) {
          if (mutationScope.current !== owner) return;
          setOrganizationResults((current) => [
            ...current,
            { path: entry.path, error: mutationFailure(reason) },
          ]);
        }
      }
      setRecentTrash(removed);
      if (kind === "trash") onRemoved([...completed]);
      setChecked((current) =>
        current.filter(
          (entry) =>
            ![...completed].some(
              (path) =>
                path === entry.path || entry.path.startsWith(`${path}/`),
            ),
        ),
      );
      setMoving(null);
      setRefresh((value) => value + 1);
    } finally {
      if (mutationScope.current === owner) {
        mutationBusyRef.current = false;
        setMutationBusy(false);
      }
    }
  };
  const restore = async (entries: WorkspaceTrashEntry[]) => {
    if (!writable.current || mutationBusyRef.current) return;
    const owner = scope;
    mutationBusyRef.current = true;
    setMutationBusy(true);
    setOrganizationResults([]);
    try {
      for (const entry of entries) {
        if (mutationScope.current !== owner || !writable.current) return;
        try {
          const result = await client.mutateWorkspaceFile(
            sessionId,
            sessionPath,
            { kind: "restore", id: entry.id, identity: entry.identity },
          );
          if (
            mutationScope.current !== owner ||
            result.sessionId !== sessionId ||
            result.sessionPath !== sessionPath
          )
            return;
          setRecentTrash((current) =>
            current.filter((value) => value.id !== entry.id),
          );
          setTrashEntries((current) =>
            current.filter((value) => value.id !== entry.id),
          );
          setOrganizationResults((current) => [
            ...current,
            { path: entry.path },
          ]);
          reveal(result);
        } catch (reason) {
          if (mutationScope.current !== owner) return;
          setOrganizationResults((current) => [
            ...current,
            { path: entry.path, error: mutationFailure(reason) },
          ]);
        }
      }
      setRefresh((value) => value + 1);
    } finally {
      if (mutationScope.current === owner) {
        mutationBusyRef.current = false;
        setMutationBusy(false);
      }
    }
  };
  const moreTrash = async () => {
    if (!trashCursor || trashLoading) return;
    const generation = trashGeneration.current;
    const owner = scope;
    setTrashLoading(true);
    try {
      const result = await client.workspaceTrash(
        sessionId,
        sessionPath,
        undefined,
        trashCursor,
      );
      if (
        generation !== trashGeneration.current ||
        mutationScope.current !== owner ||
        result.sessionId !== sessionId ||
        result.sessionPath !== sessionPath
      )
        return;
      setTrashEntries((current) => [
        ...new Map(
          [...current, ...result.entries].map((entry) => [entry.id, entry]),
        ).values(),
      ]);
      setTrashUnavailable((current) => current + (result.unavailable ?? 0));
      setTrashCursor(result.nextCursor);
    } catch (reason) {
      if (
        generation === trashGeneration.current &&
        mutationScope.current === owner
      ) {
        setOperationError(true);
        setOperationMessage(mutationFailure(reason));
      }
    } finally {
      if (
        generation === trashGeneration.current &&
        mutationScope.current === owner
      )
        setTrashLoading(false);
    }
  };
  const selectEntry = (entry: WorkspaceFileEntry) =>
    setChecked((current) =>
      current.some((value) => value.path === entry.path)
        ? current.filter((value) => value.path !== entry.path)
        : [...current, entry],
    );
  const openMove = (entries: WorkspaceFileEntry[], rename = false) => {
    setMoving({ entries, rename });
    const path = entries[0]?.path ?? "";
    setMoveDirectory(
      rename ? path.split("/").slice(0, -1).join("/") || "." : directory,
    );
    setMoveName(entries[0]?.name ?? "");
    setOperationMessage(null);
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
      const roots: FileSystemEntry[] = [];
      for (const item of transfer.items) {
        if (item.kind !== "file") continue;
        const entry = item.webkitGetAsEntry?.();
        if (entry?.isDirectory && "createReader" in entry) roots.push(entry);
        else if (entry?.isDirectory) directories.push(entry.name);
        else {
          const file = item.getAsFile();
          if (file) files.push(file);
        }
      }
      if (roots.length) {
        const owner = mutationScope.current;
        const paths = new Map<File, string>();
        const folders: string[] = [];
        let count = 0;
        const collect = async (entry: FileSystemEntry, prefix: string) => {
          if (mutationScope.current !== owner || !writable.current)
            throw new DOMException("Import cancelled", "AbortError");
          if (++count > 2_000 || prefix.split("/").length > 64)
            throw new Error(t("filesImportFolderLimit"));
          const path = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.isDirectory) {
            folders.push(path);
            const reader = (entry as FileSystemDirectoryEntry).createReader();
            for (;;) {
              const children = await new Promise<FileSystemEntry[]>(
                (resolve, reject) => reader.readEntries(resolve, reject),
              );
              if (!children.length) break;
              for (const child of children) await collect(child, path);
            }
          } else if (entry.isFile) {
            const file = await new Promise<File>((resolve, reject) =>
              (entry as FileSystemFileEntry).file(resolve, reject),
            );
            paths.set(file, path);
            files.push(file);
          }
        };
        mutationBusyRef.current = true;
        setMutationBusy(true);
        void (async () => {
          try {
            for (const root of roots) await collect(root, "");
            if (mutationScope.current !== owner || !writable.current) return;
            mutationBusyRef.current = false;
            setMutationBusy(false);
            importDrop.current(files, directories, paths, folders);
          } catch (reason) {
            if (mutationScope.current === owner) {
              setOperationError(true);
              setOperationMessage(
                reason instanceof Error
                  ? reason.message
                  : t("filesMutationFailed"),
              );
            }
          } finally {
            if (mutationScope.current === owner && !importRead.current) {
              mutationBusyRef.current = false;
              setMutationBusy(false);
            }
          }
        })();
        return;
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
  }, [dropTarget, t]);
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
      const organizable =
        canWrite &&
        Boolean(entry.identity) &&
        !entry.path
          .split("/")
          .some((part) =>
            [".git", ".pi", ".openpi-trash"].includes(part.toLowerCase()),
          ) &&
        (directory || entry.kind === "file");
      return (
        <li key={entry.path}>
          <div className="file-tree-item">
            {selecting && (
              <input
                type="checkbox"
                className="file-tree-check"
                aria-label={t("filesSelectItem", { name: entry.name })}
                checked={checked.some((value) => value.path === entry.path)}
                disabled={!organizable || mutationBusy}
                onChange={() => selectEntry(entry)}
              />
            )}
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
                if (organizable && (event.metaKey || event.ctrlKey)) {
                  setSelecting(true);
                  selectEntry(entry);
                  return;
                }
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
                {
                  label: t("filesRename"),
                  isDisabled: !organizable || mutationBusy,
                  onClick: () => openMove([entry], true),
                },
                {
                  label: t("filesMove"),
                  isDisabled: !organizable || mutationBusy,
                  onClick: () => openMove([entry]),
                },
                {
                  label: t("filesTrashAction"),
                  isDisabled: !organizable || mutationBusy,
                  onClick: () => void organize("trash", [entry]),
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
          <button
            type="button"
            className="icon-button"
            aria-label={t("filesImportFolder")}
            title={
              canWrite ? t("filesImportFolder") : t("filesWriteUnavailable")
            }
            disabled={!canWrite || mutationBusy}
            onClick={() => folderInput.current?.click()}
          >
            <FolderInput aria-hidden="true" />
          </button>
          <input
            ref={folderInput}
            type="file"
            multiple
            hidden
            aria-label={t("filesImportFolderChoose")}
            onChange={(event) => {
              stageImports([...(event.currentTarget.files ?? [])]);
              event.currentTarget.value = "";
            }}
          />
          <button
            type="button"
            className="icon-button"
            aria-label={t("filesSelectMultiple")}
            title={t("filesSelectMultiple")}
            aria-pressed={selecting}
            disabled={!canWrite || mutationBusy}
            onClick={() => {
              setSelecting((value) => !value);
              setChecked([]);
            }}
          >
            <ListChecks aria-hidden="true" />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label={t("filesTrash")}
            title={t("filesTrash")}
            aria-pressed={trashOpen}
            onClick={() => setTrashOpen((value) => !value)}
          >
            <Trash2 aria-hidden="true" />
          </button>
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
      {selecting && (
        <div className="file-organization-bar">
          <span>{t("filesSelectedCount", { count: checked.length })}</span>
          <button
            type="button"
            disabled={!checked.length || mutationBusy || !canWrite}
            onClick={() => openMove(checked)}
          >
            {t("filesMove")}
          </button>
          <button
            type="button"
            disabled={!checked.length || mutationBusy || !canWrite}
            onClick={() => void organize("trash", checked)}
          >
            {t("filesTrashAction")}
          </button>
        </div>
      )}
      {moving && (
        <form
          className="file-create-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!moving.rename || moveName.trim())
              void organize("move", moving.entries);
          }}
        >
          <label>
            {t(moving.rename ? "filesRename" : "filesMoveDestination")}
            <input
              ref={moveInput}
              value={moving.rename ? moveName : moveDirectory}
              aria-label={t(
                moving.rename ? "filesNewName" : "filesMoveDestination",
              )}
              disabled={mutationBusy}
              onChange={(event) =>
                moving.rename
                  ? setMoveName(event.currentTarget.value)
                  : setMoveDirectory(event.currentTarget.value)
              }
            />
          </label>
          <div>
            <button type="submit" disabled={mutationBusy || !canWrite}>
              {t(moving.rename ? "filesRename" : "filesMove")}
            </button>
            <button
              type="button"
              disabled={mutationBusy}
              onClick={() => setMoving(null)}
            >
              {t("cancel")}
            </button>
          </div>
        </form>
      )}
      {organizationResults.length > 0 && (
        <div className="file-import-results">
          <ol aria-label={t("filesOrganizationResults")} aria-live="polite">
            {organizationResults.map((result) => (
              <li key={result.path}>
                <span>{result.path}</span>
                <small role={result.error ? "alert" : undefined}>
                  {result.error ?? t("filesOperationDone")}
                </small>
              </li>
            ))}
          </ol>
          {recentTrash.length > 0 && (
            <button
              type="button"
              disabled={mutationBusy || !canWrite}
              onClick={() => void restore(recentTrash)}
            >
              {t("filesUndoTrash")}
            </button>
          )}
        </div>
      )}
      {trashOpen && (
        <section className="file-trash-list" aria-label={t("filesTrash")}>
          <p>{t("filesTrashDetail")}</p>
          {trashUnavailable > 0 && (
            <p role="alert">
              {t("filesTrashUnavailable", { count: trashUnavailable })}
            </p>
          )}
          {trashLoading && trashEntries.length === 0 ? (
            <p>{t("loading")}</p>
          ) : trashEntries.length === 0 ? (
            <p>{t("filesTrashEmpty")}</p>
          ) : (
            <ul>
              {trashEntries.map((entry) => (
                <li key={entry.id}>
                  <span title={entry.path}>{entry.path}</span>
                  <button
                    type="button"
                    disabled={!canWrite || mutationBusy}
                    aria-label={t("filesRestoreItem", { name: entry.path })}
                    onClick={() => void restore([entry])}
                  >
                    {t("filesRestore")}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {trashCursor && (
            <button
              type="button"
              disabled={trashLoading}
              onClick={() => void moreTrash()}
            >
              {t("filesLoadMore")}
            </button>
          )}
        </section>
      )}
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
                {item.state === "error" &&
                  (item.file || item.kind === "directory") && (
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
  const provider = useRef<ArtifactProviderHandle>(null);
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
        ref={provider}
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
            onRemoved={(paths) => {
              if (
                paths.some(
                  (path) =>
                    path === selected || selected.startsWith(`${path}/`),
                )
              )
                provider.current?.close({ restoreFocus: false });
            }}
          />
        </div>
      </ArtifactProvider>
    </div>
  );
}
