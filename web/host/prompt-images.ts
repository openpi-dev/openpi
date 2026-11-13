import { createHash } from "node:crypto";
import {
  WEB_PROMPT_IMAGE_MAX_BYTES,
  WEB_PROMPT_IMAGE_MAX_COUNT,
  WEB_PROMPT_IMAGE_MAX_TOTAL_BYTES,
  type WebPromptImage,
} from "../protocol/types.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const promptImageMimeTypes = new Set<WebPromptImage["mimeType"]>([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

function hasImageSignature(bytes: Buffer, mimeType: WebPromptImage["mimeType"]) {
  if (mimeType === "image/png")
    return bytes
      .subarray(0, 8)
      .equals(Buffer.from("89504e470d0a1a0a", "hex"));
  if (mimeType === "image/jpeg")
    return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mimeType === "image/gif") {
    const signature = bytes.subarray(0, 6);
    return signature.equals(Buffer.from("GIF87a")) || signature.equals(Buffer.from("GIF89a"));
  }
  return (
    bytes.subarray(0, 4).equals(Buffer.from("RIFF")) &&
    bytes.subarray(8, 12).equals(Buffer.from("WEBP"))
  );
}

export function parsePromptImages(value: unknown) {
  if (value === undefined)
    return { ok: true as const, images: [] as WebPromptImage[], bytes: 0 };
  if (!Array.isArray(value) || value.length > WEB_PROMPT_IMAGE_MAX_COUNT)
    return { ok: false as const, error: "prompt images exceed the count limit" };
  const images: WebPromptImage[] = [];
  let totalBytes = 0;
  for (const item of value) {
    if (!isRecord(item))
      return { ok: false as const, error: "prompt images must be objects" };
    const mimeType = item.mimeType;
    const data = item.data;
    const name = item.name;
    if (
      typeof mimeType !== "string" ||
      !promptImageMimeTypes.has(mimeType as WebPromptImage["mimeType"]) ||
      typeof data !== "string" ||
      data.length === 0 ||
      (name !== undefined &&
        (typeof name !== "string" || name.length === 0 || name.length > 255)) ||
      Object.keys(item).some(
        (key) => !["data", "mimeType", "name"].includes(key),
      )
    ) {
      return { ok: false as const, error: "prompt image metadata is invalid" };
    }
    if (data.length > Math.ceil(WEB_PROMPT_IMAGE_MAX_BYTES / 3) * 4)
      return { ok: false as const, error: "prompt image data is invalid or too large" };
    const bytes = Buffer.from(data, "base64");
    if (bytes.toString("base64") !== data)
      return { ok: false as const, error: "prompt image metadata is invalid" };
    if (
      bytes.length === 0 ||
      bytes.length > WEB_PROMPT_IMAGE_MAX_BYTES ||
      !hasImageSignature(bytes, mimeType as WebPromptImage["mimeType"])
    ) {
      return {
        ok: false as const,
        error: "prompt image data is invalid or too large",
      };
    }
    totalBytes += bytes.length;
    if (totalBytes > WEB_PROMPT_IMAGE_MAX_TOTAL_BYTES)
      return {
        ok: false as const,
        error: "prompt images exceed the total size limit",
      };
    images.push({
      data,
      mimeType: mimeType as WebPromptImage["mimeType"],
      ...(typeof name === "string" ? { name } : {}),
    });
  }
  return { ok: true as const, images, bytes: totalBytes };
}

export function promptImageSignature(images: readonly WebPromptImage[]) {
  const hash = createHash("sha256");
  for (const image of images) {
    hash.update(image.mimeType);
    hash.update("\0");
    hash.update(image.name ?? "");
    hash.update("\0");
    hash.update(image.data);
    hash.update("\0");
  }
  return hash.digest("hex");
}
