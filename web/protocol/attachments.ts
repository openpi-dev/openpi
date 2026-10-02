export const WEB_MAX_ATTACHMENTS = 8;
export const WEB_MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024;
export const WEB_MAX_ATTACHMENT_TOTAL_BYTES = 8 * 1024 * 1024;

const MIME_EXTENSIONS = new Map<string, readonly string[]>([
  ["text/plain", [".txt", ".log"]],
  ["text/markdown", [".md", ".markdown"]],
  ["application/json", [".json"]],
  ["image/png", [".png"]],
  ["image/jpeg", [".jpg", ".jpeg"]],
  ["image/webp", [".webp"]],
]);

export interface WebAttachmentInput {
  readonly name: string;
  readonly mime: string;
  readonly size: number;
}

function isSafeAttachmentName(name: string) {
  if (name.length < 1 || name.length > 120) return false;
  if (name === "." || name === "..") return false;
  if (name.includes("..") || name.includes("/") || name.includes("\\")) {
    return false;
  }
  return !/[\u0000-\u001f\u007f]/u.test(name);
}

function extensionOf(name: string) {
  const separator = name.lastIndexOf(".");
  if (separator <= 0 || separator === name.length - 1) return "";
  return name.slice(separator).toLowerCase();
}

function matchesMimeExtension(name: string, mime: string) {
  const extensions = MIME_EXTENSIONS.get(mime);
  if (!extensions) return false;
  return extensions.includes(extensionOf(name));
}

export function validateWebAttachments(
  attachments: readonly WebAttachmentInput[],
) {
  if (attachments.length > WEB_MAX_ATTACHMENTS) {
    return {
      ok: false as const,
      error: `at most ${WEB_MAX_ATTACHMENTS} attachments are allowed`,
    };
  }
  let total = 0;
  for (const attachment of attachments) {
    if (!isSafeAttachmentName(attachment.name)) {
      return {
        ok: false as const,
        error: `invalid attachment name: ${attachment.name}`,
      };
    }
    if (!MIME_EXTENSIONS.has(attachment.mime)) {
      return {
        ok: false as const,
        error: "unsupported attachment type",
      };
    }
    if (!matchesMimeExtension(attachment.name, attachment.mime)) {
      return {
        ok: false as const,
        error: "attachment extension does not match type",
      };
    }
    if (
      !Number.isSafeInteger(attachment.size) ||
      attachment.size < 0 ||
      attachment.size > WEB_MAX_ATTACHMENT_BYTES
    ) {
      return {
        ok: false as const,
        error: `attachment exceeds ${WEB_MAX_ATTACHMENT_BYTES} byte limit`,
      };
    }
    total += attachment.size;
    if (total > WEB_MAX_ATTACHMENT_TOTAL_BYTES) {
      return {
        ok: false as const,
        error: `attachments exceed ${WEB_MAX_ATTACHMENT_TOTAL_BYTES} byte total`,
      };
    }
  }
  return { ok: true as const };
}
