import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { IPty } from "node-pty";
import type {
  WebInteractiveTerminal,
  WebInteractiveTerminalEvent,
} from "../protocol/types.ts";

export const INTERACTIVE_TERMINAL_MAX_INPUT = 64 * 1024;
export const INTERACTIVE_TERMINAL_MAX_BACKLOG = 128 * 1024;
export const INTERACTIVE_TERMINAL_RECONNECT_MS = 120_000;

type TerminalListener = (event: WebInteractiveTerminalEvent) => void;
type PtySpawn = typeof import("node-pty").spawn;

interface TerminalRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly cwd: string;
  readonly createKey: string;
  readonly pty: IPty;
  readonly listeners: Set<TerminalListener>;
  backlog: string;
  offset: number;
  exited: boolean;
  exitCode: number | null;
  cleanupTimer?: ReturnType<typeof setTimeout>;
}

interface PendingTerminalCreate {
  readonly generation: number;
  readonly completion: Promise<WebInteractiveTerminal & { reused: boolean }>;
}

export interface InteractiveTerminalSubscription {
  output: Extract<WebInteractiveTerminalEvent, { type: "output" }>;
  exited: boolean;
  exitCode: number | null;
  unsubscribe: () => void;
}

export interface InteractiveTerminalService {
  create(options: {
    sessionId: string;
    cwd: string;
    cols: number;
    rows: number;
    createKey?: string;
  }): Promise<WebInteractiveTerminal & { reused: boolean }>;
  get(sessionId: string, id: string): WebInteractiveTerminal | undefined;
  write(sessionId: string, id: string, data: string): boolean;
  resize(sessionId: string, id: string, cols: number, rows: number): boolean;
  subscribe(
    sessionId: string,
    id: string,
    listener: TerminalListener,
    after?: number,
  ): InteractiveTerminalSubscription | undefined;
  close(sessionId: string, id: string, force?: boolean): boolean;
  retain(sessionId: string, cwd: string): void;
  dispose(): void;
}

function terminalDimension(value: number, fallback: number) {
  return Math.min(
    1_000,
    Math.max(2, Number.isFinite(value) ? Math.floor(value) : fallback),
  );
}

function shellEnvironment() {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  if (!env.LANG && !env.LC_ALL && !env.LC_CTYPE) env.LANG = "C.UTF-8";
  return env;
}

