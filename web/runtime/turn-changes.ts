import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  mkdir,
  open,
  readFile,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, relative } from "node:path";
import {
  createEditToolDefinition,
  defineTool,
  generateUnifiedPatch,
  type InlineExtension,
  type SessionManager,
} from "@earendil-works/pi-coding-agent";
import { countGitDiffLines } from "../host/git-review.ts";
import { jsonByteLength, type WebGitReviewFile } from "../protocol/types.ts";
import {
  WEB_MAX_TURN_CHANGE_FILES,
  WEB_MAX_TURN_CHANGE_RECORD_BYTES,
  WEB_TURN_CHANGES_ENTRY,
  type WebTurnChangesDetail,
} from "../protocol/turn-changes.ts";
import { createEvidenceWriteTool } from "./write-evidence.ts";

const FILE_BYTES = 256 * 1024;
const TURN_BYTES = 8 * 1024 * 1024;
interface Observation {
  hash: string;
  text?: string;
  stamp?: string;
  binary?: boolean;
}
interface EditEvidence {
  path: string;
  before?: Observation;
  after: Observation;
  uncertain?: WebGitReviewFile["statsUnavailable"];
}
interface PendingTurn {
  sessionId: string;
  beforeEntryId: string | null;
  files: Map<string, EditEvidence>;
  bytes: number;
  incomplete: boolean;
}

async function fingerprint(path: string) {
  const info = await stat(path, { bigint: true });
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
}
function absent(): Observation {
  return { hash: "absent", text: "" };
}
function observe(content: string | Buffer, turn: PendingTurn): Observation {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const binary = bytes.includes(0) || bytes.toString("utf8").includes("\uFFFD");
  const keep =
    !binary &&
    bytes.length <= FILE_BYTES &&
    turn.bytes + bytes.length <= TURN_BYTES;
  if (keep) turn.bytes += bytes.length;
  return {
    hash: createHash("sha256").update(bytes).digest("hex"),
    ...(binary ? { binary } : {}),
    ...(keep ? { text: bytes.toString("utf8") } : {}),
  };
}
function promptEntryId(manager: SessionManager, turn: PendingTurn) {
  if (manager.getSessionId() !== turn.sessionId) return undefined;
  const branch = manager.getBranch();
  const before =
    turn.beforeEntryId === null
      ? -1
      : branch.findIndex((entry) => entry.id === turn.beforeEntryId);
  if (turn.beforeEntryId !== null && before < 0) return undefined;
  return branch
    .slice(before + 1)
    .find((entry) => entry.type === "message" && entry.message.role === "user")
    ?.id;
}

function savedChanges(turn: PendingTurn, id: string): WebTurnChangesDetail {
  const files: WebGitReviewFile[] = [];
  for (const edit of turn.files.values()) {
    if (!edit.uncertain && edit.before?.hash === edit.after.hash) continue;
    const binary = edit.before?.binary || edit.after.binary;
    const reason =
      edit.uncertain ??
      (!edit.before
        ? "before_unavailable"
        : edit.before.text === undefined || edit.after.text === undefined
          ? "content_limit"
          : undefined);
    const diff =
      !reason && !binary
        ? generateUnifiedPatch(edit.path, edit.before!.text!, edit.after.text!)
        : "";
    files.push({
      path: edit.path,
      status: edit.before?.hash === "absent" ? "added" : "modified",
      diff,
      diffLoaded: true,
      diffTruncated: Boolean(reason),
      ...countGitDiffLines(diff),
      ...(binary ? { binary: true } : {}),
      ...(reason ? { statsUnavailable: reason } : {}),
    });
  }
  const record: WebTurnChangesDetail = {
    version: 2,
    source: "file-tools",
    sessionId: turn.sessionId,
    promptEntryId: id,
    state:
      turn.incomplete || files.some((file) => file.diffTruncated)
        ? "partial"
        : "complete",
    fileCount: turn.incomplete ? null : files.length,
    files,
    additions: files.reduce((n, file) => n + file.additions, 0),
    deletions: files.reduce((n, file) => n + file.deletions, 0),
  };
  // Preview limits do not erase confirmed file identities or known line counts.
  for (const file of [...files].reverse()) {
    if (jsonByteLength(record) <= WEB_MAX_TURN_CHANGE_RECORD_BYTES) break;
    file.diff = "";
    file.diffTruncated = true;
    record.state = "partial";
  }
  while (
    jsonByteLength(record) > WEB_MAX_TURN_CHANGE_RECORD_BYTES &&
    files.length
  ) {
    files.pop();
    record.fileCount = null;
    record.state = "partial";
  }
  record.additions = files.reduce((n, file) => n + file.additions, 0);
  record.deletions = files.reduce((n, file) => n + file.deletions, 0);
  return record;
}

