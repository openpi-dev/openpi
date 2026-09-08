import { mkdir, open, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { createWriteToolDefinition, defineTool, generateDiffString } from "@earendil-works/pi-coding-agent";

const MAX_BYTES = 32 * 1024;
const MAX_LINES = 1000;

function boundedDiff(before: string, after: string) {
  const raw = before === after ? "" : generateDiffString(before, after).diff;
  const lines = raw.split("\n");
  const bytes = Buffer.from(lines.slice(0, 300).join("\n"));
  let end = Math.min(bytes.length, 12 * 1024);
  while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
  // Retain raw evidence in Session results; sanitization belongs to Web projection.
  return { text: bytes.subarray(0, end).toString("utf8"), truncated: end < bytes.length || lines.length > 300 };
}

async function snapshot(path: string) {
  const file = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(MAX_BYTES)) throw new Error("unavailable");
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const after = await file.stat({ bigint: true });
    if (BigInt(length) !== before.size || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) throw new Error("changed");
    const bytes = buffer.subarray(0, length);
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    if (text.includes("\0") || text.split("\n").length > MAX_LINES) throw new Error("unavailable");
    return text;
  } finally { await file.close(); }
}

/** Capture inside Pi's native per-file mutation queue. Keep its schema,
 * cancellation and write behavior; attach evidence only after native success. */
export function createEvidenceWriteTool(cwd: string) {
  const native = createWriteToolDefinition(cwd);
  return defineTool({
    ...native,
    renderResult: undefined,
    execute: async (...args: Parameters<typeof native.execute>) => {
      let details: { diff?: string; change?: string; evidenceUnavailable?: string; truncation?: { truncated: boolean } } = {};
      const tool = createWriteToolDefinition(cwd, {
        operations: {
          mkdir: async (path) => { await mkdir(path, { recursive: true }); },
          writeFile: async (path, content) => {
            let before: string | undefined;
            let created = false;
            try { before = await snapshot(path); }
            catch (error) {
              if ((error as NodeJS.ErrnoException).code === "ENOENT") { before = ""; created = true; }
            }
            await writeFile(path, content, "utf-8");
            // Evidence failure must never turn a successful write into a failure.
            try {
              if (before === undefined || Buffer.byteLength(content) > MAX_BYTES || content.split("\n").length > MAX_LINES) throw new Error("unavailable");
              const after = await snapshot(path);
              if (after !== content) throw new Error("changed");
              const diff = boundedDiff(before, after);
              details = { diff: diff.text, change: created ? "created" : before === after ? "unchanged" : "overwritten", truncation: { truncated: diff.truncated } };
            } catch {
              details = { evidenceUnavailable: "Write succeeded, but a stable text comparison within 32 KiB / 1000 lines could not be captured." };
            }
          },
        },
      });
      const result = await tool.execute(...args);
      return { ...result, details };
    },
  });
}
