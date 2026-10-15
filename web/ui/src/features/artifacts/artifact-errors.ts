import type { TFunction } from "i18next";
import { WebApiError } from "../../protocol/client.ts";

export interface ArtifactFailure {
  reason: unknown;
  fallback:
    | "filesReadFailed"
    | "artifactDownloadFailed"
    | "artifactImagePreviewFailed";
}

const artifactErrorKeys = {
  ARTIFACT_DENIED: "artifactErrorDenied",
  ARTIFACT_LIMIT: "artifactErrorLimit",
  ARTIFACT_EXPIRED: "artifactErrorExpired",
  ARTIFACT_BUSY: "artifactErrorBusy",
  ARTIFACT_UNSUPPORTED: "artifactErrorUnsupported",
  ARTIFACT_TOO_LARGE: "artifactErrorTooLarge",
  ARTIFACT_CHANGED: "artifactErrorChanged",
  ARTIFACT_MISSING: "artifactErrorMissing",
  ARTIFACT_READ_ERROR: "artifactErrorRead",
  ARTIFACT_DOWNLOAD_BODY: "artifactErrorDownloadBody",
} as const;

export function artifactErrorText(error: ArtifactFailure, t: TFunction) {
  const { reason } = error;
  if (
    reason instanceof WebApiError &&
    reason.code &&
    Object.hasOwn(artifactErrorKeys, reason.code)
  ) {
    return t(artifactErrorKeys[reason.code as keyof typeof artifactErrorKeys]);
  }
  return reason instanceof Error ? reason.message : t(error.fallback);
}
