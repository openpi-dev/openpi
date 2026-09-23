import { createHash } from "node:crypto";
import {
  lstat,
  open,
  readFile,
  opendir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import {
  getAgentDir,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { loadSessionPreviewData } from "../../extensions/sessions/preview-loader.ts";
import { WEB_COMMAND_INPUT } from "../../extensions/shared/web-command-feedback.ts";
import { webCapabilitySnapshot } from "../../extensions/shared/web-observer-registry.ts";
import {
  boundedText,
  boundThinkingProjection,
  jsonByteLength,
  projectEntries,
  projectEntry,
  WEB_MAX_MODELS,
  WEB_MAX_ARCHIVED_SESSION_PAGE,
  WEB_MAX_ARCHIVED_SESSION_CURSOR,
  WEB_MAX_ARCHIVED_SESSION_QUERY,
  WEB_MAX_ARCHIVED_SESSION_SCAN,
  WEB_MAX_SESSIONS,
  WEB_MAX_SESSION_PREVIEW,
  WEB_MAX_SNAPSHOT_BYTES,
  WEB_MAX_SELECTED_TRANSCRIPT_BYTES,
  WEB_MAX_WORKSPACES,
  type WebSessionProjection,
  type WebSessionHistoryPage,
  type WebSessionSummary,
  type WebSnapshotTruncation,
  type WebWorkspaceSummary,
} from "../protocol/types.ts";
import type {
  WebRuntimeController,
  WebThinkingProjection,
} from "../runtime/types.ts";
import { matchesSessionIdentity } from "../runtime/session-identity.ts";
import {
  WEB_TURN_CHANGES_ENTRY,
  readTurnChangesDetail,
  type WebTurnChangesResult,
} from "../protocol/turn-changes.ts";

export class WebReadOnlySessionError extends Error {
  readonly code = "SESSION_NOT_FOUND" as const;
  readonly statusCode = 404 as const;

  constructor(message: string) {
    super(message);
    this.name = "WebReadOnlySessionError";
  }
}

type WorkspaceStateSnapshot = {
  importedWorkspaces: Set<string>;
  hiddenWorkspaces: Set<string>;
  workspaceNames: Map<string, string>;
  ungroupedSessions: Set<string>;
  restoreInitialWorkspace: boolean;
};

const TERMINAL_DISCOVERY_MAX_BYTES = 256 * 1024;
const TERMINAL_DISCOVERY_MAX_FILES = WEB_MAX_SESSIONS;
const HISTORY_PAGE_TURNS = 20;
const ITEM_PAGE_TEXT_CHARS = 32_000;

function visibleTextSegments(content: unknown) {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  const texts = content.flatMap((part): string[] =>
    part && typeof part === "object" && part.type === "text" && typeof part.text === "string"
      ? [part.text] : [],
  );
  return texts.flatMap((value, index) => index ? ["\n", value] : [value]);
}

function visibleTextPage(content: unknown, cursor: number) {
  const segments = visibleTextSegments(content);
  const totalChars = segments.reduce((total, part) => total + part.length, 0);
  if (cursor > totalChars) return null;
  let position = 0;
  let text = "";
  for (const part of segments) {
    const endOfPart = position + part.length;
    if (cursor < endOfPart && text.length < ITEM_PAGE_TEXT_CHARS) {
      const start = Math.max(0, cursor - position);
      let end = Math.min(part.length, start + ITEM_PAGE_TEXT_CHARS - text.length);
      if (end < part.length && end > start && /[\uD800-\uDBFF]/u.test(part[end - 1]!)) end--;
      text += part.slice(start, end);
      if (end < part.length) break;
    }
    position = endOfPart;
    if (text.length >= ITEM_PAGE_TEXT_CHARS) break;
  }
  const next = cursor + text.length;
  return { text, nextCursor: next < totalChars ? next : null, totalChars };
}

function alignHistoryPage(
  projected: ReturnType<typeof projectEntries>,
  totalEntries: number,
) {
  const prompts = projected.entries.flatMap((entry, index) =>
    entry.message?.role === "user" ? [index] : [],
  );
  const start = prompts.length > HISTORY_PAGE_TURNS
    ? prompts[prompts.length - HISTORY_PAGE_TURNS]!
    : 0;
  if (start === 0) return projected;
  projected.entries.splice(0, start);
  projected.bytes = jsonByteLength(projected.entries);
  const messagesTruncated = projected.entries.filter((entry) => entry.message?.truncation).length;
  const messagePartsOmitted = projected.entries.reduce(
    (total, entry) => total + (entry.message?.truncation?.partsOmitted ?? 0),
    0,
  );
  const entriesOmitted = totalEntries - projected.entries.length;
  projected.truncation = {
    ...projected.truncation,
    entriesOmitted,
    messagesTruncated,
    messagePartsOmitted,
    truncated: entriesOmitted > 0 || messagesTruncated > 0 || messagePartsOmitted > 0,
  };
  return projected;
}

type ReadOnlyTerminalSessionInfo = {
  id: string;
  path: string;
  cwd: string;
  name?: string;
  modified: Date;
  created: Date;
  messageCount: number;
  firstMessage: string;
  metadataPartial: boolean;
};

function defaultTerminalSessionDirectory(cwd: string) {
  const resolvedCwd = resolve(cwd);
  const encoded = `--${resolvedCwd.replace(/^[/\\]/u, "").replace(/[/\\:]/gu, "-")}--`;
  return join(getAgentDir(), "sessions", encoded);
}

function containedPath(parent: string, candidate: string) {
  const child = relative(parent, candidate);
  return (
    child.length > 0 &&
    child !== ".." &&
    !child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
    !isAbsolute(child)
  );
}

function terminalTextContent(message: Record<string, unknown>) {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part): part is { type: "text"; text: string } =>
        !!part &&
        typeof part === "object" &&
        (part as Record<string, unknown>).type === "text" &&
        typeof (part as Record<string, unknown>).text === "string",
    )
    .map((part) => part.text)
    .join(" ");
}

