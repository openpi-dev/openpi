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
  /** Exact filesystem identity observed by this listing; required for organization. */
  identity?: string;
}

export interface WorkspaceFileListing {
  path: string;
  entries: WorkspaceFileEntry[];
  truncated: boolean;
  nextCursor?: string;
}

export type WorkspaceFileMutation =
  | { kind: "create-file" | "create-directory"; directory: string; name: string }
  | { kind: "import-file"; directory: string; name: string; data: string; createParents?: boolean }
  | { kind: "move"; path: string; identity: string; directory: string; name: string }
  | { kind: "trash"; path: string; identity: string }
  | { kind: "restore"; id: string; identity: string };

export interface WorkspaceTrashEntry {
  id: string;
  path: string;
  kind: "file" | "directory";
  identity: string;
  deletedAt: number;
}

export interface WorkspaceTrashListing {
  sessionId: string;
  sessionPath: string;
  entries: WorkspaceTrashEntry[];
  unavailable?: number;
  nextCursor?: string;
}

export interface WorkspaceFileMutationResult {
  sessionId: string;
  sessionPath: string;
  path: string;
  kind: "file" | "directory";
  bytes?: number;
  trashed?: WorkspaceTrashEntry;
  /** Canonical committed paths, for preserving an existing editor draft on move. */
  moved?: { from: string; to: string };
}

/** Keep the original reference; URL resolution belongs to the Host. */
export function isLocalArtifactLink(value: string) {
  return Boolean(value.trim()) && !value.startsWith("#") && !value.startsWith("//") &&
    (!/^[a-z][a-z\d+.-]*:/iu.test(value) || /^[a-z]:(?:[\\/]|%5c)/iu.test(value));
}
