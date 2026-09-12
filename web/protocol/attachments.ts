export const WEB_MAX_ATTACHMENTS = 8;
export const WEB_MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024;
export const WEB_MAX_ATTACHMENT_TOTAL_BYTES = 8 * 1024 * 1024;

const SAFE_FILENAME = /^(?!\.\.?(?:$|\.))[\w .()\[\]-]{1,120}$/u;
const SUPPORTED_MIME = new Set([
  "text/plain",
  "text/markdown",
  "application/json",
  "image/png",
  "image/jpeg",
  "image/webp",
]);

export interface WebAttachmentInput {
  readonly name: string;
  readonly mime: string;
  readonly size: number;
}

export function validateWebAttachments(attachments: readonly WebAttachmentInput[]) {
  if (attachments.length > WEB_MAX_ATTACHMENTS) {
    return { ok: false as const, error: `at most ${WEB_MAX_ATTACHMENTS} attachments are allowed` };
  }
  let total = 0;
  for (const attachment of attachments) {
    if (!SAFE_FILENAME.test(attachment.name) || attachment.name.includes("..")) {
      return { ok: false as const, error: `invalid attachment name: ${attachment.name}` };
    }
    if (!SUPPORTED_MIME.has(attachment.mime)) {
      return { ok: false as const, error: `unsupported attachment type: ${attachment.mime}` };
    }
    if (!Number.isSafeInteger(attachment.size) || attachment.size < 0 || attachment.size > WEB_MAX_ATTACHMENT_BYTES) {
      return { ok: false as const, error: `attachment exceeds ${WEB_MAX_ATTACHMENT_BYTES} byte limit` };
    }
    total += attachment.size;
    if (total > WEB_MAX_ATTACHMENT_TOTAL_BYTES) {
      return { ok: false as const, error: `attachments exceed ${WEB_MAX_ATTACHMENT_TOTAL_BYTES} byte total` };
    }
  }
  return { ok: true as const };
}
