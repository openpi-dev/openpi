import { readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { webCapabilitySnapshot } from "../../extensions/shared/web-observer-registry.ts";
import {
  boundedText,
  projectEntry,
  WEB_MAX_ENTRIES,
  WEB_MAX_SESSIONS,
  type WebSessionProjection,
  type WebSessionSummary,
  type WebWorkspaceSummary,
} from "../protocol/types.ts";
import type { WebRuntimeController } from "../runtime/types.ts";

function boundedBranch(manager: SessionManager, limit: number) {
  const entries = [];
  let entryId = manager.getLeafId();
  while (entryId && entries.length < limit) {
    const entry = manager.getEntry(entryId);
    if (!entry) break;
    entries.push(entry);
    entryId = entry.parentId;
  }
  return entries.reverse();
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
  private restoreInitialWorkspace = false;
  private writeSequence = 0;

  constructor(runtime: WebRuntimeController) {
    this.runtime = runtime;
    this.workspaceStateFile = join(
      runtime.sessionDirectory,
      "workspace-state.json",
    );
    this.archiveFile = join(runtime.sessionDirectory, "archived-sessions.json");
    this.importedWorkspaces.add(resolve(runtime.cwd));
  }

  private async ensureWorkspaceStateLoaded() {
    if (this.workspaceStateLoaded) return;
    if (!this.workspaceStateLoading) {
      this.workspaceStateLoading = (async () => {
        try {
          const parsed = JSON.parse(
            await readFile(this.workspaceStateFile, "utf8"),
          );
          if (parsed && typeof parsed === "object") {
            const state = parsed as Record<string, unknown>;
            if (Array.isArray(state.hiddenWorkspaces)) {
              for (const path of state.hiddenWorkspaces) {
                if (typeof path === "string")
                  this.hiddenWorkspaces.add(resolve(path));
              }
            }
            if (Array.isArray(state.ungroupedSessions)) {
              for (const path of state.ungroupedSessions) {
                if (typeof path === "string")
                  this.ungroupedSessions.add(resolve(path));
              }
            }
            if (state.workspaceNames && typeof state.workspaceNames === "object") {
              for (const [path, name] of Object.entries(state.workspaceNames)) {
                if (typeof name === "string")
                  this.workspaceNames.set(resolve(path), name);
              }
            }
          }
        } catch {
          // Missing or malformed workspace metadata starts with an empty index.
        }
        this.restoreInitialWorkspace = this.hiddenWorkspaces.has(
          resolve(this.runtime.cwd),
        );
        this.workspaceStateLoaded = true;
      })();
    }
    await this.workspaceStateLoading;
  }

  private persistWorkspaceState() {
    const content = `${JSON.stringify({
        version: 1,
        hiddenWorkspaces: [...this.hiddenWorkspaces],
        ungroupedSessions: [...this.ungroupedSessions],
        workspaceNames: Object.fromEntries(this.workspaceNames),
      })}\n`;
    const operation = this.workspaceStateWrite
      .catch(() => undefined)
      .then(() => this.writeAtomically(this.workspaceStateFile, content));
    this.workspaceStateWrite = operation;
    return operation;
  }

  private async ensureArchivesLoaded() {
    if (this.archivesLoaded) return;
    if (!this.archivesLoading) {
      this.archivesLoading = (async () => {
        try {
          const parsed = JSON.parse(await readFile(this.archiveFile, "utf8"));
          if (Array.isArray(parsed)) {
            for (const path of parsed) {
              if (typeof path === "string") this.archivedSessions.add(path);
            }
          }
        } catch {
          // Missing or malformed archive metadata fails open to an empty archive.
        }
        this.archivesLoaded = true;
      })();
    }
    await this.archivesLoading;
  }

  private persistArchives() {
    const content = `${JSON.stringify([...this.archivedSessions])}\n`;
    const operation = this.archivesWrite
      .catch(() => undefined)
      .then(() => this.writeAtomically(this.archiveFile, content));
    this.archivesWrite = operation;
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

  async importWorkspace(path: string) {
    await this.ensureWorkspaceStateLoaded();
    const canonical = await realpath(resolve(path));
    const info = await stat(canonical);
    if (!info.isDirectory())
      throw new Error("Workspace path is not a directory");
    this.importedWorkspaces.add(canonical);
    this.hiddenWorkspaces.delete(canonical);
    await this.persistWorkspaceState();
    return canonical;
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

  async requireSession(path: string) {
    await this.ensureWorkspaceStateLoaded();
    const sessions = await this.listSessions();
    const session = sessions.find((item) => item.path === path);
    if (!session) throw new Error("Session is not available");
    if (!session.ungrouped) await this.requireWorkspace(session.cwd);
    return session;
  }

  async renameWorkspace(path: string, name: string) {
    await this.ensureWorkspaceStateLoaded();
    const canonical = resolve(path);
    const workspaces = await this.workspacePaths();
    if (!workspaces.has(canonical))
      throw new Error("Workspace is not available");
    const normalized = name.trim();
    if (
      !normalized ||
      normalized.length > 80 ||
      /[\u0000-\u001f\u007f]/.test(normalized)
    ) {
      throw new Error("Workspace name must be 1-80 visible characters");
    }
    this.workspaceNames.set(canonical, normalized);
    await this.persistWorkspaceState();
    return normalized;
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
      session.id === this.runtime.sessionManager.getSessionId()
        ? this.runtime.sessionManager
        : SessionManager.open(session.path, this.runtime.sessionDirectory);
    manager.appendSessionInfo(normalized);
    return normalized;
  }

  async archiveSession(path: string) {
    const session = await this.requireSession(path);
    this.archivedSessions.add(resolve(session.path));
    await this.persistArchives();
  }

  async removeWorkspace(path: string) {
    await this.ensureWorkspaceStateLoaded();
    const canonical = resolve(path);
    const workspaces = await this.workspacePaths();
    if (!workspaces.has(canonical))
      throw new Error("Workspace is not available");
    const sessions = await this.listSessions();
    for (const session of sessions) {
      if (session.cwd === canonical) this.ungroupedSessions.add(resolve(session.path));
    }
    this.importedWorkspaces.delete(canonical);
    this.workspaceNames.delete(canonical);
    this.hiddenWorkspaces.add(canonical);
    this.restoreInitialWorkspace = false;
    await this.persistWorkspaceState();
  }

  async listSessions(): Promise<WebSessionSummary[]> {
    await this.ensureWorkspaceStateLoaded();
    await this.ensureArchivesLoaded();
    const sessions = await SessionManager.listAll(
      this.runtime.sessionDirectory,
    );
    const projected = sessions
      .sort((left, right) => right.modified.getTime() - left.modified.getTime())
      .slice(0, WEB_MAX_SESSIONS)
      .map((session) => ({
        id: session.id,
        path: session.path,
        cwd: resolve(session.cwd),
        ...(session.name ? { name: session.name } : {}),
        modified: session.modified.toISOString(),
        created: session.created.toISOString(),
        messageCount: session.messageCount,
        firstMessage: boundedText(session.firstMessage),
        ...(this.archivedSessions.has(resolve(session.path)) ? { archived: true } : {}),
        ...(this.ungroupedSessions.has(resolve(session.path)) ? { ungrouped: true } : {}),
      }));
    const currentId = this.runtime.sessionManager.getSessionId();
    if (projected.some((session) => session.id === currentId)) return projected;

    const entries = boundedBranch(this.runtime.sessionManager, WEB_MAX_ENTRIES);
    const firstUser = entries
      .map((entry) => projectEntry(entry))
      .find((entry) => entry.message?.role === "user")?.message?.content;
    const now = new Date().toISOString();
    projected.unshift({
      id: currentId,
      path:
        this.runtime.sessionManager.getSessionFile() ?? `current:${currentId}`,
      cwd: resolve(this.runtime.cwd),
      ...(this.runtime.sessionManager.getSessionName()
        ? { name: this.runtime.sessionManager.getSessionName() }
        : {}),
      modified: now,
      created: now,
      messageCount: entries.filter((entry) => entry.type === "message").length,
      firstMessage: boundedText(firstUser ?? ""),
      ...(this.archivedSessions.has(resolve(this.runtime.sessionManager.getSessionFile() ?? `current:${currentId}`)) ? { archived: true } : {}),
      ...(this.ungroupedSessions.has(resolve(this.runtime.sessionManager.getSessionFile() ?? `current:${currentId}`)) ? { ungrouped: true } : {}),
    });
    return projected.slice(0, WEB_MAX_SESSIONS);
  }

  async getSnapshot(selectedPath?: string) {
    await this.ensureWorkspaceStateLoaded();
    if (this.restoreInitialWorkspace) {
      this.restoreInitialWorkspace = false;
      this.hiddenWorkspaces.delete(resolve(this.runtime.cwd));
      this.importedWorkspaces.add(resolve(this.runtime.cwd));
      await this.persistWorkspaceState();
    }
    const sessions = await this.listSessions();
    const currentCwd = resolve(this.runtime.cwd);
    const workspacePaths = await this.workspacePaths(sessions);
    const workspaces: WebWorkspaceSummary[] = [...workspacePaths]
      .filter((path) => !this.hiddenWorkspaces.has(path))
      .map((path) => ({
        path,
        name: (this.workspaceNames.get(path) ?? basename(path)) || path,
        current: path === currentCwd,
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
      sessions.find((session) => session.cwd === currentCwd)?.path;
    const selectedSession = path
      ? await this.getSession(path, sessions)
      : undefined;
    return {
      currentSessionId: this.runtime.sessionManager.getSessionId(),
      workspaces,
      sessions,
      models: this.runtime.listModels(),
      ...(selectedSession ? { selectedSession } : {}),
      runtime: {
        status: this.runtime.isIdle()
          ? ("idle" as const)
          : ("running" as const),
        capabilities: webCapabilitySnapshot(
          this.runtime.sessionManager.getSessionId(),
        ),
      },
    };
  }

  private async workspacePaths(knownSessions?: WebSessionSummary[]) {
    const sessions = knownSessions ?? (await this.listSessions());
    return new Set([
      resolve(this.runtime.cwd),
      ...this.importedWorkspaces,
      ...sessions.map((session) => session.cwd),
    ]);
  }

  async getSession(
    path: string,
    knownSessions?: WebSessionSummary[],
  ): Promise<WebSessionProjection | undefined> {
    const sessions = knownSessions ?? (await this.listSessions());
    const summary = sessions.find((session) => session.path === path);
    if (!summary) return undefined;

    const manager =
      summary.id === this.runtime.sessionManager.getSessionId()
        ? this.runtime.sessionManager
        : SessionManager.open(path);
    return {
      id: summary.id,
      path: summary.path,
      cwd: summary.cwd,
      entries: boundedBranch(manager, WEB_MAX_ENTRIES).map((entry) =>
        projectEntry(entry),
      ),
    };
  }
}
