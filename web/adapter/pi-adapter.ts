import { createHash, randomUUID } from "node:crypto";
import { readMessageRerun } from "../protocol/message-rerun.ts";
import { readSessionFork } from "../protocol/session-fork.ts";
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
import { isBoundedReadyPlan } from "../../extensions/plan-mode/persisted-state.ts";
import { webCapabilitySnapshot } from "../../extensions/shared/web-observer-registry.ts";
import {
  boundedText,
  boundThinkingProjection,
  jsonByteLength,
  projectEntries,
  projectEntry,
  WEB_MAX_MODELS,
  WEB_MAX_ENTRIES,
  WEB_MAX_ARCHIVED_SESSION_PAGE,
  WEB_MAX_ARCHIVED_SESSION_CURSOR,
  WEB_MAX_ARCHIVED_SESSION_QUERY,
  WEB_MAX_ARCHIVED_SESSION_SCAN,
  WEB_MAX_ARCHIVED_SESSION_CWD,
  WEB_MAX_SESSIONS,
  WEB_MAX_SESSION_PREVIEW,
  WEB_MAX_SNAPSHOT_BYTES,
  WEB_MAX_SELECTED_TRANSCRIPT_BYTES,
  WEB_MAX_PROMPT_HISTORY_PAGE,
  WEB_MAX_PROMPT_PREVIEW_CHARS,
  WEB_MAX_WORKSPACES,
  WEB_PROMPT_IMAGE_MAX_BYTES,
  WEB_PROMPT_IMAGE_MAX_BASE64_CHARS,
  type WebSessionProjection,
  type WebArchivedSessionQuery,
  type WebSessionHistoryPage,
  type WebSessionPromptHistoryPage,
  type WebSessionPromptPreview,
  type WebSessionSummary,
  type WebSidebarPinTarget,
  type WebSnapshotTruncation,
  type WebWorkspaceSummary,
} from "../protocol/types.ts";
import type {
  WebRuntimeController,
  WebThinkingProjection,
} from "../runtime/types.ts";
import { matchesSessionIdentity } from "../runtime/session-identity.ts";
import { WebRuntimeRequestError } from "../runtime/types.ts";
import { WEB_TURN_TIMING_ENTRY, readSessionTurnEvidence, readTurnTiming } from "../protocol/turn-timing.ts";
import { searchWebTranscripts } from "../search/transcript-search.ts";
import { collectSessionSources } from "./session-sources.ts";
import { isSessionPrompt, setupDisplayMessage } from "../protocol/prompt-navigation.ts";
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

type SessionIdentity = { path: string; id: string };
type ReadTurn = { commandId: string; finishedAt: number };
type SessionReadState = SessionIdentity & { read: boolean; revision?: string; lastReadTurn?: ReadTurn };
const MAX_SIDEBAR_METADATA_ENTRIES = 5_000;
export const WEB_SESSION_MARKDOWN_MAX_BYTES = 10 * 1024 * 1024;

function isSessionIdentity(value: unknown): value is SessionIdentity {
  return Boolean(value && typeof value === "object" && "path" in value && "id" in value && typeof value.path === "string" && value.path.length > 0 && value.path.length <= 4096 && typeof value.id === "string" && value.id.length > 0 && value.id.length <= 500);
}

function isReadTurn(value: unknown): value is ReadTurn {
  return Boolean(value && typeof value === "object" && "commandId" in value && "finishedAt" in value && typeof value.commandId === "string" && value.commandId.length > 0 && value.commandId.length <= 500 && Number.isSafeInteger(value.finishedAt) && Number(value.finishedAt) >= 0);
}

function sameReadTurn(left: ReadTurn | undefined, right: ReadTurn | undefined) {
  return left?.commandId === right?.commandId && left?.finishedAt === right?.finishedAt;
}

function sessionReadRevision(session: SessionIdentity, reading: SessionReadState | undefined, lastResult: ReadTurn | undefined) {
  // Equality token for native results and operator edits; reads never write.
  return createHash("sha256").update(JSON.stringify([session.path, session.id, reading?.revision, reading?.read, reading?.lastReadTurn, lastResult?.commandId, lastResult?.finishedAt])).digest("hex");
}

function sameSidebarPin(left: WebSidebarPinTarget, right: WebSidebarPinTarget) {
  return left.kind === right.kind && left.path === right.path && (left.kind !== "session" || right.kind === "session" && left.id === right.id);
}

type WorkspaceStateSnapshot = {
  sidebarPins: WebSidebarPinTarget[];
  workspaceOrder: string[];
  sessionOrder: SessionIdentity[];
  sessionReadStates: SessionReadState[];
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

function promptPreviewText(content: unknown) {
  const segments = visibleTextSegments(content);
  while (segments.length && segments[0]!.trim().length === 0) segments.shift();
  while (segments.length && segments.at(-1)!.trim().length === 0) segments.pop();
  if (segments.length) {
    segments[0] = segments[0]!.trimStart();
    segments[segments.length - 1] = segments.at(-1)!.trimEnd();
  }
  let text = "";
  let characters = 0;
  let lastCharacter = "";
  for (const part of segments) {
    for (const character of part) {
      if (characters === WEB_MAX_PROMPT_PREVIEW_CHARS) return text.slice(0, -lastCharacter.length) + "…";
      text += character;
      lastCharacter = character;
      characters++;
    }
  }
  return text;
}

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

export type ArchivedSessionQuery = WebArchivedSessionQuery;

type ArchivedSessionCursor =
  | {
      readonly version: 1;
      readonly sessionPath: string;
      readonly queryHash: string;
    }
  | {
      readonly version: 2;
      readonly sessionPathHash: string;
      readonly queryHash: string;
    };

function encodeArchivedSessionCursor(cursor: ArchivedSessionCursor) {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function archivedQueryHash(query: string, sort: "updated" | "created", cwd?: string) {
  // Preserve cursors from the original default query. NUL cannot occur in a
  // valid query, so scoped hashes cannot collide with that legacy encoding.
  const scope = sort === "updated" && cwd === undefined
    ? query
    : `\0${JSON.stringify([query, sort, cwd ?? null])}`;
  return createHash("sha256").update(scope).digest("hex");
}

function decodeArchivedSessionCursor(value: string) {
  try {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) return undefined;
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return undefined;
    }
    const cursor = parsed as Record<string, unknown>;
    if (
      typeof cursor.queryHash !== "string" ||
      !/^[0-9a-f]{64}$/u.test(cursor.queryHash)
    ) return undefined;
    if (cursor.version === 1) {
      if (
        typeof cursor.sessionPath !== "string" ||
        cursor.sessionPath.length === 0 ||
        cursor.sessionPath.length > 320
      ) return undefined;
    } else if (cursor.version === 2) {
      if (
        typeof cursor.sessionPathHash !== "string" ||
        !/^[0-9a-f]{64}$/u.test(cursor.sessionPathHash)
      ) return undefined;
    } else {
      return undefined;
    }
    return parsed as ArchivedSessionCursor;
  } catch {
    return undefined;
  }
}