async function readTerminalSessionInfo(
  filePath: string,
  modified: Date,
  signal?: AbortSignal,
): Promise<ReadOnlyTerminalSessionInfo | undefined> {
  signal?.throwIfAborted();
  let fileStat;
  try {
    fileStat = await lstat(filePath);
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) return undefined;
  } catch {
    return undefined;
  }

  let handle;
  try {
    handle = await open(filePath, "r");
  } catch {
    return undefined;
  }
  try {
    signal?.throwIfAborted();
    const length = Math.min(fileStat.size, TERMINAL_DISCOVERY_MAX_BYTES);
    const bytes = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(bytes, 0, length, 0);
    signal?.throwIfAborted();
    const text = bytes.toString("utf8", 0, bytesRead);
    const lines = text.split(/\r?\n/u);
    if (bytesRead < fileStat.size) lines.pop();

    let header: Record<string, unknown> | undefined;
    let name: string | undefined;
    let firstMessage = "";
    let messageCount = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        continue;
      }
      const entry = value as Record<string, unknown>;
      if (!header) {
        if (entry.type !== "session" || typeof entry.id !== "string") {
          return undefined;
        }
        header = entry;
        continue;
      }
      if (entry.type === "session_info") {
        const entryName = entry.name;
        name = typeof entryName === "string" ? entryName.trim() || undefined : name;
        continue;
      }
      if (entry.type !== "message") continue;
      messageCount++;
      const message = entry.message;
      if (
        !firstMessage &&
        message &&
        typeof message === "object" &&
        !Array.isArray(message) &&
        (message as Record<string, unknown>).role === "user"
      ) {
        firstMessage = terminalTextContent(message as Record<string, unknown>);
      }
    }
    if (!header || typeof header.cwd !== "string") return undefined;
    const created =
      typeof header.timestamp === "string" && !Number.isNaN(Date.parse(header.timestamp))
        ? new Date(header.timestamp)
        : modified;
    return {
      id: header.id as string,
      path: filePath,
      cwd: resolve(header.cwd),
      ...(name ? { name } : {}),
      modified,
      created,
      messageCount,
      firstMessage: firstMessage || "(no messages)",
      metadataPartial: bytesRead < fileStat.size,
    };
  } finally {
    await handle.close();
  }
}

async function listTerminalSessionInfo(workspace: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const directory = defaultTerminalSessionDirectory(workspace);
  const sessions: ReadOnlyTerminalSessionInfo[] = [];
  let partial = false;
  let scanned = 0;
  try {
    // Bound directory traversal and file work, not only the returned projection.
    const entries = await opendir(directory);
    for await (const entry of entries) {
      signal?.throwIfAborted();
      if (++scanned > TERMINAL_DISCOVERY_MAX_FILES) {
        partial = true;
        break;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const path = join(directory, entry.name);
      try {
        const fileStat = await stat(path);
        const session = await readTerminalSessionInfo(path, fileStat.mtime, signal);
        if (!session) { partial = true; continue; }
        if (session.cwd !== workspace) continue;
        partial ||= session.metadataPartial;
        sessions.push(session);
      } catch (error) {
        signal?.throwIfAborted();
        partial = true;
      }
    }
  } catch (error) {
    signal?.throwIfAborted();
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") partial = true;
  }
  sessions.sort((left, right) => right.modified.getTime() - left.modified.getTime());
  return { sessions, partial };
}

export interface ArchivedSessionQuery {
  readonly cursor?: string;
  readonly limit?: number;
  readonly query?: string;
}

interface ArchivedSessionCursor {
  readonly version: 1;
  readonly sessionPath: string;
  readonly queryHash: string;
}

function encodeArchivedSessionCursor(cursor: ArchivedSessionCursor) {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function archivedQueryHash(query: string) {
  return createHash("sha256").update(query).digest("hex");
}

function decodeArchivedSessionCursor(value: string) {
  try {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) return undefined;
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      (parsed as { version?: unknown }).version !== 1 ||
      typeof (parsed as { sessionPath?: unknown }).sessionPath !== "string" ||
      (parsed as { sessionPath: string }).sessionPath.length === 0 ||
      (parsed as { sessionPath: string }).sessionPath.length > 320 ||
      typeof (parsed as { queryHash?: unknown }).queryHash !== "string" ||
      !/^[0-9a-f]{64}$/u.test((parsed as { queryHash: string }).queryHash)
    ) {
      return undefined;
    }
    return parsed as ArchivedSessionCursor;
  } catch {
    return undefined;
  }
}

export class PiWebAdapter {
  private readonly runtime: WebRuntimeController;
  private readonly importedWorkspaces = new Set<string>();
  private readonly hiddenWorkspaces = new Set<string>();
  private readonly workspaceNames = new Map<string, string>();
  private readonly workspaceStateFile: string;
  private readonly ungroupedSessions = new Set<string>();
  private readonly archiveFile: string;
  private readonly archivedSessions = new Set<string>();
  private archivesLoaded = false;
  private archivesLoading?: Promise<void>;
  private archivesWrite: Promise<void> = Promise.resolve();
  private workspaceStateLoaded = false;
  private workspaceStateLoading?: Promise<void>;
  private workspaceStateWrite: Promise<void> = Promise.resolve();
  private initialization?: Promise<void>;
  private restoreInitialWorkspace = false;
  private writeSequence = 0;

  constructor(runtime: WebRuntimeController) {
    this.runtime = runtime;
    this.workspaceStateFile = join(
      runtime.sessionDirectory,
      "workspace-state.json",
    );
    this.archiveFile = join(runtime.sessionDirectory, "archived-sessions.json");
    if (runtime.workspaceSelected === true) {
      this.importedWorkspaces.add(resolve(runtime.cwd));
    }
  }

