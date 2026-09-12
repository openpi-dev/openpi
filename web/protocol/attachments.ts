export const WEB_MAX_ATTACHMENTS = 8;
export const WEB_MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024;
export const WEB_MAX_ATTACHMENT_TOTAL_BYTES = 8 * 1024 * 1024;
const MIME_EXTENSIONS: Record<string, readonly string[]> = {
  "text/plain": [".txt", ".log"], "text/markdown": [".md", ".markdown"],
  "application/json": [".json"], "image/png": [".png"],
  "image/jpeg": [".jpg", ".jpeg"], "image/webp": [".webp"],
};
export interface WebAttachmentInput { readonly name: string; readonly mime: string; readonly size: number; }
export function validateWebAttachments(attachments: readonly WebAttachmentInput[]) {
  if (attachments.length > WEB_MAX_ATTACHMENTS) return { ok: false as const, error: "too many attachments" };
  let total = 0;
  for (const attachment of attachments) {
    if (!/^(?!\.\.?(?:$|\.))[\w .()\[\]-]{1,120}$/u.test(attachment.name) || attachment.name.includes("..")) return { ok: false as const, error: "invalid attachment name" };
    if (!MIME_EXTENSIONS[attachment.mime]) return { ok: false as const, error: "unsupported attachment type" };
    if (!MIME_EXTENSIONS[attachment.mime].some((extension) => attachment.name.toLocaleLowerCase().endsWith(extension))) return { ok: false as const, error: "attachment extension does not match type" };
    if (!Number.isSafeInteger(attachment.size) || attachment.size < 0 || attachment.size > WEB_MAX_ATTACHMENT_BYTES) return { ok: false as const, error: "attachment exceeds per-file limit" };
    total += attachment.size;
    if (total > WEB_MAX_ATTACHMENT_TOTAL_BYTES) return { ok: false as const, error: "attachments exceed total limit" };
  }
  return { ok: true as const };
}
