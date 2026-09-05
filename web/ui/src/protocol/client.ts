import type { WebSnapshot } from "../../../protocol/types.ts";

const tokenStorageKey = "openpi.web.token";

export class WebApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "WebApiError";
  }
}

function readToken() {
  const fragmentToken = new URLSearchParams(location.hash.slice(1)).get(
    "token",
  );
  if (fragmentToken) {
    try {
      window.sessionStorage.setItem(tokenStorageKey, fragmentToken);
    } catch {}
    history.replaceState(null, "", `${location.pathname}${location.search}`);
    return fragmentToken;
  }
  try {
    return window.sessionStorage.getItem(tokenStorageKey);
  } catch {
    return null;
  }
}

export interface CommandReceipt {
  id: string;
  accepted: boolean;
}

export interface SessionMutationResult {
  cancelled?: boolean;
  path?: string;
}

export interface WorkspaceSelectionResult {
  cancelled?: boolean;
  path?: string;
}

export class WebClient {
  readonly token = readToken();

  headers(json = false) {
    return {
      Authorization: `Bearer ${this.token ?? ""}`,
      ...(json ? { "Content-Type": "application/json" } : {}),
    };
  }

  async request<T>(path: string, options: RequestInit = {}) {
    const response = await fetch(path, {
      ...options,
      headers: { ...this.headers(Boolean(options.body)), ...options.headers },
    });
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
    } & T;
    if (!response.ok) {
      throw new WebApiError(
        body.error || `Request failed (${response.status})`,
        response.status,
      );
    }
    return body;
  }

  snapshot(path?: string | null) {
    const suffix = path ? `?path=${encodeURIComponent(path)}` : "";
    return this.request<WebSnapshot>(`/api/snapshot${suffix}`);
  }

  chooseWorkspace() {
    return this.request<WorkspaceSelectionResult>("/api/workspaces/select", {
      method: "POST",
    });
  }

  renameWorkspace(path: string, name: string) {
    return this.request<{ path: string; name: string }>("/api/workspaces", {
      method: "PATCH",
      body: JSON.stringify({ path, name }),
    });
  }

  removeWorkspace(path: string) {
    return this.request<{ path: string; removed: true }>(
      `/api/workspaces?path=${encodeURIComponent(path)}`,
      { method: "DELETE" },
    );
  }

  createSession(workspacePath: string, commandId: string) {
    return this.request<SessionMutationResult>("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ workspacePath, commandId }),
    });
  }

  selectSession(path: string) {
    return this.request<SessionMutationResult>("/api/sessions/select", {
      method: "POST",
      body: JSON.stringify({ path }),
    });
  }

  renameSession(path: string, name: string) {
    return this.request<{ path: string; name: string }>("/api/sessions", {
      method: "PATCH",
      body: JSON.stringify({ path, name }),
    });
  }

  archiveSession(path: string) {
    return this.request<{ path: string; archived: true }>(
      `/api/sessions/archive?path=${encodeURIComponent(path)}`,
      { method: "POST" },
    );
  }

  selectModel(provider: string, modelId: string, sessionId: string) {
    return this.request<CommandReceipt>("/api/model", {
      method: "POST",
      body: JSON.stringify({ provider, modelId, sessionId }),
    });
  }

  prompt(sessionId: string, content: string) {
    return this.request<CommandReceipt>("/api/prompt", {
      method: "POST",
      body: JSON.stringify({ sessionId, content }),
    });
  }
}