  private async ensureWorkspaceStateLoaded() {
    if (this.workspaceStateLoaded) return;
    if (!this.workspaceStateLoading) {
      this.workspaceStateLoading = (async () => {
        try {
          const parsed: unknown = JSON.parse(
            await readFile(this.workspaceStateFile, "utf8"),
          );
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error("Workspace metadata must be an object");
          }
          const state = parsed as Record<string, unknown>;
          if (
            !Array.isArray(state.hiddenWorkspaces) ||
            !state.hiddenWorkspaces.every((path) => typeof path === "string") ||
            !Array.isArray(state.ungroupedSessions) ||
            !state.ungroupedSessions.every((path) => typeof path === "string") ||
            !state.workspaceNames ||
            typeof state.workspaceNames !== "object" ||
            Array.isArray(state.workspaceNames) ||
            !Object.entries(state.workspaceNames).every(
              ([path, name]) => path.length > 0 && typeof name === "string",
            )
          ) {
            throw new Error("Workspace metadata has an invalid shape");
          }
          for (const path of state.hiddenWorkspaces) {
            this.hiddenWorkspaces.add(resolve(path));
          }
          for (const path of state.ungroupedSessions) {
            this.ungroupedSessions.add(resolve(path));
          }
          for (const [path, name] of Object.entries(state.workspaceNames)) {
            this.workspaceNames.set(resolve(path), name as string);
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        this.restoreInitialWorkspace =
          this.runtime.workspaceSelected === true &&
          this.hiddenWorkspaces.has(resolve(this.runtime.cwd));
        this.workspaceStateLoaded = true;
      })();
    }
    await this.workspaceStateLoading;
  }

  private enqueueWorkspaceMutation<T>(
    mutate: (draft: WorkspaceStateSnapshot) => T | Promise<T>,
  ) {
    const operation = this.workspaceStateWrite.then(async () => {
      const draft = this.captureWorkspaceState();
      const result = await mutate(draft);
      await this.writeAtomically(
        this.workspaceStateFile,
        `${JSON.stringify({
          version: 1,
          hiddenWorkspaces: [...draft.hiddenWorkspaces],
          ungroupedSessions: [...draft.ungroupedSessions],
          workspaceNames: Object.fromEntries(draft.workspaceNames),
        })}\n`,
      );
      this.restoreWorkspaceState(draft);
      return result;
    });
    this.workspaceStateWrite = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async ensureArchivesLoaded() {
    if (this.archivesLoaded) return;
    if (!this.archivesLoading) {
      this.archivesLoading = (async () => {
        try {
          const parsed: unknown = JSON.parse(
            await readFile(this.archiveFile, "utf8"),
          );
          if (
            !Array.isArray(parsed) ||
            !parsed.every((path) => typeof path === "string")
          ) {
            throw new Error("Archive metadata must be an array of paths");
          }
          for (const path of parsed) this.archivedSessions.add(resolve(path));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        this.archivesLoaded = true;
      })();
    }
    await this.archivesLoading;
  }

  private enqueueArchiveMutation<T>(
    mutate: (draft: Set<string>) => T | Promise<T>,
  ) {
    const operation = this.archivesWrite.then(async () => {
      const draft = new Set(this.archivedSessions);
      const result = await mutate(draft);
      await this.writeAtomically(
        this.archiveFile,
        `${JSON.stringify([...draft])}\n`,
      );
      this.archivedSessions.clear();
      for (const archivedPath of draft) {
        this.archivedSessions.add(archivedPath);
      }
      return result;
    });
    this.archivesWrite = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async writeAtomically(filePath: string, content: string) {
    const temporary = `${filePath}.tmp-${process.pid}-${++this.writeSequence}`;
    try {
      await writeFile(temporary, content, "utf8");
      await rename(temporary, filePath);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  initialize() {
    this.initialization ??= (async () => {
      await this.ensureWorkspaceStateLoaded();
      if (!this.restoreInitialWorkspace) return;
      await this.enqueueWorkspaceMutation((draft) => {
        draft.restoreInitialWorkspace = false;
        draft.hiddenWorkspaces.delete(resolve(this.runtime.cwd));
        draft.importedWorkspaces.add(resolve(this.runtime.cwd));
      });
    })();
    return this.initialization;
  }

  async importWorkspace(path: string) {
    await this.ensureWorkspaceStateLoaded();
    const canonical = await realpath(resolve(path));
    const info = await stat(canonical);
    if (!info.isDirectory())
      throw new Error("Workspace path is not a directory");
    return this.enqueueWorkspaceMutation((draft) => {
      draft.importedWorkspaces.add(canonical);
      draft.hiddenWorkspaces.delete(canonical);
      return canonical;
    });
  }

  async requireWorkspace(path: string) {
    await this.ensureWorkspaceStateLoaded();
    const canonical = resolve(path);
    const workspaces = await this.workspacePaths();
    if (!workspaces.has(canonical) || this.hiddenWorkspaces.has(canonical)) {
      throw new Error("Workspace is not available");
    }
    return canonical;
  }

  private async requireSelectedWorkspace() {
    await this.ensureWorkspaceStateLoaded();
    const workspace = resolve(this.runtime.cwd);
    if (
      this.runtime.workspaceSelected !== true ||
      this.hiddenWorkspaces.has(workspace)
    ) {
      throw new Error("Workspace is not available");
    }
    return workspace;
  }

  async requireSession(path: string) {
    await this.ensureWorkspaceStateLoaded();
    const sessions = await this.listSessions(path);
    const session = sessions.find((item) => item.path === path);
    if (!session) throw new Error("Session is not available");
    if (!session.ungrouped) {
      const workspace = resolve(session.cwd);
      if (this.hiddenWorkspaces.has(workspace)) {
        throw new Error("Workspace is not available");
      }
    }
    return session;
  }

  async renameWorkspace(path: string, name: string) {
    await this.ensureWorkspaceStateLoaded();
    const canonical = resolve(path);
    const normalized = name.trim();
    if (
      !normalized ||
      normalized.length > 80 ||
      /[\u0000-\u001f\u007f]/.test(normalized)
    ) {
      throw new Error("Workspace name must be 1-80 visible characters");
    }
    return this.enqueueWorkspaceMutation(async (draft) => {
      const workspaces = await this.workspacePaths(undefined, draft);
      if (!workspaces.has(canonical)) {
        throw new Error("Workspace is not available");
      }
      draft.workspaceNames.set(canonical, normalized);
      return normalized;
    });
  }

  async renameSession(path: string, name: string) {
    const session = await this.requireSession(path);
    const normalized = name.trim();
    if (
      !normalized ||
      normalized.length > 80 ||
      /[\u0000-\u001f\u007f]/.test(normalized)
    ) {
      throw new Error("Conversation name must be 1-80 visible characters");
    }
    const manager =
      this.isCurrentSession(session)
        ? this.runtime.sessionManager
        : SessionManager.open(session.path, this.runtime.sessionDirectory);
    manager.appendSessionInfo(normalized);
    return normalized;
  }

  async archiveSession(path: string) {
    await this.ensureArchivesLoaded();
    await this.enqueueArchiveMutation(async (draft) => {
      const session = await this.requireSession(path);
      draft.add(resolve(session.path));
    });
  }

  async listArchivedSessions(options: ArchivedSessionQuery = {}) {
    await this.ensureWorkspaceStateLoaded();
    await this.ensureArchivesLoaded();
    const limit = options.limit ?? 25;
    const query = options.query?.trim() ?? "";
    if (
      !Number.isSafeInteger(limit) ||
      limit <= 0 ||
      limit > WEB_MAX_ARCHIVED_SESSION_PAGE ||
      query.length > WEB_MAX_ARCHIVED_SESSION_QUERY ||
      /[\u0000-\u001f\u007f]/u.test(query) ||
      (options.cursor !== undefined &&
        (options.cursor.length === 0 ||
          options.cursor.length > WEB_MAX_ARCHIVED_SESSION_CURSOR ||
          /[\u0000-\u001f\u007f]/u.test(options.cursor)))
    ) {
      return { status: "invalid" as const };
    }

    const allSessions = await SessionManager.listAll(
      this.runtime.sessionDirectory,
    );
    const scanned = allSessions.slice(0, WEB_MAX_ARCHIVED_SESSION_SCAN);
    const normalizedQuery = query.normalize("NFKC").toLocaleLowerCase();
    if (normalizedQuery.length > WEB_MAX_ARCHIVED_SESSION_QUERY) {
      return { status: "invalid" as const };
    }
    const matches = scanned.filter((session) => {
      if (!this.archivedSessions.has(resolve(session.path))) return false;
      if (!normalizedQuery) return true;
      const source = [
        session.id,
        session.name ?? "",
        session.cwd,
        session.firstMessage.slice(0, 2_000),
      ]
        .join("\n")
        .normalize("NFKC")
        .toLocaleLowerCase();
      return source.includes(normalizedQuery);
    });
    let start = 0;
    if (options.cursor !== undefined) {
      const cursor = decodeArchivedSessionCursor(options.cursor);
      if (!cursor) return { status: "invalid" as const };
      if (cursor.queryHash !== archivedQueryHash(normalizedQuery)) {
        return { status: "stale_cursor" as const };
      }
      const cursorIndex = matches.findIndex(
        (session) => session.path === cursor.sessionPath,
      );
      if (cursorIndex < 0) return { status: "stale_cursor" as const };
      start = cursorIndex + 1;
    }
    const selected = matches.slice(start, start + limit);
    const sessions = selected.map((session) => ({
      id: session.id,
      path: session.path,
      cwd: resolve(session.cwd),
      ...(session.name
        ? { name: boundedText(session.name, WEB_MAX_SESSION_PREVIEW) }
        : {}),
      modified: session.modified.toISOString(),
      created: session.created.toISOString(),
      messageCount: session.messageCount,
      firstMessage: boundedText(
        session.firstMessage,
        WEB_MAX_SESSION_PREVIEW,
      ),
      archived: true,
      ...(this.ungroupedSessions.has(resolve(session.path))
        ? { ungrouped: true }
        : {}),
    }));
    const pageEnd = start + sessions.length;
    const hasMoreMatches = pageEnd < matches.length;
    const recordsUnscanned = Math.max(0, allSessions.length - scanned.length);
    return {
      status: "ok" as const,
      sessions,
      ...(hasMoreMatches && sessions.length > 0
        ? {
            nextCursor: encodeArchivedSessionCursor({
              version: 1,
              sessionPath: sessions.at(-1)!.path,
              queryHash: archivedQueryHash(normalizedQuery),
            }),
          }
        : {}),
      truncation: {
        truncated: hasMoreMatches || recordsUnscanned > 0,
        matchesOmitted: Math.max(0, matches.length - pageEnd),
        recordsUnscanned,
        maxPageSize: WEB_MAX_ARCHIVED_SESSION_PAGE,
        maxScanned: WEB_MAX_ARCHIVED_SESSION_SCAN,
      },
    };
  }

  async unarchiveSession(path: string) {
    await this.ensureArchivesLoaded();
    await this.enqueueArchiveMutation(async (draft) => {
      const session = await this.requireSession(path);
      draft.delete(resolve(session.path));
    });
  }

  async removeWorkspace(path: string) {
    await this.ensureWorkspaceStateLoaded();
    const canonical = resolve(path);
    await this.enqueueWorkspaceMutation(async (draft) => {
      const workspaces = await this.workspacePaths(undefined, draft);
      if (!workspaces.has(canonical)) {
        throw new Error("Workspace is not available");
      }
      const sessions = await SessionManager.listAll(this.runtime.sessionDirectory);
      for (const session of sessions) {
        if (resolve(session.cwd) === canonical) {
          draft.ungroupedSessions.add(resolve(session.path));
        }
      }
      if (resolve(this.runtime.cwd) === canonical) {
        const currentPath =
          this.runtime.sessionManager.getSessionFile() ??
          `current:${this.runtime.sessionManager.getSessionId()}`;
        draft.ungroupedSessions.add(resolve(currentPath));
      }
      draft.importedWorkspaces.delete(canonical);
      draft.workspaceNames.delete(canonical);
      draft.hiddenWorkspaces.add(canonical);
      draft.restoreInitialWorkspace = false;
    });
  }

  async listSessionProjection(pinnedPath?: string) {
    await this.ensureWorkspaceStateLoaded();
    await this.ensureArchivesLoaded();
    const allSessions = await SessionManager.listAll(
      this.runtime.sessionDirectory,
    );
    // Pi already returns this list newest-first. The scan remains Pi-owned;
    // only the Web projection below is retained and bounded.
    const sorted = allSessions;
    const currentId = this.runtime.sessionManager.getSessionId();
    const pinned = new Set(
      sorted
        .filter(
          (session) =>
            this.isCurrentSession(session) ||
            (pinnedPath !== undefined && session.path === pinnedPath),
        )
        .map((session) => session.path),
    );
    const retainedPaths = new Set(pinned);
    for (const session of sorted) {
      if (retainedPaths.size >= WEB_MAX_SESSIONS) break;
      retainedPaths.add(session.path);
    }
    const projected = sorted
      .filter((session) => retainedPaths.has(session.path))
      .map((session) => ({
        id: session.id,
        path: session.path,
        cwd: resolve(session.cwd),
        source: "web-session" as const,
        origin: "web" as const,
        controller: this.isCurrentSession(session) ? ("web" as const) : ("none" as const),
        readOnly: false as const,
        ...(session.name
          ? { name: boundedText(session.name, WEB_MAX_SESSION_PREVIEW) }
          : {}),
        modified: session.modified.toISOString(),
        created: session.created.toISOString(),
        messageCount: session.messageCount,
        firstMessage: boundedText(
          session.firstMessage,
          WEB_MAX_SESSION_PREVIEW,
        ),
        ...(this.archivedSessions.has(resolve(session.path)) ? { archived: true } : {}),
        ...(this.ungroupedSessions.has(resolve(session.path)) ? { ungrouped: true } : {}),
      }));
    if (
      this.runtime.workspaceSelected === true &&
      !projected.some((session) => this.isCurrentSession(session))
    ) {
      const entries = this.runtime.sessionManager.getBranch();
      let firstUser = "";
      let messageCount = 0;
      for (const entry of entries) {
        if (entry.type !== "message") continue;
        messageCount++;
        if (!firstUser) {
          const projectedEntry = projectEntry(entry);
          if (projectedEntry.message?.role === "user") {
            firstUser = projectedEntry.message.content;
          }
        }
      }
      const now = new Date().toISOString();
      const currentPath =
        this.runtime.sessionManager.getSessionFile() ?? `current:${currentId}`;
      projected.unshift({
        id: currentId,
        path: currentPath,
        cwd: resolve(this.runtime.cwd),
        source: "web-session" as const,
        origin: "web" as const,
        controller: "web" as const,
        readOnly: false as const,
        ...(this.runtime.sessionManager.getSessionName()
          ? {
              name: boundedText(
                this.runtime.sessionManager.getSessionName()!,
                WEB_MAX_SESSION_PREVIEW,
              ),
            }
          : {}),
        modified: now,
        created: now,
        messageCount,
        firstMessage: boundedText(firstUser, WEB_MAX_SESSION_PREVIEW),
        ...(this.archivedSessions.has(resolve(currentPath))
          ? { archived: true }
          : {}),
        ...(this.ungroupedSessions.has(resolve(currentPath))
          ? { ungrouped: true }
          : {}),
      });
      if (projected.length > WEB_MAX_SESSIONS) {
        let removeAt = projected.length - 1;
        while (
          removeAt > 0 &&
          pinnedPath !== undefined &&
          projected[removeAt]?.path === pinnedPath
        ) {
          removeAt--;
        }
        projected.splice(removeAt, 1);
      }
    }
    return {
      sessions: projected,
      omitted: Math.max(
        0,
        allSessions.length +
          (allSessions.some((session) => this.isCurrentSession(session)) ||
          this.runtime.workspaceSelected !== true
            ? 0
            : 1) -
          projected.length,
      ),
    };
  }

  async listSessions(pinnedPath?: string): Promise<WebSessionSummary[]> {
    return (await this.listSessionProjection(pinnedPath)).sessions;
  }

  async listReadOnlyTerminalSessions(
    options: { query?: string; cursor?: number; limit?: number; signal?: AbortSignal } = {},
  ) {
    options.signal?.throwIfAborted();
    const workspace = await this.requireSelectedWorkspace();
    const query = options.query?.trim().toLocaleLowerCase() ?? "";
    const cursor = options.cursor ?? 0;
    const limit = options.limit ?? 50;
    const discovery = await listTerminalSessionInfo(workspace, options.signal);
    const sessions = discovery.sessions
      .filter((session) => {
        if (!query) return true;
        return [session.name, session.cwd, session.firstMessage].some((value) =>
          value?.toLocaleLowerCase().includes(query),
        );
      });
    options.signal?.throwIfAborted();
    const page = sessions.slice(cursor, cursor + limit);
    return {
      sessions: page.map((session) => ({
        id: session.id,
        path: session.path,
        cwd: resolve(session.cwd),
        ...(session.name
          ? { name: boundedText(session.name, WEB_MAX_SESSION_PREVIEW) }
          : {}),
        modified: session.modified.toISOString(),
        created: session.created.toISOString(),
        messageCount: session.messageCount,
        metadataPartial: session.metadataPartial,
        firstMessage: boundedText(
          session.firstMessage,
          WEB_MAX_SESSION_PREVIEW,
        ),
        source: "pi-default" as const,
        origin: "terminal" as const,
        readOnly: true as const,
      })),
      cursor,
      nextCursor:
        cursor + page.length < sessions.length
          ? cursor + page.length
          : undefined,
      total: sessions.length,
      partial: discovery.partial,
    };
  }

  async getReadOnlyTerminalSession(path: string, options: { signal?: AbortSignal } = {}) {
    options.signal?.throwIfAborted();
    const workspace = await this.requireSelectedWorkspace();
    const canonical = resolve(path);
    const directory = defaultTerminalSessionDirectory(workspace);
    let session: ReadOnlyTerminalSessionInfo | undefined;
    if (containedPath(directory, canonical)) {
      try {
        session = await readTerminalSessionInfo(
          canonical,
          (await stat(canonical)).mtime,
          options.signal,
        );
      } catch {
        options.signal?.throwIfAborted();
        session = undefined;
      }
    }
    if (!session) {
      throw new WebReadOnlySessionError("Terminal Session is not available");
    }
    if (session.cwd !== workspace) {
      throw new WebReadOnlySessionError("Terminal Session is not available");
    }
    const preview = await loadSessionPreviewData(session.path, options);
    options.signal?.throwIfAborted();
    return {
      id: session.id,
      path: session.path,
      cwd: resolve(session.cwd),
      ...(session.name
        ? { name: boundedText(session.name, WEB_MAX_SESSION_PREVIEW) }
        : {}),
      modified: session.modified.toISOString(),
      created: session.created.toISOString(),
      messageCount: session.messageCount,
      metadataPartial: session.metadataPartial,
      firstMessage: boundedText(
        session.firstMessage,
        WEB_MAX_SESSION_PREVIEW,
      ),
      source: "pi-default" as const,
      origin: "terminal" as const,
      readOnly: true as const,
      preview: {
        messages: preview.messages,
        totalMessages: preview.totalMessages,
        bytesRead: preview.bytesRead,
        retainedBytes: preview.retainedBytes,
        truncatedBytes: preview.truncatedBytes,
      },
    };
  }

  async getSnapshot(selectedPath?: string, historyAnchor?: { sessionId: string; entryId: string }) {
    await this.ensureWorkspaceStateLoaded();
    const sessionProjection = await this.listSessionProjection(selectedPath);
    const sessions = sessionProjection.sessions;
    const currentCwd = resolve(this.runtime.cwd);
    const workspacePaths = await this.workspacePaths(sessions);
    const retainedWorkspacePaths: string[] = [];
    let visibleWorkspaceCount = 0;
    for (const workspacePath of workspacePaths) {
      if (this.hiddenWorkspaces.has(workspacePath)) continue;
      visibleWorkspaceCount++;
      if (retainedWorkspacePaths.length < WEB_MAX_WORKSPACES) {
        retainedWorkspacePaths.push(workspacePath);
      }
    }
    const workspaces: WebWorkspaceSummary[] = retainedWorkspacePaths
      .map((path) => ({
        path,
        name: (this.workspaceNames.get(path) ?? basename(path)) || path,
        current:
          this.runtime.workspaceSelected === true && path === currentCwd,
      }))
      .sort((left, right) =>
        left.current === right.current
          ? left.name.localeCompare(right.name)
          : left.current
            ? -1
            : 1,
      );
    const path =
      selectedPath ??
      sessions.find(
        (session) => this.isCurrentSession(session),
      )?.path;
    const selectedSession = path
      ? await this.getSession(path, sessions, historyAnchor)
      : undefined;
    const usage =
      selectedSession && this.isCurrentSession(selectedSession)
        ? this.runtime.getSessionUsage?.()
        : undefined;
    const allModels = this.runtime.listModels();
    const currentModel = allModels.find((model) => model.current);
    const retainedModels = currentModel ? [currentModel] : [];
    for (const model of allModels) {
      if (retainedModels.length >= WEB_MAX_MODELS) break;
      if (model !== currentModel) retainedModels.push(model);
    }
    const models = retainedModels.map((model) => ({
      ...model,
      provider: boundedText(model.provider, WEB_MAX_SESSION_PREVIEW),
      id: boundedText(model.id, WEB_MAX_SESSION_PREVIEW),
      name: boundedText(model.name, WEB_MAX_SESSION_PREVIEW),
      label: boundedText(model.label, WEB_MAX_SESSION_PREVIEW),
    }));
    const thinking = this.safeThinking();
    const selectedExecution = selectedSession
      ? this.runtime.getSessionExecution?.(selectedSession.id, selectedSession.path)
      : undefined;
    const snapshot = {
      ...(this.runtime.workspaceSelected === true
        ? { currentSessionId: this.runtime.sessionManager.getSessionId(),
            currentSessionPath: this.runtime.sessionManager.getSessionFile() ?? `current:${this.runtime.sessionManager.getSessionId()}` }
        : {}),
      workspaces,
      sessions,
      models,
      ...(thinking ? { thinking } : {}),
      ...(selectedSession ? { selectedSession } : {}),
      ...(selectedExecution ? { selectedExecution } : {}),
      ...(usage ? { usage } : {}),
      runtime: {
        status: this.runtime.isIdle()
          ? ("idle" as const)
          : ("running" as const),
        ...(this.runtime.getActiveTurn()
          ? { activeTurn: this.runtime.getActiveTurn() }
          : {}),
        capabilities: webCapabilitySnapshot(this.runtime.sessionManager),
      },
      truncation: {
        truncated:
          sessionProjection.omitted > 0 ||
          visibleWorkspaceCount > workspaces.length ||
          allModels.length > models.length ||
          selectedSession?.truncation.truncated === true,
        sessionsOmitted: sessionProjection.omitted,
        workspacesOmitted: visibleWorkspaceCount - workspaces.length,
        modelsOmitted: allModels.length - models.length,
        maxBytes: WEB_MAX_SNAPSHOT_BYTES,
        bytes: 0,
      } satisfies WebSnapshotTruncation,
    };
    this.fitSnapshot(snapshot);
    snapshot.truncation.bytes = jsonByteLength(snapshot);
    return snapshot;
  }

  private fitSnapshot(snapshot: {
    currentSessionId?: string;
    workspaces: WebWorkspaceSummary[];
    sessions: WebSessionSummary[];
    selectedSession?: WebSessionProjection;
    models: ReturnType<WebRuntimeController["listModels"]>;
    truncation: WebSnapshotTruncation;
  }) {
    const targetBytes = WEB_MAX_SNAPSHOT_BYTES - 1_024;
    let bytes = jsonByteLength(snapshot);
    if (bytes <= targetBytes) return;

    const selected = snapshot.selectedSession;
    if (selected && selected.entries.length > 0) {
      let removed = 0;
      while (selected.entries.length > 1 && bytes > targetBytes) {
        const entry = selected.entries.shift();
        if (!entry) break;
        removed++;
        bytes -= jsonByteLength(entry) + 1;
      }
      const totalEntries = selected.truncation.entriesOmitted + removed + selected.entries.length;
      if (removed > 0) alignHistoryPage(selected, totalEntries);
      let messagePartsOmitted = 0;
      let messagesTruncated = 0;
      for (const entry of selected.entries) {
        if (entry.type !== "message" || !entry.message?.truncation) continue;
        messagesTruncated++;
        messagePartsOmitted += entry.message.truncation.partsOmitted ?? 0;
      }
      selected.bytes = jsonByteLength(selected.entries);
      selected.truncation = {
        ...selected.truncation,
        truncated: true,
        entriesOmitted: totalEntries - selected.entries.length,
        messagePartsOmitted,
        messagesTruncated,
      };
      if (selected.history) selected.history.beforeEntryId = selected.entries[0]?.id ?? null;
    }

    const selectedPath = selected?.path;
    bytes = jsonByteLength(snapshot);
    while (bytes > targetBytes && snapshot.sessions.length > 1) {
      let index = -1;
      for (let candidate = snapshot.sessions.length - 1; candidate >= 0; candidate--) {
        const session = snapshot.sessions[candidate]!;
        if (
          !this.isCurrentSession(session) &&
          session.path !== selectedPath
        ) {
          index = candidate;
          break;
        }
      }
      if (index < 0) break;
      const [removed] = snapshot.sessions.splice(index, 1);
      if (removed) bytes -= jsonByteLength(removed) + 1;
      snapshot.truncation.sessionsOmitted++;
    }
    bytes = jsonByteLength(snapshot);
    while (bytes > targetBytes && snapshot.workspaces.length > 1) {
      let index = -1;
      for (let candidate = snapshot.workspaces.length - 1; candidate >= 0; candidate--) {
        if (!snapshot.workspaces[candidate]!.current) {
          index = candidate;
          break;
        }
      }
      if (index < 0) break;
      const [removed] = snapshot.workspaces.splice(index, 1);
      if (removed) bytes -= jsonByteLength(removed) + 1;
      snapshot.truncation.workspacesOmitted++;
    }
    bytes = jsonByteLength(snapshot);
    while (bytes > targetBytes && snapshot.models.length > 1) {
      let index = -1;
      for (let candidate = snapshot.models.length - 1; candidate >= 0; candidate--) {
        if (!snapshot.models[candidate]!.current) {
          index = candidate;
          break;
        }
      }
      if (index < 0) break;
      const [removed] = snapshot.models.splice(index, 1);
      if (removed) bytes -= jsonByteLength(removed) + 1;
      snapshot.truncation.modelsOmitted++;
    }
    snapshot.truncation.truncated = true;
  }

  private safeThinking(): WebThinkingProjection | undefined {
    if (!this.runtime.getThinkingState) return undefined;
    try {
      return boundThinkingProjection(this.runtime.getThinkingState());
    } catch {
      // An optional diagnostic must never break /api/snapshot.
      return undefined;
    }
  }

  private captureWorkspaceState(): WorkspaceStateSnapshot {
    return {
      importedWorkspaces: new Set(this.importedWorkspaces),
      hiddenWorkspaces: new Set(this.hiddenWorkspaces),
      workspaceNames: new Map(this.workspaceNames),
      ungroupedSessions: new Set(this.ungroupedSessions),
      restoreInitialWorkspace: this.restoreInitialWorkspace,
    };
  }

  private restoreWorkspaceState(state: WorkspaceStateSnapshot) {
    this.importedWorkspaces.clear();
    for (const path of state.importedWorkspaces) this.importedWorkspaces.add(path);
    this.hiddenWorkspaces.clear();
    for (const path of state.hiddenWorkspaces) this.hiddenWorkspaces.add(path);
    this.workspaceNames.clear();
    for (const [path, name] of state.workspaceNames) {
      this.workspaceNames.set(path, name);
    }
    this.ungroupedSessions.clear();
    for (const path of state.ungroupedSessions) {
      this.ungroupedSessions.add(path);
    }
    this.restoreInitialWorkspace = state.restoreInitialWorkspace;
  }

  private async workspacePaths(
    knownSessions?: WebSessionSummary[],
    workspaceState?: WorkspaceStateSnapshot,
  ) {
    const sessions = knownSessions ?? (await this.listSessions());
    return new Set([
      ...(this.runtime.workspaceSelected === true
        ? [resolve(this.runtime.cwd)]
        : []),
      ...(workspaceState?.importedWorkspaces ?? this.importedWorkspaces),
      ...sessions.map((session) => session.cwd),
    ]);
  }

  isCurrentSession(session: Pick<WebSessionSummary, "id" | "path">) {
    // A copied JSONL retains its ID, but does not own the active runtime.
    return matchesSessionIdentity(this.runtime.sessionManager, {
      expectedSessionId: session.id,
      expectedSessionPath: session.path,
    });
  }

  async getSession(
    path: string,
    knownSessions?: WebSessionSummary[],
    historyAnchor?: { sessionId: string; entryId: string },
  ): Promise<WebSessionProjection | undefined> {
    const sessions = knownSessions ?? (await this.listSessions(path));
    const summary = sessions.find((session) => session.path === path);
    if (!summary) return undefined;

    const manager =
      this.runtime.getSessionManagerForRead?.(summary.id, summary.path) ??
      (this.isCurrentSession(summary)
        ? this.runtime.sessionManager
        : SessionManager.open(path));
    const branch = manager.getBranch();
    const projected = alignHistoryPage(
      projectEntries(branch, (path) => resolve(summary.cwd, path)),
      branch.length,
    );
    return {
      id: summary.id,
      path: summary.path,
      cwd: summary.cwd,
      ...projected,
      history: {
        leafEntryId: manager.getLeafId(),
        beforeEntryId: projected.truncation.entriesOmitted > 0 ? projected.entries[0]?.id ?? null : null,
        ...(historyAnchor ? {
          anchorEntryId: historyAnchor.entryId,
          anchorOnBranch: historyAnchor.sessionId === summary.id && manager.getSessionId() === historyAnchor.sessionId && branch.some((entry) => entry.id === historyAnchor.entryId),
        } : {}),
      },
    };
  }

  async getSessionHistory(sessionId: string, path: string, anchorEntryId: string, beforeEntryId: string) {
    const summary = (await this.listSessions(path)).find((session) => session.path === path);
    if (!summary) return { status: "not_found" as const };
    const manager = this.runtime.getSessionManagerForRead?.(summary.id, summary.path) ??
      (this.isCurrentSession(summary) ? this.runtime.sessionManager : SessionManager.open(path));
    if (manager.getSessionId() !== sessionId || summary.id !== sessionId)
      return { status: "changed" as const };
    const branch = manager.getBranch();
    const anchor = branch.findIndex((entry) => entry.id === anchorEntryId);
    const before = branch.findIndex((entry) => entry.id === beforeEntryId);
    if (anchor < 0 || before < 0 || before > anchor) return { status: "changed" as const };
    const prefix = branch.slice(0, before);
    const projectionBudget = WEB_MAX_SELECTED_TRANSCRIPT_BYTES -
      jsonByteLength({ id: summary.id, path: summary.path, cwd: summary.cwd, anchorEntryId, requestedBeforeEntryId: beforeEntryId }) - 2048;
    const projected = alignHistoryPage(
      projectEntries(prefix, (file) => resolve(summary.cwd, file), projectionBudget),
      prefix.length,
    );
    const session: WebSessionHistoryPage = {
      id: summary.id, path: summary.path, cwd: summary.cwd,
      anchorEntryId, requestedBeforeEntryId: beforeEntryId,
      ...projected,
      history: { leafEntryId: manager.getLeafId(), beforeEntryId: projected.truncation.entriesOmitted > 0 ? projected.entries[0]?.id ?? null : null, anchorEntryId, anchorOnBranch: true },
    };
    // The complete response, not only the entry array, shares the transcript budget.
    while (session.entries.length > 0 && jsonByteLength({ session }) > WEB_MAX_SELECTED_TRANSCRIPT_BYTES) {
      const removed = session.entries.shift();
      session.truncation = {
        ...session.truncation,
        truncated: true,
        entriesOmitted: session.truncation.entriesOmitted + 1,
        messagesTruncated: session.truncation.messagesTruncated - (removed?.message?.truncation ? 1 : 0),
        messagePartsOmitted: session.truncation.messagePartsOmitted - (removed?.message?.truncation?.partsOmitted ?? 0),
      };
      session.history!.beforeEntryId = session.entries[0]?.id ?? null;
    }
    alignHistoryPage(session, prefix.length);
    session.bytes = jsonByteLength(session.entries);
    session.history!.beforeEntryId = session.truncation.entriesOmitted > 0
      ? session.entries[0]?.id ?? null : null;
    return { status: "ok" as const, session };
  }

  async getTurnChanges(
    sessionId: string,
    path: string,
    promptEntryId: string,
    filePath?: string,
  ): Promise<WebTurnChangesResult> {
    const summary = (await this.listSessions(path)).find((session) => session.path === path);
    if (!summary) return { ok: false, reason: "not_found" };
    const manager = this.runtime.getSessionManagerForRead?.(summary.id, summary.path) ??
      (this.isCurrentSession(summary) ? this.runtime.sessionManager : SessionManager.open(path));
    if (summary.id !== sessionId || manager.getSessionId() !== sessionId)
      return { ok: false, reason: "identity_changed" };
    const branch = manager.getBranch();
    const prompt = branch.findIndex((entry) =>
      entry.id === promptEntryId && entry.type === "message" && entry.message.role === "user"
    );
    if (prompt < 0) return { ok: false, reason: "identity_changed" };
    const following = branch.slice(prompt + 1);
    const nextPrompt = following.findIndex((entry) => entry.type === "message" && entry.message.role === "user");
    const turn = nextPrompt < 0 ? following : following.slice(0, nextPrompt);
    const changes = turn.find((entry) => {
      if (entry.type !== "custom" || entry.customType !== WEB_TURN_CHANGES_ENTRY) return false;
      const detail = readTurnChangesDetail(entry.data);
      return detail?.promptEntryId === promptEntryId && detail.sessionId === sessionId;
    });
    const detail = changes?.type === "custom" ? readTurnChangesDetail(changes.data) : undefined;
    if (!detail) return { ok: false, reason: "not_found" };
    if (detail.state === "unavailable") return { ok: false, reason: "unavailable" };
    if (filePath) {
      const file = detail.files.find((item) => item.path === filePath);
      if (!file) return { ok: false, reason: "not_found" };
      return { ok: true, changes: { ...detail, files: [file] } };
    }
    return { ok: true, changes: detail };
  }

  async getSessionItem(sessionId: string, path: string, entryId: string, cursor: number) {
    const summary = (await this.listSessions(path)).find((session) => session.path === path);
    if (!summary) return { status: "not_found" as const };
    const manager = this.runtime.getSessionManagerForRead?.(summary.id, summary.path) ??
      (this.isCurrentSession(summary) ? this.runtime.sessionManager : SessionManager.open(path));
    if (summary.id !== sessionId || manager.getSessionId() !== sessionId)
      return { status: "changed" as const };
    const entry = manager.getBranch().find((item) => item.id === entryId);
    if (!entry) return { status: "changed" as const };
    let content: unknown;
    if (entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant"))
      content = entry.message.content;
    else if (entry.type === "custom" && entry.customType === WEB_COMMAND_INPUT &&
      entry.data && typeof entry.data === "object" && "text" in entry.data)
      content = entry.data.text;
    else return { status: "changed" as const };
    const page = visibleTextPage(content, cursor);
    return page ? { status: "ok" as const, page: { entryId, ...page } }
      : { status: "invalid_cursor" as const };
  }
}