/** Observe native local write operations inside Pi's admission and mutation queue. */
export function createTurnChangeRecorder(manager: SessionManager, cwd: string) {
  let pending: PendingTurn | undefined;
  const settle = () => {
    const turn = pending;
    pending = undefined;
    if (!turn) return;
    const id = promptEntryId(manager, turn);
    if (!id) return;
    try {
      manager.appendCustomEntry(WEB_TURN_CHANGES_ENTRY, savedChanges(turn, id));
    } catch {
      /* Optional UI evidence must never change the native turn outcome. */
    }
  };
  const extension: InlineExtension = {
    name: "openpi-web-turn-changes",
    hidden: true,
    factory(pi) {
      pi.on("message_start", (event) => {
        if (event.message.role !== "user") return;
        settle();
        pending = {
          sessionId: manager.getSessionId(),
          beforeEntryId: manager.getLeafId(),
          files: new Map(),
          bytes: 0,
          incomplete: false,
        };
      });
      pi.on("agent_settled", settle);
      pi.on("session_shutdown", () => {
        pending = undefined;
      });
    },
  };

  function operations(turn: PendingTurn | undefined) {
    let readObservation: Observation | undefined;
    return {
      access: (path: string) => access(path, constants.R_OK | constants.W_OK),
      mkdir: async (path: string) => {
        await mkdir(path, { recursive: true });
      },
      readFile: async (path: string) => {
        // This read is requested by the native edit tool, never added to write.
        const before = await fingerprint(path).catch(() => undefined);
        const bytes = await readFile(path);
        if (turn) {
          try {
            readObservation = observe(bytes, turn);
            const after = await fingerprint(path).catch(() => undefined);
            if (before === after) readObservation.stamp = after;
          } catch {
            turn.incomplete = true;
          }
        }
        return bytes;
      },
      writeFile: async (path: string, content: string) => {
        if (!turn) return writeFile(path, content, "utf8");
        const stamp = await fingerprint(path).catch(() => undefined);
        const canonical = await realpath(path)
          .catch(
            async () => `${await realpath(dirname(path))}/${basename(path)}`,
          )
          .catch(() => path);
        const previous = turn.files.get(canonical);
        let before =
          readObservation ??
          (stamp && stamp === previous?.after.stamp
            ? previous.after
            : undefined);
        let uncertain: EditEvidence["uncertain"] =
          readObservation && (!stamp || readObservation.stamp !== stamp)
            ? "concurrent_change"
            : undefined;
        // Exclusive creation proves absence without reading an unauthorized old file.
        let created = false;
        try {
          if (!stamp) {
            const handle = await open(path, "wx").catch(
              (error: NodeJS.ErrnoException) => {
                if (error.code === "EEXIST") return undefined;
                throw error;
              },
            );
            if (handle) {
              try {
                await handle.writeFile(content, "utf8");
                created = true;
                before = absent();
              } finally {
                await handle.close();
              }
            }
          }
          if (!created) await writeFile(path, content, "utf8");
        } catch (error) {
          // An I/O failure can leave partial bytes behind; do not claim a complete inventory.
          turn.incomplete = true;
          throw error;
        }
        // Record completed writes even if Pi observes cancellation immediately after this await.
        if (pending !== turn || manager.getSessionId() !== turn.sessionId)
          return;
        try {
          const after = observe(content, turn);
          after.stamp = await fingerprint(path).catch(() => undefined);
          const root = await realpath(cwd).catch(() => cwd);
          const displayPath = relative(root, canonical) || basename(canonical);
          if (displayPath.length > 2_000) {
            turn.incomplete = true;
            return;
          }
          const latest = turn.files.get(canonical);
          if (!latest && turn.files.size >= WEB_MAX_TURN_CHANGE_FILES) {
            turn.incomplete = true;
            return;
          }
          if (
            latest !== previous ||
            (latest && (!before || latest.after.hash !== before.hash))
          )
            uncertain = "concurrent_change";
          turn.files.set(canonical, {
            path: displayPath,
            before: latest ? latest.before : before,
            after,
            uncertain: latest?.uncertain ?? uncertain,
          });
        } catch {
          turn.incomplete = true;
        }
      },
    };
  }
  const nativeEdit = createEditToolDefinition(cwd);
  const editTool = defineTool({
    ...nativeEdit,
    execute: (...args: Parameters<typeof nativeEdit.execute>) =>
      createEditToolDefinition(cwd, {
        operations: operations(pending),
      }).execute(...args),
  });
  const nativeWrite = createEvidenceWriteTool(cwd);
  const writeTool = {
    ...nativeWrite,
    execute: (...args: Parameters<typeof nativeWrite.execute>) =>
      createEvidenceWriteTool(cwd, { operations: operations(pending) }).execute(
        ...args,
      ),
  };
  return { extension, editTool, writeTool };
}
