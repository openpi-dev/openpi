import { randomUUID } from "node:crypto";
import type { CleanupConfirmation } from "../../extensions/shared/web-cleanup-confirmation.ts";
import type { WebActiveTurn } from "./types.ts";

const CONFIRMATION_TIMEOUT_MS = 60_000;
const MAX_PENDING = 4;
const MAX_PATHS = 32;
const MAX_PATH_BYTES = 4 * 1024;

export interface WebCleanupConfirmationRequest extends WebActiveTurn {
  readonly requestId: string;
  readonly workspace: string;
  readonly paths: readonly string[];
  readonly expiresAt: number;
}

export type WebConfirmationReceipt =
  | "approved"
  | "denied"
  | "expired"
  | "stale"
  | "already-settled";

type Pending = {
  readonly request: WebCleanupConfirmationRequest;
  readonly settle: (decision: CleanupConfirmation, terminal: WebConfirmationReceipt) => void;
};

export class WebCleanupConfirmations {
  private readonly pending = new Map<string, Pending>();
  private readonly terminal = new Map<string, WebConfirmationReceipt>();
  private readonly changed: () => void;
  private readonly timeoutMs: number;

  constructor(changed: () => void, timeoutMs = CONFIRMATION_TIMEOUT_MS) {
    this.changed = changed;
    this.timeoutMs = timeoutMs;
  }

  list() {
    return [...this.pending.values()].map(({ request }) => request);
  }

  request(
    target: { workspace: string; turn: WebActiveTurn },
    paths: readonly string[],
    signal?: AbortSignal,
  ): Promise<CleanupConfirmation> {
    if (
      signal?.aborted || this.pending.size >= MAX_PENDING ||
      paths.length === 0 || paths.length > MAX_PATHS ||
      Buffer.byteLength(JSON.stringify(paths)) > MAX_PATH_BYTES ||
      paths.some((path) => !path || path.length > 512 || /[\u0000-\u001f\u007f]/u.test(path))
    ) return Promise.resolve("unavailable");

    const request: WebCleanupConfirmationRequest = {
      ...target.turn,
      workspace: target.workspace,
      paths: [...paths],
      requestId: randomUUID(),
      expiresAt: Date.now() + this.timeoutMs,
    };
    return new Promise((resolve) => {
      let done = false;
      const finish = (decision: CleanupConfirmation, receipt: WebConfirmationReceipt) => {
        if (done) return;
        done = true;
        clearTimeout(timeout);
        signal?.removeEventListener("abort", aborted);
        this.pending.delete(request.requestId);
        this.terminal.set(request.requestId, receipt);
        while (this.terminal.size > 32) {
          const oldest = this.terminal.keys().next().value;
          if (oldest) this.terminal.delete(oldest);
        }
        this.changed();
        resolve(decision);
      };
      const aborted = () => finish("unavailable", "stale");
      const timeout = setTimeout(() => finish("unavailable", "expired"), this.timeoutMs);
      this.pending.set(request.requestId, { request, settle: finish });
      signal?.addEventListener("abort", aborted, { once: true });
      if (signal?.aborted) aborted();
      else this.changed();
    });
  }

  respond(
    target: WebActiveTurn & { workspace: string; requestId: string },
    approved: boolean,
  ): WebConfirmationReceipt {
    const entry = this.pending.get(target.requestId);
    if (!entry) {
      const terminal = this.terminal.get(target.requestId);
      return terminal === "expired" ? "expired" : terminal ? "already-settled" : "stale";
    }
    const request = entry.request;
    if (
      request.workspace !== target.workspace ||
      request.sessionId !== target.sessionId ||
      request.commandId !== target.commandId ||
      request.epoch !== target.epoch
    ) return "stale";
    if (Date.now() >= request.expiresAt) {
      entry.settle("unavailable", "expired");
      return "expired";
    }
    const receipt = approved ? "approved" : "denied";
    entry.settle(receipt, receipt);
    return receipt;
  }

  invalidate() {
    for (const entry of [...this.pending.values()]) entry.settle("unavailable", "stale");
  }
}
