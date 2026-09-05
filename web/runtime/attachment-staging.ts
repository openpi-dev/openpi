import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  open,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";

export interface WebAttachmentStagingLimits {
  readonly maxAttachments: number;
  readonly maxAttachmentBytes: number;
  readonly maxTotalBytes: number;
  readonly maxStagedBytes: number;
  readonly maxSettledReceipts: number;
  /** Age after which an abandoned store root is removed at startup. */
  readonly stagingTtlMs?: number;
}

const DEFAULT_STAGING_TTL_MS = 60 * 60 * 1000;
const MAX_ATTACHMENT_NAME_BYTES = 256;
const MAX_ATTACHMENT_MIME_BYTES = 256;

export interface WebAttachmentBinding {
  readonly workspace: string;
  readonly sessionId: string;
  readonly commandId: string;
}

export interface WebAttachmentPayload {
  /** Display metadata only. It is never used as a filesystem path. */
  readonly name: string;
  readonly mime: string;
  readonly bytes: Uint8Array;
}

export interface WebStagedAttachmentBatch {
  readonly id: string;
  readonly count: number;
  readonly totalBytes: number;
}

export type WebAttachmentConsumeReceipt =
  | {
      readonly status: "consumed";
      readonly attachments: readonly WebAttachmentPayload[];
    }
  | { readonly status: "missing" }
  | { readonly status: "stale" }
  | {
      readonly status: "settled";
      readonly outcome: "consumed" | "discarded" | "failed";
    }
  | { readonly status: "failed"; readonly error: string };

export type WebAttachmentDiscardReceipt =
  | { readonly status: "discarded" }
  | { readonly status: "missing" }
  | { readonly status: "stale" }
  | {
      readonly status: "settled";
      readonly outcome: "consumed" | "discarded" | "failed";
    };

export type WebAttachmentStagingErrorCode =
  | "INVALID_BINDING"
  | "INVALID_LIMITS"
  | "ATTACHMENT_LIMIT"
  | "BYTE_LIMIT"
  | "STORE_LIMIT"
  | "STORE_CLOSED"
  | "INVALID_PAYLOAD";

export class WebAttachmentStagingError extends Error {
  readonly code: WebAttachmentStagingErrorCode;

  constructor(code: WebAttachmentStagingErrorCode, message: string) {
    super(message);
    this.name = "WebAttachmentStagingError";
    this.code = code;
  }
}

interface StoredAttachment {
  readonly path: string;
  readonly name: string;
  readonly mime: string;
  readonly size: number;
}

interface StagingRecord {
  readonly id: string;
  readonly binding: WebAttachmentBinding;
  readonly directory: string;
  readonly attachments: readonly StoredAttachment[];
  readonly totalBytes: number;
  status: "staged" | "consumed" | "discarded" | "failed";
  settledAt?: number;
}

function assertPositiveInteger(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new WebAttachmentStagingError(
      "INVALID_LIMITS",
      `${name} must be a positive integer`,
    );
  }
}

function validateLimits(limits: WebAttachmentStagingLimits) {
  assertPositiveInteger(limits.maxAttachments, "maxAttachments");
  assertPositiveInteger(limits.maxAttachmentBytes, "maxAttachmentBytes");
  assertPositiveInteger(limits.maxTotalBytes, "maxTotalBytes");
  assertPositiveInteger(limits.maxStagedBytes, "maxStagedBytes");
  assertPositiveInteger(limits.maxSettledReceipts, "maxSettledReceipts");
  if (
    limits.stagingTtlMs !== undefined &&
    (!Number.isSafeInteger(limits.stagingTtlMs) || limits.stagingTtlMs <= 0)
  ) {
    throw new WebAttachmentStagingError(
      "INVALID_LIMITS",
      "stagingTtlMs must be a positive integer",
    );
  }
  if (limits.maxAttachmentBytes > limits.maxTotalBytes) {
    throw new WebAttachmentStagingError(
      "INVALID_LIMITS",
      "maxAttachmentBytes cannot exceed maxTotalBytes",
    );
  }
  if (limits.maxTotalBytes > limits.maxStagedBytes) {
    throw new WebAttachmentStagingError(
      "INVALID_LIMITS",
      "maxTotalBytes cannot exceed maxStagedBytes",
    );
  }
}

