export interface WebBuildInfo {
  version: string | null;
  id: string | null;
  mode: "production" | "development";
}

export interface WebRuntimeInfo {
  version: string | null;
  packageRoot: string;
  startedAt: string;
  capturedAt: string;
  git: { revision: string; dirty: boolean | null } | null;
  frontendAtStartup: WebBuildInfo | null;
}