export class PiWebAdapter {
  private sidebarPins: WebSidebarPinTarget[] = [];
  private workspaceOrder: string[] = [];
  private sessionOrder: SessionIdentity[] = [];
  private sessionReadStates: SessionReadState[] = [];
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
      this.importedWorkspaces.add(this.currentProjectPath());
    }
  }

  private async ensureWorkspaceStateLoaded() {
    if (this.workspaceStateLoaded) return;
    if (!this.workspaceStateLoading) {
      this.workspaceStateLoading = (async () => {
        const draft = this.captureWorkspaceState();
        try {
          const parsed: unknown = JSON.parse(
            await readFile(this.workspaceStateFile, "utf8"),
          );
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error("Workspace metadata must be an object");
          }
          const state = parsed as Record<string, unknown>;
          if (state.sidebarPins !== undefined) {
            if (!Array.isArray(state.sidebarPins) || state.sidebarPins.length > 100 || !state.sidebarPins.every((pin) => pin && typeof pin === "object" && (pin.kind === "session" ? isSessionIdentity(pin) : pin.kind === "workspace" && typeof pin.path === "string" && pin.path.length > 0 && pin.path.length <= 4096))) throw new Error("Sidebar pins have an invalid shape");
            draft.sidebarPins = state.sidebarPins.map((pin: WebSidebarPinTarget) => pin.kind === "session" ? { kind: pin.kind, path: pin.path, id: pin.id } : { kind: pin.kind, path: resolve(pin.path) });
          } else if (state.sessionPins !== undefined) {
            if (!Array.isArray(state.sessionPins) || state.sessionPins.length > 100 ||
              !state.sessionPins.every((pin) => pin && typeof pin.path === "string" && typeof pin.id === "string")) {
              throw new Error("Session pins have an invalid shape");
            }
            draft.sidebarPins = state.sessionPins.map((pin) => ({ kind: "session", path: pin.path, id: pin.id }));
          }
          if (state.importedWorkspaces !== undefined) {
            const paths = state.importedWorkspaces;
            if (!Array.isArray(paths) || paths.length > MAX_SIDEBAR_METADATA_ENTRIES || !paths.every((path) => typeof path === "string" && path.length > 0 && path.length <= 4096)) throw new Error("Workspace paths have an invalid shape");
            for (const path of paths) draft.importedWorkspaces.add(resolve(path));
          }
          if (state.sessionOrder !== undefined) {
            if (!Array.isArray(state.sessionOrder) || state.sessionOrder.length > MAX_SIDEBAR_METADATA_ENTRIES || !state.sessionOrder.every(isSessionIdentity)) throw new Error("Session order has an invalid shape");
            draft.sessionOrder = state.sessionOrder.map(({ path, id }) => ({ path, id }));
          }
          if (state.workspaceOrder !== undefined) {
            if (!Array.isArray(state.workspaceOrder) || state.workspaceOrder.length > MAX_SIDEBAR_METADATA_ENTRIES || !state.workspaceOrder.every((path) => typeof path === "string" && isAbsolute(path) && path.length <= 4096 && !/[\u0000-\u001f\u007f]/u.test(path)) || new Set(state.workspaceOrder.map((path) => resolve(path))).size !== state.workspaceOrder.length) throw new Error("Workspace order has an invalid shape");
            draft.workspaceOrder = state.workspaceOrder.map((path) => resolve(path));
          }
          if (state.sessionReadStates !== undefined) {
            if (!Array.isArray(state.sessionReadStates) || state.sessionReadStates.length > MAX_SIDEBAR_METADATA_ENTRIES || !state.sessionReadStates.every((item) => isSessionIdentity(item) && "read" in item && typeof item.read === "boolean" && (!("revision" in item) || typeof item.revision === "string" && item.revision.length > 0 && item.revision.length <= 200) && (!("lastReadTurn" in item) || isReadTurn(item.lastReadTurn)))) throw new Error("Session reading state has an invalid shape");
            draft.sessionReadStates = state.sessionReadStates.map((item: SessionReadState) => ({ path: item.path, id: item.id, read: item.read, ...(item.revision ? { revision: item.revision } : {}), ...(item.lastReadTurn ? { lastReadTurn: { ...item.lastReadTurn } } : {}) }));
          }
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
            draft.hiddenWorkspaces.add(resolve(path));
          }
          for (const path of state.ungroupedSessions) {
            draft.ungroupedSessions.add(resolve(path));
          }
          for (const [path, name] of Object.entries(state.workspaceNames)) {
            draft.workspaceNames.set(resolve(path), name as string);
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        draft.restoreInitialWorkspace =
          this.runtime.workspaceSelected === true &&
          draft.hiddenWorkspaces.has(resolve(this.runtime.cwd));
        this.restoreWorkspaceState(draft);
        this.workspaceStateLoaded = true;
      })();
    }
    const loading = this.workspaceStateLoading;
    try {
      await loading;
    } catch (error) {
      if (this.workspaceStateLoading === loading) this.workspaceStateLoading = undefined;
      throw error;
    }
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
          sidebarPins: draft.sidebarPins,
          workspaceOrder: draft.workspaceOrder,
          sessionOrder: draft.sessionOrder,
          sessionReadStates: draft.sessionReadStates,
          importedWorkspaces: [...draft.importedWorkspaces],
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
    const loading = this.archivesLoading;
    try {
      await loading;
    } catch (error) {
      // A failed read must remain fail-closed without poisoning later retries.
      if (this.archivesLoading === loading) this.archivesLoading = undefined;
      throw error;
    }
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
        draft.importedWorkspaces.add(this.currentProjectPath());
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
      if (draft.importedWorkspaces.size > MAX_SIDEBAR_METADATA_ENTRIES) throw new Error("Imported projects exceed their metadata limit");
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
      this.hiddenWorkspaces.has(this.currentProjectPath())
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
      const workspace = resolve(session.workspacePath ?? session.cwd);
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

  async sessionMarkdown(path: string, id: string) {
    const session = await this.requireSession(path);
    if (session.id !== id) throw new WebRuntimeRequestError("The exact Session is unavailable", "SESSION_CONFLICT", 409);
    const manager = this.runtime.getSessionManagerForRead?.(id, path) ??
      (this.isCurrentSession(session) ? this.runtime.sessionManager : SessionManager.open(path));
    if (!matchesSessionIdentity(manager, { expectedSessionId: id, expectedSessionPath: path }))
      throw new WebRuntimeRequestError("The Session changed before export", "SESSION_CONFLICT", 409);
    const sections = [`# ${(session.name || session.firstMessage || "Conversation").replace(/[\r\n]+/g, " ")}\n`];
    let bytes = jsonByteLength({ markdown: sections[0] });
    // Export native ancestry, never the paginated/truncated Web projection.
    // Thinking, tool output and image bytes are not conversation Markdown.
    for (const entry of manager.getBranch()) {
      if (entry.type !== "message" || (entry.message.role !== "user" && entry.message.role !== "assistant")) continue;
      const content = entry.message.content;
      const body = typeof content === "string" ? content : content.flatMap((part) =>
        part.type === "text" ? [part.text] : part.type === "image" ? ["[Image]"] : [],
      ).join("\n\n");
      if (!body) continue;
      const section = `\n## ${entry.message.role === "user" ? "User" : "Assistant"}\n\n${body}\n`;
      bytes += jsonByteLength(section) - 2;
      if (bytes > WEB_SESSION_MARKDOWN_MAX_BYTES)
        throw new WebRuntimeRequestError("Conversation Markdown exceeds the 10 MiB export limit", "SESSION_MARKDOWN_TOO_LARGE", 413);
      sections.push(section);
    }
    const markdown = sections.join("");
    if (jsonByteLength({ markdown }) > WEB_SESSION_MARKDOWN_MAX_BYTES)
      throw new WebRuntimeRequestError("Conversation Markdown exceeds the 10 MiB export limit", "SESSION_MARKDOWN_TOO_LARGE", 413);
    return { markdown };
  }

  async forgetDeletedSession(path: string, id: string) {
    await this.ensureWorkspaceStateLoaded();
    await this.ensureArchivesLoaded();
    await this.enqueueWorkspaceMutation(async (draft) => {
      draft.sidebarPins = draft.sidebarPins.filter((pin) => pin.kind !== "session" || pin.path !== path || pin.id !== id);
      draft.sessionOrder = draft.sessionOrder.filter((session) => session.path !== path || session.id !== id);
      draft.sessionReadStates = draft.sessionReadStates.filter((session) => session.path !== path || session.id !== id);
      draft.ungroupedSessions.delete(path);
    });
    await this.enqueueArchiveMutation(async (draft) => { draft.delete(resolve(path)); });
  }

  async archiveSession(path: string) {
    await this.ensureArchivesLoaded();
    await this.enqueueArchiveMutation(async (draft) => {
      const session = await this.requireSession(path);
      draft.add(resolve(session.path));
    });
  }

  async listArchivedSessions(options: ArchivedSessionQuery = {}, signal?: AbortSignal) {
    signal?.throwIfAborted();
    await this.ensureWorkspaceStateLoaded();
    await this.ensureArchivesLoaded();
    const limit = options.limit ?? 25;
    const query = options.query?.trim() ?? "";
    const sort = options.sort ?? "updated";
    if (
      !Number.isSafeInteger(limit) ||
      limit <= 0 ||
      limit > WEB_MAX_ARCHIVED_SESSION_PAGE ||
      query.length > WEB_MAX_ARCHIVED_SESSION_QUERY ||
      /[\u0000-\u001f\u007f]/u.test(query) ||
      (sort !== "updated" && sort !== "created") ||
      (options.cwd !== undefined &&
        (!isAbsolute(options.cwd) || options.cwd.length > WEB_MAX_ARCHIVED_SESSION_CWD || /[\u0000-\u001f\u007f]/u.test(options.cwd))) ||
      (options.cursor !== undefined &&
        (options.cursor.length === 0 ||
          options.cursor.length > WEB_MAX_ARCHIVED_SESSION_CURSOR ||
          /[\u0000-\u001f\u007f]/u.test(options.cursor)))
    ) {
      return { status: "invalid" as const };
    }

    const cwd = options.cwd === undefined ? undefined : resolve(options.cwd);
    const normalizedQuery = query.normalize("NFKC").toLocaleLowerCase();
    if (normalizedQuery.length > WEB_MAX_ARCHIVED_SESSION_QUERY) {
      return { status: "invalid" as const };
    }
    const queryHash = archivedQueryHash(normalizedQuery, sort, cwd);
    const cursor = options.cursor === undefined
      ? undefined
      : decodeArchivedSessionCursor(options.cursor);
    if (options.cursor !== undefined && !cursor) {
      return { status: "invalid" as const };
    }
    if (cursor && cursor.queryHash !== queryHash) {
      return { status: "stale_cursor" as const };
    }
    const allSessions = await SessionManager.listAll(
      this.runtime.sessionDirectory,
      undefined,
      signal,
    );
    signal?.throwIfAborted();
    // Order the complete Pi catalog before locating the continuation window.
    if (sort === "created") {
      allSessions.sort((left, right) =>
        right.created.getTime() - left.created.getTime() ||
        right.path.localeCompare(left.path));
    }
    const matchesArchive = (session: (typeof allSessions)[number]) => {
      if (!this.archivedSessions.has(resolve(session.path))) return false;
      if (cwd !== undefined && resolve(this.sessionFork(session)?.workspacePath ?? session.cwd) !== cwd) return false;
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
    };
    let start = 0;
    if (cursor) {
      const cursorIndex = allSessions.findIndex(
        (session) => cursor.version === 1
          ? session.path === cursor.sessionPath
          : createHash("sha256").update(session.path).digest("hex") === cursor.sessionPathHash,
      );
      if (cursorIndex < 0) return { status: "stale_cursor" as const };
      if (cursor.version === 1 && !matchesArchive(allSessions[cursorIndex]!)) {
        return { status: "stale_cursor" as const };
      }
      start = cursorIndex + 1;
    }
    const scanned = allSessions.slice(
      start,
      start + WEB_MAX_ARCHIVED_SESSION_SCAN,
    );
    const matches = scanned.filter(matchesArchive);
    const selected = matches.slice(0, limit);
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
      ...this.sidebarState(session),
    }));
    const hasMoreMatches = sessions.length < matches.length;
    const recordsUnscanned = Math.max(
      0,
      allSessions.length - start - scanned.length,
    );
    // Advance past nonmatching rows too, including an entirely empty window.
    const anchor = hasMoreMatches
      ? selected.at(-1)
      : recordsUnscanned > 0 ? scanned.at(-1) : undefined;
    return {
      status: "ok" as const,
      sessions,
      ...(anchor
        ? {
            nextCursor: encodeArchivedSessionCursor({
              version: 2,
              sessionPathHash: createHash("sha256")
                .update(anchor.path)
                .digest("hex"),
              queryHash,
            }),
          }
        : {}),
      truncation: {
        truncated: hasMoreMatches || recordsUnscanned > 0,
        matchesOmitted: Math.max(0, matches.length - sessions.length),
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
        if (resolve(this.sessionFork(session)?.workspacePath ?? session.cwd) === canonical) {
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
      draft.workspaceOrder = draft.workspaceOrder.filter((path) => path !== canonical);
      draft.sidebarPins = draft.sidebarPins.filter((pin) => pin.kind !== "workspace" || pin.path !== canonical);
      draft.workspaceNames.delete(canonical);
      draft.hiddenWorkspaces.add(canonical);
      draft.restoreInitialWorkspace = false;
    });
  }

  async setSessionPin(path: string, id: string, pinned: boolean, before?: { path: string; id: string } | null) {
    return this.setSidebarPin({ kind: "session", path, id }, pinned, before ? { kind: "session", ...before } : before);
  }

  async setSidebarPin(target: WebSidebarPinTarget, pinned: boolean, before?: WebSidebarPinTarget | null) {
    await this.ensureWorkspaceStateLoaded();
    return this.enqueueWorkspaceMutation(async (draft) => {
      const anchor = before?.kind === "workspace" ? { ...before, path: resolve(before.path) } : before;
      if (target.kind === "workspace") target = { ...target, path: await this.requireWorkspace(target.path) };
      else if ((await this.requireSession(target.path)).id !== target.id) throw new WebRuntimeRequestError("Session identity changed; refresh before pinning", "SESSION_CONFLICT", 409);
      const previousIndex = draft.sidebarPins.findIndex((pin) => sameSidebarPin(pin, target));
      if (!pinned) {
        if (previousIndex >= 0) draft.sidebarPins.splice(previousIndex, 1);
        return;
      }
      if (anchor && sameSidebarPin(anchor, target)) return;
      if (anchor && !draft.sidebarPins.some((pin) => sameSidebarPin(pin, anchor))) throw new WebRuntimeRequestError("Pin order changed; refresh before reordering", "SIDEBAR_PIN_CHANGED", 409);
      if (previousIndex >= 0 && before === undefined) return;
      if (previousIndex >= 0) draft.sidebarPins.splice(previousIndex, 1);
      if (draft.sidebarPins.length >= 100) throw new Error("At most 100 projects and conversations can be pinned");
      draft.sidebarPins.splice(anchor ? draft.sidebarPins.findIndex((pin) => sameSidebarPin(pin, anchor)) : draft.sidebarPins.length, 0, { ...target });
    });
  }

  async setWorkspaceOrder(path: string, before?: string | null) {
    await this.ensureWorkspaceStateLoaded();
    return this.enqueueWorkspaceMutation(async (draft) => {
      const canonical = resolve(path);
      const anchor = before ? resolve(before) : null;
      const paths = await this.workspacePaths(undefined, draft);
      const ordinary = [...paths].filter((path) => !draft.hiddenWorkspaces.has(path) && !draft.sidebarPins.some((pin) => pin.kind === "workspace" && pin.path === path));
      if (!paths.has(canonical) || draft.hiddenWorkspaces.has(canonical) || anchor && !ordinary.includes(anchor)) throw new WebRuntimeRequestError("Project order changed; refresh before reordering", "WORKSPACE_ORDER_CHANGED", 409);
      if (anchor === canonical) return;
      const known = new Set(draft.workspaceOrder);
      for (const path of this.orderedWorkspacePaths(paths, draft)) {
        if (!draft.hiddenWorkspaces.has(path) && !known.has(path)) draft.workspaceOrder.push(path);
      }
      if (draft.workspaceOrder.length > MAX_SIDEBAR_METADATA_ENTRIES) throw new Error("Project order exceeds its metadata limit");
      draft.sidebarPins = draft.sidebarPins.filter((pin) => pin.kind !== "workspace" || pin.path !== canonical);
      draft.workspaceOrder = draft.workspaceOrder.filter((path) => path !== canonical);
      draft.workspaceOrder.splice(anchor ? draft.workspaceOrder.indexOf(anchor) : draft.workspaceOrder.length, 0, canonical);
    });
  }

  async setSessionOrder(path: string, id: string, before?: SessionIdentity | null) {
    await this.ensureWorkspaceStateLoaded();
    return this.enqueueWorkspaceMutation(async (draft) => {
      const session = await this.requireSession(path);
      if (session.id !== id) throw new WebRuntimeRequestError("Session identity changed; refresh before reordering", "SESSION_CONFLICT", 409);
      if (before) {
        const anchor = await this.requireSession(before.path);
        if (anchor.id !== before.id) throw new WebRuntimeRequestError("Session order anchor changed; refresh before reordering", "SESSION_CONFLICT", 409);
        if (before.path === path && before.id === id) return;
      }
      // A first manual move freezes the existing visible order. Unknown older
      // identities retain their positions instead of being erased by pagination.
      for (const item of [...await this.listSessions(), session, ...(before ? [before] : [])]) {
        if (!draft.sessionOrder.some((entry) => entry.path === item.path && entry.id === item.id)) draft.sessionOrder.push({ path: item.path, id: item.id });
      }
      if (draft.sessionOrder.length > MAX_SIDEBAR_METADATA_ENTRIES) throw new Error("Conversation order exceeds its metadata limit");
      draft.sessionOrder = draft.sessionOrder.filter((entry) => entry.path !== path || entry.id !== id);
      const index = before ? draft.sessionOrder.findIndex((entry) => entry.path === before.path && entry.id === before.id) : draft.sessionOrder.length;
      draft.sessionOrder.splice(index, 0, { path, id });
    });
  }

  async setSessionRead(path: string, id: string, read: boolean, expectedRevision: string) {
    await this.ensureWorkspaceStateLoaded();
    return this.enqueueWorkspaceMutation(async (draft) => {
      const session = await this.requireSession(path);
      if (session.id !== id) throw new WebRuntimeRequestError("Session identity changed; refresh before marking it read", "SESSION_CONFLICT", 409);
      const reading = draft.sessionReadStates.find((item) => item.path === path && item.id === id);
      const lastTurn = this.sessionTurnEvidence(session, reading?.lastReadTurn).results.at(-1);
      if (expectedRevision !== sessionReadRevision(session, reading, lastTurn)) throw new WebRuntimeRequestError("Session reading state changed; refresh before marking it again", "SESSION_READ_STATE_CHANGED", 409);
      const record: SessionReadState = { path, id, read, revision: randomUUID(), ...(read && lastTurn ? { lastReadTurn: { commandId: lastTurn.commandId, finishedAt: lastTurn.finishedAt } } : {}) };
      draft.sessionReadStates = draft.sessionReadStates.filter((item) => item.path !== path || item.id !== id);
      if (draft.sessionReadStates.length >= MAX_SIDEBAR_METADATA_ENTRIES) throw new Error("Conversation reading state exceeds its metadata limit");
      draft.sessionReadStates.push(record);
    });
  }

  private sessionTurnEvidence(session: SessionIdentity, acknowledged?: ReadTurn) {
    const runtime = this.runtime.getSessionExecution?.(session.id, session.path);
    const exact = runtime?.sessionId === session.id && runtime.sessionPath === session.path ? runtime : undefined;
    let native: ReturnType<typeof readSessionTurnEvidence> = { lastTurn: undefined, results: [] };
    let acknowledgedResults: ReadTurn[] = acknowledged ? [acknowledged] : [];
    if (!session.path.startsWith("current:")) {
      try {
        const manager = this.runtime.getSessionManagerForRead?.(session.id, session.path) ?? (this.isCurrentSession(session) ? this.runtime.sessionManager : SessionManager.open(session.path, this.runtime.sessionDirectory));
        if (matchesSessionIdentity(manager, { expectedSessionId: session.id, expectedSessionPath: session.path })) {
          // An existing exact read position can still distinguish older unread
          // results. Without it, history discovery is not a live publication.
          native = readSessionTurnEvidence(manager.getBranch(), session.id, Boolean(acknowledged));
          if (acknowledged) {
            const readEntry = manager.getEntries().find((entry) => {
              const timing = entry.type === "custom" && entry.customType === WEB_TURN_TIMING_ENTRY ? readTurnTiming(entry.data) : undefined;
              return timing?.sessionId === session.id && sameReadTurn(timing, acknowledged);
            });
            if (readEntry) acknowledgedResults = readSessionTurnEvidence(manager.getBranch(readEntry.id), session.id, true).results;
          }
        }
      } catch {
        // Missing or changed native evidence never becomes a success receipt.
      }
    }
    const lastTurn = exact?.lastTurn ?? native.lastTurn;
    // Execution can recover historical or unpersisted terminal facts. Only
    // durable live-publication records may seed automatic unread activity.
    return { exact, lastTurn, results: native.results, acknowledgedResults };
  }

  private sidebarState(session: SessionIdentity) {
    const fork = this.sessionFork(session);
    const order = this.sessionOrder.findIndex((item) => item.path === session.path && item.id === session.id);
    const reading = this.sessionReadStates.find((item) => item.path === session.path && item.id === session.id);
    const { exact, lastTurn, results, acknowledgedResults } = this.sessionTurnEvidence(session, reading?.lastReadTurn);
    // Pi keeps the acknowledged branch, so a rewind does not resurrect its read
    // ancestors. Native order, not wall-clock time, determines the unread position.
    const acknowledgedKeys = new Set(acknowledgedResults.map((turn) => JSON.stringify([turn.commandId, turn.finishedAt])));
    const firstResult = results.find((turn) => !acknowledgedKeys.has(JSON.stringify([turn.commandId, turn.finishedAt])));
    const firstUnread = reading?.read === false ? { type: "sessionStart" as const } : firstResult ? { type: "turn" as const, ...firstResult } : undefined;
    const readRevision = sessionReadRevision(session, reading, results.at(-1));
    return {
      ...(fork ? { workspacePath: fork.workspacePath, ...(fork.worktree ? { worktree: fork.worktree } : {}) } : {}),
      ...(order >= 0 ? { order } : {}),
      unread: Boolean(firstUnread),
      readRevision,
      ...(firstUnread ? { firstUnread } : {}),
      ...(lastTurn || exact && exact.status !== "unknown" ? {
        execution: {
          status: exact?.status ?? "unknown" as const,
          ...(exact ? { pendingFollowUps: exact.pendingFollowUps } : {}),
          ...(exact?.pendingSteering !== undefined && exact.pendingSteering > 0 ? { pendingSteering: exact.pendingSteering } : {}),
          ...(lastTurn ? { lastTurn } : {}),
          ...(exact?.compaction?.state === "running" ? { compacting: true } : {}),
        },
      } : {}),
    };
  }

  async listSessionProjection(pinnedPath?: string, chatsSort: "manual" | "updated" = "updated") {
    await this.ensureWorkspaceStateLoaded();
    await this.ensureArchivesLoaded();
    const allSessions = await SessionManager.listAll(
      this.runtime.sessionDirectory,
    );
    // Filter and order Pi's catalog before bounding the visible page. Archived
    // history has its own cursor; only an exact current/selected archive stays.
    const currentId = this.runtime.sessionManager.getSessionId();
    const pinned = new Set(
      allSessions
        .filter(
          (session) =>
            this.isCurrentSession(session) ||
            (pinnedPath !== undefined && session.path === pinnedPath),
        )
        .map((session) => session.path),
    );
    for (const pin of this.sidebarPins) {
      if (pin.kind === "session" && allSessions.some((session) => session.path === pin.path && session.id === pin.id) && !this.archivedSessions.has(resolve(pin.path))) pinned.add(pin.path);
    }
    const sorted = allSessions.filter((session) => !this.archivedSessions.has(resolve(session.path)) || pinned.has(session.path));
    if (chatsSort === "manual") {
      const positions = new Map(this.sessionOrder.map((entry, index) => [JSON.stringify([entry.path, entry.id]), index]));
      const position = (session: SessionIdentity) => positions.get(JSON.stringify([session.path, session.id])) ?? Number.MAX_SAFE_INTEGER;
      sorted.sort((left, right) => position(left) - position(right) || right.modified.getTime() - left.modified.getTime() || left.path.localeCompare(right.path));
    }
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
          pinned.has(projected[removeAt]!.path)
        ) {
          removeAt--;
        }
        projected.splice(removeAt, 1);
      }
    }
    return {
      workspacePaths: await this.workspacePaths(allSessions, undefined, true),
      sessions: projected.map((record) => {
        const pinOrder = this.sidebarPins.findIndex((pin) => pin.kind === "session" && pin.path === record.path && pin.id === record.id);
        return {
          ...record,
          ...(pinOrder >= 0 ? { pinOrder } : {}),
          ...this.sidebarState(record),
        };
      }),
      omitted: Math.max(
        0,
        sorted.length +
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

  async searchTranscripts(query: string, options: { includeArchived?: boolean; signal?: AbortSignal } = {}) {
    await this.ensureWorkspaceStateLoaded();
    await this.ensureArchivesLoaded();
    options.signal?.throwIfAborted();
    // Use Pi's catalog and the same workspace visibility as requireSession.
    // The caller supplies a query, never paths or a broader file capability.
    const catalog = await SessionManager.listAll(this.runtime.sessionDirectory);
    options.signal?.throwIfAborted();
    const sessions = catalog.filter((session) =>
      (options.includeArchived || !this.archivedSessions.has(resolve(session.path))) &&
      (!this.hiddenWorkspaces.has(resolve(session.cwd)) || this.ungroupedSessions.has(session.path)),
    ).map((session) => ({
      id: session.id,
      path: session.path,
      cwd: resolve(session.cwd),
      modified: session.modified.toISOString(),
      source: "web" as const,
      ...(session.name ? { name: session.name } : {}),
    }));
    return searchWebTranscripts({
      query,
      sessions,
      allowedSessionRoots: [this.runtime.sessionDirectory],
      allowedWorkspaces: [...new Set(sessions.map((session) => session.cwd))],
      signal: options.signal,
    });
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

  async getSnapshot(selectedPath?: string, historyAnchor?: { sessionId: string; entryId: string }, chatsSort: "manual" | "updated" = "updated") {
    await this.ensureWorkspaceStateLoaded();
    const sessionProjection = await this.listSessionProjection(selectedPath, chatsSort);
    const sessions: WebSessionSummary[] = sessionProjection.sessions;
    const currentCwd = this.currentProjectPath();
    const workspacePaths = this.orderedWorkspacePaths(sessionProjection.workspacePaths);
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
        ...(this.sidebarPins.some((pin) => pin.kind === "workspace" && pin.path === path) ? { pinOrder: this.sidebarPins.findIndex((pin) => pin.kind === "workspace" && pin.path === path) } : {}),
        name: (this.workspaceNames.get(path) ?? basename(path)) || path,
        current:
          this.runtime.workspaceSelected === true && path === currentCwd,
      }));
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
      sidebarPins: this.sidebarPins.map((pin) => ({ ...pin })),
      workspaceOrder: [...this.workspaceOrder],
      sessionOrder: this.sessionOrder.map((item) => ({ ...item })),
      sessionReadStates: this.sessionReadStates.map((item) => ({ ...item, ...(item.lastReadTurn ? { lastReadTurn: { ...item.lastReadTurn } } : {}) })),
      importedWorkspaces: new Set(this.importedWorkspaces),
      hiddenWorkspaces: new Set(this.hiddenWorkspaces),
      workspaceNames: new Map(this.workspaceNames),
      ungroupedSessions: new Set(this.ungroupedSessions),
      restoreInitialWorkspace: this.restoreInitialWorkspace,
    };
  }

  private restoreWorkspaceState(state: WorkspaceStateSnapshot) {
    this.sidebarPins = state.sidebarPins;
    this.workspaceOrder = state.workspaceOrder;
    this.sessionOrder = state.sessionOrder;
    this.sessionReadStates = state.sessionReadStates;
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

  private orderedWorkspacePaths(paths: Iterable<string>, state?: WorkspaceStateSnapshot) {
    const positions = new Map((state?.workspaceOrder ?? this.workspaceOrder).map((path, index) => [path, index]));
    const names = state?.workspaceNames ?? this.workspaceNames;
    const name = (path: string) => (names.get(path) ?? basename(path)) || path;
    // Selection never changes order. Saved positions take precedence; new or
    // legacy projects have a deterministic name/path fallback until moved.
    return [...paths].sort((left, right) =>
      (positions.get(left) ?? Number.MAX_SAFE_INTEGER) - (positions.get(right) ?? Number.MAX_SAFE_INTEGER) || name(left).localeCompare(name(right)) || left.localeCompare(right),
    );
  }

  private async workspacePaths(
    knownSessions?: readonly (SessionIdentity & { cwd: string })[],
    workspaceState?: WorkspaceStateSnapshot,
    groupForks = false,
  ) {
    const sessions = knownSessions ?? (await SessionManager.listAll(this.runtime.sessionDirectory));
    // The sidebar groups worktree forks under their source project. Files and
    // runtime admission still resolve the real, separately registered cwd.
    const project = (session: SessionIdentity & { cwd: string }) => resolve(groupForks ? this.sessionFork(session)?.workspacePath ?? session.cwd : session.cwd);
    return new Set([
      ...(this.runtime.workspaceSelected === true
        ? [project({ id: this.runtime.sessionManager.getSessionId(), path: this.runtime.sessionManager.getSessionFile() ?? "", cwd: this.runtime.cwd })]
        : []),
      ...(workspaceState?.sidebarPins ?? this.sidebarPins).flatMap((pin) => pin.kind === "workspace" ? [pin.path] : []),
      ...(workspaceState?.importedWorkspaces ?? this.importedWorkspaces),
      ...sessions.map(project),
    ]);
  }

  private sessionFork(session: SessionIdentity) {
    if (!session.path || session.path.startsWith("current:")) return undefined;
    try {
      const manager = this.runtime.getSessionManagerForRead?.(session.id, session.path) ??
        (this.isCurrentSession(session) ? this.runtime.sessionManager : SessionManager.open(session.path, this.runtime.sessionDirectory));
      if (!matchesSessionIdentity(manager, { expectedSessionId: session.id, expectedSessionPath: session.path })) return undefined;
      return readSessionFork(manager.getBranch(), session.id, manager.getCwd());
    } catch {
      return undefined;
    }
  }

  private currentProjectPath() {
    return resolve(this.sessionFork({ id: this.runtime.sessionManager.getSessionId(), path: this.runtime.sessionManager.getSessionFile() ?? "" })?.workspacePath ?? this.runtime.cwd);
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
      rerun: readMessageRerun(branch, manager.getHeader()?.parentSession),
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

  async getSessionPromptHistory(sessionId: string, path: string, anchorEntryId: string, beforeEntryId: string | null = null) {
    const summary = (await this.listSessions(path)).find((session) => session.path === path);
    if (!summary) return { status: "not_found" as const };
    const manager = this.runtime.getSessionManagerForRead?.(summary.id, summary.path) ??
      (this.isCurrentSession(summary) ? this.runtime.sessionManager : SessionManager.open(path));
    if (summary.id !== sessionId || manager.getSessionId() !== sessionId) return { status: "changed" as const };
    const branch = manager.getBranch();
    const branchById = new Map(branch.map((entry) => [entry.id, entry]));
    const anchor = branch.findIndex((entry) => entry.id === anchorEntryId);
    const before = beforeEntryId === null ? anchor + 1 : branch.findIndex((entry) => entry.id === beforeEntryId);
    if (anchor < 0 || before < 0 || (beforeEntryId !== null &&
      (before > anchor || !isSessionPrompt(branch[before]!, branch[before - 1], branchById)))) return { status: "changed" as const };
    const entryIds: string[] = [];
    for (let index = before - 1; index >= 0 && entryIds.length <= WEB_MAX_PROMPT_HISTORY_PAGE; index--) {
      if (isSessionPrompt(branch[index]!, branch[index - 1], branchById)) entryIds.push(branch[index]!.id);
    }
    const more = entryIds.length > WEB_MAX_PROMPT_HISTORY_PAGE;
    if (more) entryIds.pop();
    entryIds.reverse();
    const page: WebSessionPromptHistoryPage = {
      sessionId, sessionPath: summary.path, anchorEntryId,
      requestedBeforeEntryId: beforeEntryId, entryIds,
      nextBeforeEntryId: more ? entryIds[0]! : null,
    };
    return { status: "ok" as const, page };
  }

  async getSessionPromptPreview(sessionId: string, path: string, anchorEntryId: string, entryId: string) {
    const summary = (await this.listSessions(path)).find((session) => session.path === path);
    if (!summary) return { status: "not_found" as const };
    const manager = this.runtime.getSessionManagerForRead?.(summary.id, summary.path) ??
      (this.isCurrentSession(summary) ? this.runtime.sessionManager : SessionManager.open(path));
    if (summary.id !== sessionId || manager.getSessionId() !== sessionId) return { status: "changed" as const };
    const branch = manager.getBranch();
    const branchById = new Map(branch.map((entry) => [entry.id, entry]));
    const anchor = branch.findIndex((entry) => entry.id === anchorEntryId);
    const prompt = branch.findIndex((entry, index) => entry.id === entryId && isSessionPrompt(entry, branch[index - 1], branchById));
    if (anchor < 0 || prompt < 0 || prompt > anchor) return { status: "changed" as const };
    const entry = branch[prompt]!;
    const promptText = entry.type === "message" && entry.message.role === "user" ? entry.message.content :
      entry.type === "custom_message" ? setupDisplayMessage(projectEntry(entry).message!).content :
      entry.type === "custom" && entry.data && typeof entry.data === "object" && "text" in entry.data ? entry.data.text : "";
    let response = "";
    for (let index = prompt + 1; index <= anchor; index++) {
      const item = branch[index]!;
      if (isSessionPrompt(item, branch[index - 1], branchById)) break;
      if (item.type === "message" && item.message.role === "assistant") {
        const text = promptPreviewText(item.message.content);
        if (text.length > 0) response = text;
      }
    }
    const preview: WebSessionPromptPreview = {
      sessionId, sessionPath: summary.path, anchorEntryId, entryId,
      prompt: promptPreviewText(promptText), response,
    };
    return { status: "ok" as const, preview };
  }

  async getSessionMessageWindow(sessionId: string, path: string, entryId: string) {
    const summary = await this.requireSession(path).catch(() => undefined);
    if (!summary) return { status: "not_found" as const };
    const manager = this.runtime.getSessionManagerForRead?.(summary.id, summary.path) ??
      (this.isCurrentSession(summary) ? this.runtime.sessionManager : SessionManager.open(path));
    if (summary.id !== sessionId || manager.getSessionId() !== sessionId) return { status: "changed" as const };
    const branch = manager.getBranch();
    const branchById = new Map(branch.map((entry) => [entry.id, entry]));
    const target = branch.findIndex((entry, index) => entry.id === entryId && (entry.type === "message" || isSessionPrompt(entry, branch[index - 1], branchById)));
    if (target < 0) return { status: "changed" as const };
    // Keep bounded following context so an old reading anchor can occupy its
    // original viewport offset. A prefix ending at the anchor clamps it to the
    // bottom even though the native branch contains later messages.
    let end = target + 1;
    let followingPrompts = 0;
    while (end < branch.length && end <= target + Math.floor(WEB_MAX_ENTRIES / 2)) {
      if (isSessionPrompt(branch[end]!, branch[end - 1], branchById) && followingPrompts++ >= Math.floor(HISTORY_PAGE_TURNS / 2)) break;
      end++;
    }
    let prefix = branch.slice(0, end);
    const budget = WEB_MAX_SELECTED_TRANSCRIPT_BYTES - jsonByteLength(summary) - 2048;
    let projected = alignHistoryPage(projectEntries(prefix, (file) => resolve(summary.cwd, file), budget), prefix.length);
    // A long turn may exceed the bounded projection. Always retain the native target.
    if (!projected.entries.some((entry) => entry.id === entryId) && end > target + 1) {
      prefix = branch.slice(0, target + 1);
      projected = alignHistoryPage(projectEntries(prefix, (file) => resolve(summary.cwd, file), budget), prefix.length);
      projected.truncation = { ...projected.truncation, truncated: true };
    }
    if (!projected.entries.some((entry) => entry.id === entryId)) return { status: "changed" as const };
    if (end < branch.length) projected.truncation = { ...projected.truncation, truncated: true };
    const session: WebSessionProjection = {
      id: summary.id, path: summary.path, cwd: summary.cwd, ...projected,
      rerun: readMessageRerun(branch, manager.getHeader()?.parentSession),
      history: { leafEntryId: manager.getLeafId(), anchorEntryId: entryId, anchorOnBranch: true,
        beforeEntryId: projected.truncation.entriesOmitted > 0 ? projected.entries[0]?.id ?? null : null },
    };
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

  private async sourceSession(sessionId: string, path: string) {
    const summary = (await this.listSessions(path)).find((session) => session.path === path);
    if (!summary || summary.id !== sessionId) return undefined;
    const manager = this.runtime.getSessionManagerForRead?.(summary.id, summary.path) ??
      (this.isCurrentSession(summary) ? this.runtime.sessionManager : SessionManager.open(path));
    return manager.getSessionId() === sessionId ? manager : undefined;
  }

  async getSessionSources(sessionId: string, path: string, offset: number, revision?: string) {
    const manager = await this.sourceSession(sessionId, path);
    if (!manager) return undefined;
    const current = manager.getLeafId() ?? "empty";
    if (revision !== undefined && revision !== current) return { changed: true as const };
    const result = collectSessionSources(manager.getBranch());
    return { sessionId, path, revision: current, sources: result.sources.slice(offset, offset + 50),
      ...(offset + 50 < result.sources.length ? { nextOffset: offset + 50 } : {}), truncated: result.truncated };
  }

  async getSourceImage(sessionId: string, path: string, entryId: string, partIndex: number) {
    const manager = await this.sourceSession(sessionId, path);
    const entry = manager?.getBranch().find((item) => item.id === entryId);
    if (entry?.type !== "message" || entry.message.role !== "user" || !Array.isArray(entry.message.content)) return undefined;
    const image = entry.message.content[partIndex];
    // Read only image bytes already supplied to this exact Session; never a client path.
    if (image?.type !== "image" || !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(image.mimeType) ||
      typeof image.data !== "string" || image.data.length > WEB_PROMPT_IMAGE_MAX_BASE64_CHARS) return undefined;
    const bytes = Buffer.from(image.data, "base64");
    if (bytes.byteLength > WEB_PROMPT_IMAGE_MAX_BYTES || bytes.toString("base64") !== image.data) return undefined;
    return { data: image.data, mimeType: image.mimeType };
  }

  async getSessionItem(sessionId: string, path: string, entryId: string, cursor: number, purpose?: "plan" | "thinking", partIndex?: number) {
    const summary = (await this.listSessions(path)).find((session) => session.path === path);
    if (!summary) return { status: "not_found" as const };
    const manager = this.runtime.getSessionManagerForRead?.(summary.id, summary.path) ??
      (this.isCurrentSession(summary) ? this.runtime.sessionManager : SessionManager.open(path));
    if (summary.id !== sessionId || manager.getSessionId() !== sessionId)
      return { status: "changed" as const };
    const entry = manager.getBranch().find((item) => item.id === entryId);
    if (!entry) return { status: "changed" as const };
    let content: unknown;
    let planStatus: "ready" | undefined;
    if (purpose === "thinking") {
      if (entry.type !== "message" || entry.message.role !== "assistant" ||
        !Array.isArray(entry.message.content) || !Number.isSafeInteger(partIndex) || partIndex! < 0)
        return { status: "changed" as const };
      const part = entry.message.content[partIndex!];
      if (part?.type !== "thinking" || typeof part.thinking !== "string")
        return { status: "changed" as const };
      // Read only the provider's saved, visible thinking text. Signatures and
      // other parts are never exposed through this explicit projection.
      content = part.thinking;
    } else if (partIndex !== undefined) return { status: "changed" as const };
    else if (purpose === "plan") {
      if (entry.type !== "message" || entry.message.role !== "toolResult" ||
        entry.message.toolName !== "plan_ready" || entry.message.isError !== false)
        return { status: "changed" as const };
      const details = entry.message.details;
      if (!details || typeof details !== "object" || Array.isArray(details) ||
        !("status" in details) || details.status !== "ready" ||
        !("plan" in details) || !isBoundedReadyPlan(details.plan))
        return { status: "changed" as const };
      content = details.plan.trim();
      planStatus = "ready";
    } else if (entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant"))
      content = entry.message.content;
    else if (entry.type === "custom" && entry.customType === WEB_COMMAND_INPUT &&
      entry.data && typeof entry.data === "object" && "text" in entry.data)
      content = entry.data.text;
    else return { status: "changed" as const };
    const page = visibleTextPage(content, cursor);
    return page ? { status: "ok" as const, page: { entryId, ...page, ...(planStatus ? { planStatus } : {}),
      ...(purpose === "thinking" ? { partIndex } : {}) } }
      : { status: "invalid_cursor" as const };
  }
}
