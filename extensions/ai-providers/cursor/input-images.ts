import { readFile, stat } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import type {
  ExtensionContext,
  InputEvent,
  InputEventResult,
} from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai/compat";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

function leadingPath(text: string): { path: string; end: number } | undefined {
  const match = /^\s*(?:"([^"\n]+)"|'([^'\n]+)'|(\S+))/.exec(text);
  if (!match) return undefined;
  const value = match[1] ?? match[2] ?? match[3];
  if (!value || !isAbsolute(value)) return undefined;
  if (!/\.(?:png|jpe?g|gif|webp)$/i.test(value)) return undefined;
  return { path: value, end: match[0].length };
}

function detectImageMimeType(
  bytes: Uint8Array,
): ImageContent["mimeType"] | undefined {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return "image/jpeg";
  }
  if (bytes.length >= 6) {
    const signature = Buffer.from(bytes.subarray(0, 6)).toString("ascii");
    if (signature === "GIF87a" || signature === "GIF89a") return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF" &&
    Buffer.from(bytes.subarray(8, 12)).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return undefined;
}

/**
 * Pi's TUI represents a clipboard image as a leading local path. Cursor's
 * chat-only provider cannot ask a native read-file tool to resolve that path,
 * so convert an explicit leading image path into the same ImageContent shape
 * used by CLI/RPC attachments before the agent turn starts.
 */
export async function transformCursorImageInput(
  event: InputEvent,
  ctx: ExtensionContext,
): Promise<InputEventResult> {
  if (
    event.source !== "interactive" ||
    ctx.model?.provider !== "cursor" ||
    (event.images?.length ?? 0) > 0
  ) {
    return { action: "continue" };
  }

  const candidate = leadingPath(event.text);
  if (!candidate) return { action: "continue" };

  try {
    const file = await stat(candidate.path);
    if (!file.isFile() || file.size === 0 || file.size > MAX_IMAGE_BYTES) {
      return { action: "continue" };
    }
    const bytes = await readFile(candidate.path);
    if (bytes.length > MAX_IMAGE_BYTES) return { action: "continue" };
    const mimeType = detectImageMimeType(bytes);
    if (!mimeType) return { action: "continue" };

    const question = event.text.slice(candidate.end).trimStart();
    const attachment = `Attached image: ${JSON.stringify(basename(candidate.path))}`;
    return {
      action: "transform",
      text: question ? `${attachment}\n${question}` : attachment,
      images: [
        {
          type: "image",
          data: bytes.toString("base64"),
          mimeType,
        },
      ],
    };
  } catch {
    return { action: "continue" };
  }
}
