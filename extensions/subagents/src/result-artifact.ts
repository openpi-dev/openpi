import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  formatSize,
  truncateHead,
  truncateTail,
} from "@earendil-works/pi-coding-agent";

const HEAD_SHARE = 0.75;
const RESULT_ARTIFACT_DIR = ["cache", "openpi", "subagent-results"];

export interface ResultProjectionOptions {
  readonly maxBytes: number;
  readonly maxLines: number;
  readonly writeArtifact: (content: string) => string;
}

export interface ResultProjection {
  readonly text: string;
  readonly truncated: boolean;
  readonly artifactPath?: string;
  readonly artifactSaveFailed?: boolean;
}

function sliceStartToUtf8Bytes(content: string, maxBytes: number) {
  const bytes = Buffer.from(content, "utf8");
  if (bytes.length <= maxBytes) return content;
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
}

function ensureDirectory(parent: string, name: string) {
  const directory = path.join(parent, name);
  try {
    mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Unsafe result artifact directory: ${directory}`);
  }
  return directory;
}

/**
 * Persist one immutable, content-addressed final answer below Pi's cache.
 * Model-authored titles and paths never participate in the filename.
 */
export function persistResultArtifact(agentDir: string, content: string) {
  let directory = path.resolve(agentDir);
  for (const segment of RESULT_ARTIFACT_DIR) {
    directory = ensureDirectory(directory, segment);
  }

  const digest = createHash("sha256").update(content).digest("hex");
  const artifactPath = path.join(directory, `${digest}.txt`);
  try {
    writeFileSync(artifactPath, content, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const stat = lstatSync(artifactPath);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      readFileSync(artifactPath, "utf8") !== content
    ) {
      throw new Error(`Result artifact collision: ${artifactPath}`);
    }
  }
  return artifactPath;
}

/** Persist one complete validated structured value under a JSON identity. */
export function persistStructuredResultArtifact(
  agentDir: string,
  content: string,
) {
  let directory = path.resolve(agentDir);
  for (const segment of RESULT_ARTIFACT_DIR) {
    directory = ensureDirectory(directory, segment);
  }

  const digest = createHash("sha256").update(content).digest("hex");
  const artifactPath = path.join(directory, `${digest}.json`);
  try {
    writeFileSync(artifactPath, content, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const stat = lstatSync(artifactPath);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      readFileSync(artifactPath, "utf8") !== content
    ) {
      throw new Error(`Structured result artifact collision: ${artifactPath}`);
    }
  }
  return artifactPath;
}

/**
 * Build the single model-visible projection used by automatic delivery and
 * explicit waits. Short answers pass through byte-for-byte. Long answers keep
 * both decision context at the start and verdict/evidence at the end, while a
 * plain-text artifact preserves the exact final answer for Pi's native read.
 */
export function projectResult(
  content: string,
  options: ResultProjectionOptions,
): ResultProjection {
  const probe = truncateHead(content, {
    maxBytes: options.maxBytes,
    maxLines: options.maxLines,
  });
  if (!probe.truncated) return { text: content, truncated: false };

  const headLines = Math.max(1, Math.floor(options.maxLines * HEAD_SHARE));
  const tailLines = Math.max(1, options.maxLines - headLines);

  let artifactPath: string | undefined;
  let artifactSaveFailed = false;
  try {
    artifactPath = options.writeArtifact(content);
  } catch {
    // Delivery is more important than the optional recovery cache. The footer
    // below stays explicit so a failed write never advertises a false path.
    artifactSaveFailed = true;
  }

  let bodyBudget = options.maxBytes;
  let text = "";
  for (let attempt = 0; attempt < 8; attempt++) {
    const headBytes = Math.max(1, Math.floor(bodyBudget * HEAD_SHARE));
    const tailBytes = Math.max(1, bodyBudget - headBytes);
    const headResult = truncateHead(content, {
      maxBytes: headBytes,
      maxLines: headLines,
    });
    const tailResult = truncateTail(content, {
      maxBytes: tailBytes,
      maxLines: tailLines,
    });
    const head =
      headResult.content || sliceStartToUtf8Bytes(content, headBytes);
    const tail = tailResult.content;
    const shownBytes =
      Buffer.byteLength(head, "utf8") + Buffer.byteLength(tail, "utf8");
    const recovery = artifactPath
      ? `Full final answer: ${JSON.stringify(artifactPath)}\nUse Pi's read tool with path=${JSON.stringify(artifactPath)}, offset=${Math.max(1, headResult.outputLines + 1)}, limit=200 to inspect the omitted middle; adjust offset to continue.`
      : "Full final answer could not be saved; only the head and tail above are available.";
    const footer =
      `[Output truncated: showing ${formatSize(shownBytes)} of ${formatSize(probe.totalBytes)} ` +
      `across the head and tail (${probe.totalLines} total lines).\n${recovery}]`;
    text = `${head}\n\n[... middle omitted ...]\n\n${tail}\n\n${footer}`;

    const overflow = Buffer.byteLength(text, "utf8") - options.maxBytes;
    if (overflow <= 0 || bodyBudget <= overflow + 2) break;
    bodyBudget -= overflow;
  }

  return {
    text,
    truncated: true,
    ...(artifactPath ? { artifactPath } : {}),
    ...(artifactSaveFailed ? { artifactSaveFailed: true } : {}),
  };
}