function validateBinding(binding: WebAttachmentBinding) {
  if (
    !isAbsolute(binding.workspace) ||
    binding.sessionId.length === 0 ||
    binding.sessionId.length > 160 ||
    binding.commandId.length === 0 ||
    binding.commandId.length > 160
  ) {
    throw new WebAttachmentStagingError(
      "INVALID_BINDING",
      "attachment binding must identify an absolute workspace and bounded Session and command ids",
    );
  }
}

function sameBinding(
  expected: WebAttachmentBinding,
  actual: WebAttachmentBinding,
) {
  return (
    expected.workspace === actual.workspace &&
    expected.sessionId === actual.sessionId &&
    expected.commandId === actual.commandId
  );
}

function isContained(parent: string, child: string) {
  const path = relative(parent, child);
  return path.length > 0 && path !== ".." && !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(path);
}

function settledReceipt(record: StagingRecord) {
  return {
    status: "settled" as const,
    outcome: record.status as "consumed" | "discarded" | "failed",
  };
}

export class WebAttachmentStagingStore {
  private readonly records = new Map<string, StagingRecord>();
  private readonly directory: string;
  private readonly limits: WebAttachmentStagingLimits;
  private mutation = Promise.resolve();
  private stagedBytes = 0;
  private closing = false;
  private disposePromise?: Promise<void>;

  private constructor(directory: string, limits: WebAttachmentStagingLimits) {
    this.directory = directory;
    this.limits = limits;
  }

  static async create(
    parentDirectory: string,
    limits: WebAttachmentStagingLimits,
  ) {
    validateLimits(limits);
    await mkdir(parentDirectory, { recursive: true, mode: 0o700 });
    const parent = await realpath(parentDirectory);
    const ttl = limits.stagingTtlMs ?? DEFAULT_STAGING_TTL_MS;
    const now = Date.now();
    for (const entry of await readdir(parent)) {
      if (!entry.startsWith(".openpi-web-attachments-")) continue;
      const candidate = join(parent, entry);
      try {
        const candidateStat = await lstat(candidate);
        if (
          candidateStat.isDirectory() &&
          now - candidateStat.mtimeMs > ttl
        ) {
          await rm(candidate, { recursive: true, force: true });
        }
      } catch {
        // Another process may have reclaimed the abandoned root already.
      }
    }
    const directory = await mkdtemp(join(parent, ".openpi-web-attachments-"));
    await chmod(directory, 0o700);
    return new WebAttachmentStagingStore(directory, limits);
  }

  stage(binding: WebAttachmentBinding, payloads: readonly WebAttachmentPayload[]) {
    if (this.closing) {
      return Promise.reject(
        new WebAttachmentStagingError("STORE_CLOSED", "attachment store is closed"),
      );
    }
    return this.exclusive(async () => {
      this.assertOpen();
      validateBinding(binding);
      const totalBytes = this.validatePayloads(payloads);
      if (this.stagedBytes + totalBytes > this.limits.maxStagedBytes) {
        throw new WebAttachmentStagingError(
          "STORE_LIMIT",
          "attachment staging store byte limit exceeded",
        );
      }

      const id = randomUUID();
      const directory = join(this.directory, id);
      const attachments: StoredAttachment[] = [];
      await mkdir(directory, { mode: 0o700 });
      try {
        for (const [index, payload] of payloads.entries()) {
          const path = join(directory, `${index}-${randomUUID()}.payload`);
          const handle = await open(path, "wx", 0o600);
          try {
            await handle.writeFile(payload.bytes);
          } finally {
            await handle.close();
          }
          attachments.push({
            path,
            name: payload.name,
            mime: payload.mime,
            size: payload.bytes.byteLength,
          });
        }
      } catch (error) {
        await rm(directory, { recursive: true, force: true });
        throw error;
      }

      this.records.set(id, {
        id,
        binding: { ...binding },
        directory,
        attachments,
        totalBytes,
        status: "staged",
      });
      this.stagedBytes += totalBytes;
      return { id, count: attachments.length, totalBytes };
    });
  }

