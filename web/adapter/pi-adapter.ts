import { readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { webCapabilitySnapshot } from "../../extensions/shared/web-observer-registry.ts";
import {
  boundedText,
  jsonByteLength,
  projectEntries,
  projectEntry,
  WEB_MAX_MODELS,
  WEB_MAX_SESSIONS,
  WEB_MAX_SESSION_PREVIEW,
  WEB_MAX_SNAPSHOT_BYTES,
  WEB_MAX_WORKSPACES,
  type WebSessionProjection,
  type WebSessionSummary,
  type WebSnapshotTruncation,
  type WebWorkspaceSummary,
} from "../protocol/types.ts";
import type { WebRuntimeController } from "../runtime/types.ts";

type WorkspaceStateSnapshot = {
  importedWorkspaces: Set<string>;
  hiddenWorkspaces: Set<string>;
  workspaceNames: Map<string, string>;
  ungroupedSessions: Set<string>;
  restoreInitialWorkspace: boolean;
};

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
      session.id === this.runtime.sessionManager.getSessionId()
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
            session.id === currentId ||
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
      !projected.some((session) => session.id === currentId)
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
          (allSessions.some((session) => session.id === currentId) ||
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

  async getSnapshot(selectedPath?: string) {
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
        (session) => session.id === this.runtime.sessionManager.getSessionId(),
      )?.path;
    const selectedSession = path
      ? await this.getSession(path, sessions)
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
    const snapshot = {
      ...(this.runtime.workspaceSelected === true
        ? { currentSessionId: this.runtime.sessionManager.getSessionId() }
        : {}),
      workspaces,
      sessions,
      models,
      ...(selectedSession ? { selectedSession } : {}),
      runtime: {
        status: this.runtime.isIdle()
          ? ("idle" as const)
          : ("running" as const),
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
      while (selected.entries.length > 0 && bytes > targetBytes) {
        const entry = selected.entries.shift();
        if (!entry) break;
        removed++;
        bytes -= jsonByteLength(entry) + 1;
      }
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
        entriesOmitted: selected.truncation.entriesOmitted + removed,
        messagePartsOmitted,
        messagesTruncated,
      };
    }

    const selectedPath = selected?.path;
    bytes = jsonByteLength(snapshot);
    while (bytes > targetBytes && snapshot.sessions.length > 1) {
      let index = -1;
      for (let candidate = snapshot.sessions.length - 1; candidate >= 0; candidate--) {
        const session = snapshot.sessions[candidate]!;
        if (
          session.id !== snapshot.currentSessionId &&
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

  async getSession(
    path: string,
    knownSessions?: WebSessionSummary[],
  ): Promise<WebSessionProjection | undefined> {
    const sessions = knownSessions ?? (await this.listSessions(path));
    const summary = sessions.find((session) => session.path === path);
    if (!summary) return undefined;

    const manager =
      summary.id === this.runtime.sessionManager.getSessionId()
        ? this.runtime.sessionManager
        : SessionManager.open(path);
    const projected = projectEntries(manager.getBranch());
    return {
      id: summary.id,
      path: summary.path,
      cwd: summary.cwd,
      ...projected,
    };
  }
}