export class InteractiveTerminalManager
  implements InteractiveTerminalService
{
  private readonly records = new Map<string, TerminalRecord>();
  private readonly cleanupMs: number;
  private readonly maxTerminals: number;
  private readonly injectedSpawn?: PtySpawn;
  private readonly pendingCreates = new Map<string, PendingTerminalCreate>();
  private readonly reservations = new Set<symbol>();
  private retainedScope?: string;
  private lifecycleGeneration = 0;
  private spawnPromise?: Promise<PtySpawn>;

  constructor(options: {
    spawn?: PtySpawn;
    cleanupMs?: number;
    maxTerminals?: number;
  } = {}) {
    this.injectedSpawn = options.spawn;
    this.cleanupMs = options.cleanupMs ?? INTERACTIVE_TERMINAL_RECONNECT_MS;
    this.maxTerminals = options.maxTerminals ?? 8;
  }

  async create({ sessionId, cwd, cols, rows, createKey = "default" }: {
    sessionId: string;
    cwd: string;
    cols: number;
    rows: number;
    createKey?: string;
  }) {
    const canonicalCwd = resolve(cwd);
    const scope = this.scope(sessionId, canonicalCwd);
    this.retainedScope ??= scope;
    const generation = this.lifecycleGeneration;
    const key = `${scope}\0${createKey}`;
    const existing = [...this.records.values()].find((record) =>
      record.sessionId === sessionId && record.cwd === canonicalCwd && record.createKey === createKey,
    );
    if (existing) {
      return { ...this.snapshot(existing), reused: true };
    }

    const candidate = this.pendingCreates.get(key);
    const pending = candidate?.generation === generation ? candidate : undefined;
    if (pending) {
      return pending.completion.then((terminal) => ({
        ...terminal,
        reused: true,
      }));
    }
    const completion = Promise.resolve().then(() =>
      this.createTerminal({
        sessionId,
        cwd: canonicalCwd,
        cols,
        rows,
        generation,
        createKey,
      }),
    );
    const create = { generation, completion };
    this.pendingCreates.set(key, create);
    const clearPending = () => {
      if (this.pendingCreates.get(key) === create)
        this.pendingCreates.delete(key);
    };
    void completion.then(clearPending, clearPending);
    return completion;
  }

  private async createTerminal({ sessionId, cwd, cols, rows, generation, createKey }: {
    sessionId: string;
    cwd: string;
    cols: number;
    rows: number;
    generation: number;
    createKey: string;
  }) {
    this.assertCurrentGeneration(generation);
    this.makeSpace();
    if (this.records.size + this.reservations.size >= this.maxTerminals) {
      throw new Error("Interactive terminal capacity is full");
    }
    const reservation = Symbol(sessionId);
    this.reservations.add(reservation);

    try {
      const spawn = await this.loadSpawn();
      this.assertCurrentGeneration(generation);
      const shell =
        process.platform === "win32"
          ? (process.env.ComSpec ?? "cmd.exe")
          : (process.env.SHELL ?? "/bin/sh");
      const args = process.platform === "win32" ? [] : ["-l"];
      const pty = spawn(shell, args, {
        name: "xterm-256color",
        cols: terminalDimension(cols, 80),
        rows: terminalDimension(rows, 24),
        cwd: cwd || homedir(),
        env: shellEnvironment(),
      });
      const record: TerminalRecord = {
        id: randomUUID(),
        sessionId,
        cwd,
        createKey,
        pty,
        listeners: new Set(),
        backlog: "",
        offset: 0,
        exited: false,
        exitCode: null,
      };
      this.records.set(record.id, record);
      this.scheduleCleanup(record);
      pty.onData((data) => {
        record.backlog = (record.backlog + data).slice(
          -INTERACTIVE_TERMINAL_MAX_BACKLOG,
        );
        record.offset += data.length;
        this.emit(record, { type: "output", data, offset: record.offset });
      });
      pty.onExit(({ exitCode }) => {
        record.exited = true;
        record.exitCode = exitCode;
        this.clearCleanup(record);
        this.emit(record, { type: "exit", exitCode });
        this.scheduleCleanup(record);
      });
      return { ...this.snapshot(record), reused: false };
    } finally {
      this.reservations.delete(reservation);
    }
  }

  get(sessionId: string, id: string) {
    const record = this.ownedRecord(sessionId, id);
    return record ? this.snapshot(record) : undefined;
  }

  write(sessionId: string, id: string, data: string) {
    const record = this.ownedRecord(sessionId, id);
    if (
      !record ||
      record.exited ||
      data.length === 0 ||
      data.length > INTERACTIVE_TERMINAL_MAX_INPUT
    )
      return false;
    record.pty.write(data);
    return true;
  }

  resize(sessionId: string, id: string, cols: number, rows: number) {
    const record = this.ownedRecord(sessionId, id);
    if (!record || record.exited) return false;
    record.pty.resize(
      terminalDimension(cols, 80),
      terminalDimension(rows, 24),
    );
    return true;
  }

  subscribe(
    sessionId: string,
    id: string,
    listener: TerminalListener,
    after?: number,
  ) {
    const record = this.ownedRecord(sessionId, id);
    if (!record) return undefined;
    record.listeners.add(listener);
    this.clearCleanup(record);
    const start = record.offset - record.backlog.length;
    const reset =
      after === undefined || after < start || after > record.offset;
    return {
      output: {
        type: "output" as const,
        data: reset
          ? record.backlog
          : record.backlog.slice(Math.max(0, after - start)),
        offset: record.offset,
        reset,
      },
      exited: record.exited,
      exitCode: record.exitCode,
      unsubscribe: () => {
        record.listeners.delete(listener);
        this.scheduleCleanup(record);
      },
    };
  }

  close(sessionId: string, id: string, force = false) {
    const record = this.ownedRecord(sessionId, id);
    if (!record) return false;
    this.remove(record, force);
    return true;
  }

  retain(sessionId: string, cwd: string) {
    const canonicalCwd = resolve(cwd);
    const scope = this.scope(sessionId, canonicalCwd);
    if (this.retainedScope !== scope) {
      this.retainedScope = scope;
      this.lifecycleGeneration++;
      this.reservations.clear();
    }
    for (const record of [...this.records.values()]) {
      if (record.sessionId !== sessionId || record.cwd !== canonicalCwd)
        this.remove(record, true);
    }
  }

  dispose() {
    this.retainedScope = undefined;
    this.lifecycleGeneration++;
    this.reservations.clear();
    for (const record of [...this.records.values()]) this.remove(record, true);
  }

  private scope(sessionId: string, cwd: string) {
    return `${sessionId}\0${cwd}`;
  }

  private assertCurrentGeneration(generation: number) {
    if (generation !== this.lifecycleGeneration)
      throw new Error("Interactive terminal creation was cancelled");
  }

  private async loadSpawn() {
    if (this.injectedSpawn) return this.injectedSpawn;
    this.spawnPromise ??= import("node-pty")
      .then((module) => module.spawn)
      .catch((error) => {
        throw new Error(
          `Cannot load the node-pty native terminal module for ${process.platform}-${process.arch}. Reinstall OpenPI or rebuild node-pty for this Node.js runtime. ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      });
    return this.spawnPromise;
  }

  private snapshot(record: TerminalRecord): WebInteractiveTerminal {
    return {
      id: record.id,
      sessionId: record.sessionId,
      cwd: record.cwd,
      exited: record.exited,
      exitCode: record.exitCode,
    };
  }

  private ownedRecord(sessionId: string, id: string) {
    const record = this.records.get(id);
    return record?.sessionId === sessionId ? record : undefined;
  }

  private emit(record: TerminalRecord, event: WebInteractiveTerminalEvent) {
    for (const listener of record.listeners) listener(event);
  }

  private clearCleanup(record: TerminalRecord) {
    if (record.cleanupTimer) clearTimeout(record.cleanupTimer);
    record.cleanupTimer = undefined;
  }

  private scheduleCleanup(record: TerminalRecord) {
    if (
      record.cleanupTimer ||
      record.listeners.size > 0 ||
      this.records.get(record.id) !== record
    )
      return;
    record.cleanupTimer = setTimeout(
      () => this.remove(record, false),
      this.cleanupMs,
    );
    record.cleanupTimer.unref?.();
  }

  private makeSpace() {
    if (this.records.size < this.maxTerminals) return;
    const removable = [...this.records.values()].find(
      (record) => record.listeners.size === 0 && record.exited,
    );
    if (removable) this.remove(removable, true);
  }

  private remove(record: TerminalRecord, force: boolean) {
    if (this.records.get(record.id) !== record) return;
    this.clearCleanup(record);
    this.records.delete(record.id);
    if (!record.exited) {
      // Windows node-pty terminates through ConPTY and rejects POSIX signals.
      const windows = process.platform === "win32";
      record.pty.kill(force && !windows ? "SIGKILL" : undefined);
      if (!force && !windows) {
        const forceKill = setTimeout(() => {
          if (!record.exited) record.pty.kill("SIGKILL");
        }, 2_000);
        forceKill.unref?.();
      }
    }
    this.emit(record, { type: "closed" });
    record.listeners.clear();
  }
}