  consume(id: string, binding: WebAttachmentBinding) {
    return this.exclusive(async (): Promise<WebAttachmentConsumeReceipt> => {
      this.assertOpen();
      validateBinding(binding);
      const record = this.records.get(id);
      if (!record) return { status: "missing" };
      if (!sameBinding(record.binding, binding)) return { status: "stale" };
      if (record.status !== "staged") return settledReceipt(record);

      record.status = "consumed";
      record.settledAt = Date.now();
      try {
        const directory = await realpath(record.directory);
        const directoryStat = await lstat(directory);
        if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
          throw new Error("invalid staging directory");
        }
        const attachments: WebAttachmentPayload[] = [];
        for (const attachment of record.attachments) {
          const fileStat = await lstat(attachment.path);
          const canonicalPath = await realpath(attachment.path);
          if (
            !fileStat.isFile() ||
            fileStat.isSymbolicLink() ||
            !isContained(directory, canonicalPath) ||
            fileStat.size !== attachment.size
          ) {
            throw new Error("invalid staged attachment");
          }
          const bytes = await readFile(canonicalPath);
          if (bytes.byteLength !== attachment.size) {
            throw new Error("staged attachment changed while reading");
          }
          attachments.push({
            name: attachment.name,
            mime: attachment.mime,
            bytes,
          });
        }
        await this.cleanupRecord(record);
        this.trimSettledReceipts();
        return { status: "consumed", attachments };
      } catch {
        record.status = "failed";
        try {
          await this.cleanupRecord(record);
        } catch {
          // dispose() retries removal of the store-owned root.
        }
        this.trimSettledReceipts();
        return {
          status: "failed",
          error: "staged attachment integrity check failed",
        };
      }
    });
  }

  discard(id: string, binding: WebAttachmentBinding) {
    return this.exclusive(async (): Promise<WebAttachmentDiscardReceipt> => {
      this.assertOpen();
      validateBinding(binding);
      const record = this.records.get(id);
      if (!record) return { status: "missing" };
      if (!sameBinding(record.binding, binding)) return { status: "stale" };
      if (record.status !== "staged") return settledReceipt(record);
      record.status = "discarded";
      record.settledAt = Date.now();
      await this.cleanupRecord(record);
      this.trimSettledReceipts();
      return { status: "discarded" };
    });
  }

  dispose() {
    if (this.disposePromise) return this.disposePromise;
    this.closing = true;
    this.disposePromise = this.exclusive(async () => {
      await rm(this.directory, { recursive: true, force: true });
      this.records.clear();
      this.stagedBytes = 0;
    });
    return this.disposePromise;
  }

  private validatePayloads(payloads: readonly WebAttachmentPayload[]) {
    if (payloads.length === 0 || payloads.length > this.limits.maxAttachments) {
      throw new WebAttachmentStagingError(
        "ATTACHMENT_LIMIT",
        `attachment count must be between 1 and ${this.limits.maxAttachments}`,
      );
    }
    let totalBytes = 0;
    for (const payload of payloads) {
      if (
        typeof payload.name !== "string" ||
        Buffer.byteLength(payload.name, "utf8") > MAX_ATTACHMENT_NAME_BYTES ||
        typeof payload.mime !== "string" ||
        Buffer.byteLength(payload.mime, "utf8") > MAX_ATTACHMENT_MIME_BYTES
      ) {
        throw new WebAttachmentStagingError(
          "INVALID_PAYLOAD",
          "attachment name and mime metadata must be bounded strings",
        );
      }
      if (payload.bytes.byteLength > this.limits.maxAttachmentBytes) {
        throw new WebAttachmentStagingError(
          "BYTE_LIMIT",
          "attachment exceeds the staging per-file byte limit",
        );
      }
      totalBytes += payload.bytes.byteLength;
      if (totalBytes > this.limits.maxTotalBytes) {
        throw new WebAttachmentStagingError(
          "BYTE_LIMIT",
          "attachments exceed the staging aggregate byte limit",
        );
      }
    }
    return totalBytes;
  }

  private async cleanupRecord(record: StagingRecord) {
    await rm(record.directory, { recursive: true, force: true });
    this.stagedBytes = Math.max(0, this.stagedBytes - record.totalBytes);
  }

  private trimSettledReceipts() {
    const settled = [...this.records.values()]
      .filter((record) => record.status !== "staged")
      .sort((left, right) => (left.settledAt ?? 0) - (right.settledAt ?? 0));
    const removeCount = settled.length - this.limits.maxSettledReceipts;
    for (const record of settled.slice(0, Math.max(0, removeCount))) {
      this.records.delete(record.id);
    }
  }

  private assertOpen() {
    if (this.closing) {
      throw new WebAttachmentStagingError(
        "STORE_CLOSED",
        "attachment store is closed",
      );
    }
  }

  private exclusive<T>(operation: () => Promise<T>) {
    const previous = this.mutation;
    let release: () => void = () => undefined;
    this.mutation = new Promise<void>((resolve) => {
      release = resolve;
    });
    return (async () => {
      await previous;
      try {
        return await operation();
      } finally {
        release();
      }
    })();
  }
}
