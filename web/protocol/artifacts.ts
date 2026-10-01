export const ARTIFACT_MAX_BYTES = 20 * 1024 * 1024;
export const ARTIFACT_PREVIEW_BYTES = 256 * 1024;
export const ARTIFACT_PREVIEW_LINES = 5_000;
export const ARTIFACT_EDIT_BYTES = 1024 * 1024;
export interface ArtifactMetadata {
  handle: string;
  sessionId: string;
  path: string;
  name: string;
  revision: string;
  bytes: number;
  preview: "text" | "unsupported";
  editable?: boolean;
}
export interface ArtifactPreview {
  identity?: string;
  artifact: ArtifactMetadata;
  text?: string;
  truncated: boolean;
  nextOffset?: number;
}

export interface WorkspaceFileEntry {
  name: string;
  path: string;
  kind: "directory" | "file" | "symlink" | "other";
}

export interface WorkspaceFileListing {
  path: string;
  entries: WorkspaceFileEntry[];
  truncated: boolean;
  nextCursor?: string;
}

export type WorkspaceFileMutation =
  | { kind: "create-file" | "create-directory"; directory: string; name: string }
  | { kind: "import-file"; directory: string; name: string; data: string };

export interface WorkspaceFileMutationResult {
  sessionId: string;
  sessionPath: string;
  path: string;
  kind: "file" | "directory";
  bytes?: number;
}

/** Keep the original reference; URL resolution belongs to the Host. */
export function isLocalArtifactLink(value: string) {
  return Boolean(value.trim()) && !value.startsWith("#") && !value.startsWith("//") &&
    (!/^[a-z][a-z\d+.-]*:/iu.test(value) || /^[a-z]:[\\/]/iu.test(value));
}
