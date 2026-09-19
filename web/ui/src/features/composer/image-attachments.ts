import {
  WEB_PROMPT_IMAGE_MAX_BYTES,
  type WebPromptImage,
} from "../../../../protocol/types.ts";

export interface StagedPromptImage extends WebPromptImage {
  id: string;
  name: string;
  size: number;
  previewUrl: string;
}

function matches(bytes: Uint8Array, signature: readonly number[]) {
  return signature.every((value, index) => bytes[index] === value);
}

export function sniffPromptImageMime(bytes: Uint8Array) {
  if (matches(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    return "image/png" as const;
  if (matches(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg" as const;
  const header = new TextDecoder("ascii").decode(bytes.subarray(0, 12));
  if (header.startsWith("GIF87a") || header.startsWith("GIF89a"))
    return "image/gif" as const;
  if (header.startsWith("RIFF") && header.slice(8, 12) === "WEBP")
    return "image/webp" as const;
  return null;
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  const chunkSize = 32_768;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + chunkSize),
    );
  }
  return btoa(binary);
}

export async function stagePromptImage(file: File) {
  if (file.size <= 0 || file.size > WEB_PROMPT_IMAGE_MAX_BYTES)
    throw new Error("image-size");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const mimeType = sniffPromptImageMime(bytes);
  if (!mimeType) throw new Error("image-type");
  const data = bytesToBase64(bytes);
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${file.name}`,
    name: file.name || "image",
    size: bytes.length,
    mimeType,
    data,
    previewUrl: `data:${mimeType};base64,${data}`,
  } satisfies StagedPromptImage;
}
