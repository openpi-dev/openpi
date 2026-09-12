export const ARTIFACT_MAX_BYTES = 20 * 1024 * 1024;
export const ARTIFACT_PREVIEW_BYTES = 256 * 1024;
export const ARTIFACT_PREVIEW_LINES = 5_000;
export interface ArtifactMetadata {
  handle: string;
  sessionId: string;
  path: string;
  name: string;
  revision: string;
  bytes: number;
  preview: "text" | "unsupported";
}
export interface ArtifactPreview {
  identity?: string;
  artifact: ArtifactMetadata;
  text?: string;
  truncated: boolean;
}

/** Keep the original reference; URL resolution belongs to the Host. */
export function isLocalArtifactLink(value: string) {
  return Boolean(value.trim()) && !value.startsWith("#") && !value.startsWith("//") &&
    (!/^[a-z][a-z\d+.-]*:/iu.test(value) || /^[a-z]:[\\/]/iu.test(value));
}
