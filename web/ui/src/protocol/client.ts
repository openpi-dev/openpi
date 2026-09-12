import type { WebBackgroundTerminalDetail } from "../../../../extensions/shared/web-observer-registry.ts";
import type { WebProjectTrustStatus } from "../../../runtime/trust-status.ts";
import type { WebProviderAuthProjection } from "../../../runtime/types.ts";
import {
  ARTIFACT_MAX_BYTES,
  type ArtifactMetadata,
  type ArtifactPreview,
} from "../../../protocol/artifacts.ts";
import {
  WEB_MAX_MODEL_SEARCH_RESULTS,
  type WebModelSearchResult,
  type WebModelSummary,
  type WebSnapshot,
  type WebThinkingState,
  type WebCommandDiscoveryResult,
} from "../../../protocol/types.ts";

const tokenStorageKey = "openpi.web.token";

export class WebApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "WebApiError";
  }
}

function readToken() {
  const pageToken = document.querySelector<HTMLMetaElement>(
    'meta[name="openpi-web-token"]',
  )?.content;
  const fragmentToken = new URLSearchParams(location.hash.slice(1)).get(
    "token",
  );
  const token =
    pageToken && /^[a-f0-9]{64}$/i.test(pageToken) ? pageToken : fragmentToken;
  if (fragmentToken)
    history.replaceState(null, "", `${location.pathname}${location.search}`);
  if (token) {
    try {
      window.sessionStorage.setItem(tokenStorageKey, token);
    } catch {}
    return token;
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
  pendingFollowUps?: number;
}

export interface SessionMutationResult {
  cancelled?: boolean;
  path?: string;
  sessionPath?: string;
}

export interface SessionCreationResult {
  cancelled: boolean;
  commandId: string;
  sessionId: string;
  sessionPath?: string;
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

  async request<T>(
    path: string,
    options: RequestInit & { timeoutMs?: number; timeoutMessage?: string } = {},
  ) {
    const {
      timeoutMs = 15_000,
      timeoutMessage = "Request timed out. Please try again.",
      ...requestOptions
    } = options;
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    if (options.signal?.aborted) abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    const timer = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      const response = await fetch(path, {
        ...requestOptions,
        signal: controller.signal,
        headers: { ...this.headers(Boolean(options.body)), ...options.headers },
      });
      const body = (await response.json()) as {
        error?: string;
        code?: string;
      } & T;
      if (controller.signal.aborted) throw new Error("Request aborted");
      if (!response.ok)
        throw new WebApiError(
          body.error || `Request failed (${response.status})`,
          response.status,
          body.code,
        );
      return body;
    } catch (error) {
      if (timedOut) throw new Error(timeoutMessage);
      throw error;
    } finally {
      window.clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    }
  }

  snapshot(path?: string | null) {
    const suffix = path ? `?path=${encodeURIComponent(path)}` : "";
    return this.request<WebSnapshot>(`/api/snapshot${suffix}`);
  }

  resolveArtifact(
    sessionId: string,
    reference: string,
    parent?: string,
    signal?: AbortSignal,
  ) {
    return this.request<{ handle: string }>("/api/artifacts/resolve", {
      method: "POST",
      body: JSON.stringify({
        sessionId,
        reference,
        parent,
        access: "read-file",
      }),
      signal,
    });
  }

  artifactMetadata(sessionId: string, handle: string, signal?: AbortSignal) {
    return this.request<{ identity: string }>(
      `/api/artifacts/content?${new URLSearchParams({ sessionId, handle, metadata: "1" })}`,
      { signal },
    );
  }

  artifactPreview(sessionId: string, handle: string, signal?: AbortSignal) {
    return this.request<ArtifactPreview>(
      `/api/artifacts/content?${new URLSearchParams({ sessionId, handle })}`,
      { signal },
    );
  }

  releaseArtifact(sessionId: string, handle: string) {
    return this.request(
      "/api/artifacts/content?" + new URLSearchParams({ sessionId, handle }),
      { method: "DELETE" },
    );
  }

  async downloadArtifact(artifact: ArtifactMetadata, signal: AbortSignal) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const timer = window.setTimeout(abort, 15_000);
    try {
      const response = await fetch(
        `/api/artifacts/content?${new URLSearchParams({ sessionId: artifact.sessionId, handle: artifact.handle, revision: artifact.revision, download: "1" })}`,
        { headers: this.headers(), signal: controller.signal },
      );
      if (!response.ok) {
        const body = (await response.json()) as {
          error?: string;
          code?: string;
        };
        throw new WebApiError(
          body.error || "Download failed",
          response.status,
          body.code,
        );
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Download body unavailable");
      const chunks: Uint8Array<ArrayBuffer>[] = [];
      let total = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > ARTIFACT_MAX_BYTES)
            throw new Error("Download exceeds the 20 MiB limit");
          chunks.push(new Uint8Array(value));
        }
      } finally {
        await reader.cancel();
      }
      return new Blob(chunks, { type: "application/octet-stream" });
    } finally {
      window.clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
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
    return this.request<SessionCreationResult>("/api/sessions", {
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

  unarchiveSession(path: string) {
    return this.request<{ path: string; archived: false }>(
      `/api/sessions/unarchive?path=${encodeURIComponent(path)}`,
      { method: "POST" },
    );
  }

  thinking(sessionId: string, signal: AbortSignal) {
    return this.request<WebThinkingState & { sessionId: string }>(
      `/api/thinking?sessionId=${encodeURIComponent(sessionId)}`,
      { signal },
    );
  }

  setThinkingLevel(sessionId: string, level: string) {
    return this.request<WebThinkingState & { sessionId: string }>(
      "/api/thinking",
      {
        method: "POST",
        body: JSON.stringify({ sessionId, level }),
      },
    );
  }

  trust(sessionId: string, signal: AbortSignal) {
    return this.request<WebProjectTrustStatus>(
      `/api/trust?sessionId=${encodeURIComponent(sessionId)}`,
      { signal },
    );
  }

  providerAuth(sessionId: string, signal: AbortSignal) {
    return this.request<WebProviderAuthProjection>(
      `/api/providers/auth-status?sessionId=${encodeURIComponent(sessionId)}`,
      { signal },
    );
  }

  commands(sessionId: string, signal?: AbortSignal) {
    return this.request<WebCommandDiscoveryResult>(
      `/api/commands?sessionId=${encodeURIComponent(sessionId)}`,
      { signal },
    );
  }

  terminalDetail(sessionId: string, id: string, signal: AbortSignal) {
    return this.request<{
      sessionId: string;
      detail: WebBackgroundTerminalDetail;
    }>(
      `/api/capabilities/detail?kind=background-terminals&id=${encodeURIComponent(id)}&sessionId=${encodeURIComponent(sessionId)}`,
      { signal },
    );
  }

  selectModel(provider: string, modelId: string, sessionId: string) {
    return this.request<WebModelSummary>("/api/model", {
      method: "POST",
      body: JSON.stringify({ provider, modelId, sessionId }),
    });
  }

  searchModels(query: string, sessionId?: string, signal?: AbortSignal) {
    const params = new URLSearchParams({
      query,
      limit: String(WEB_MAX_MODEL_SEARCH_RESULTS),
    });
    if (sessionId) params.set("sessionId", sessionId);
    return this.request<WebModelSearchResult>(`/api/models?${params}`, {
      signal,
    });
  }

  cancelActiveTurn(turn: NonNullable<WebSnapshot["runtime"]["activeTurn"]>) {
    return this.request<{ state: "accepted" | "already-settled" }>(
      "/api/turns/cancel",
      {
        method: "POST",
        body: JSON.stringify(turn),
      },
    );
  }

  async prompt(
    sessionId: string,
    content: string,
    commandId: string,
    retry = false,
  ) {
    const receipt = await this.request<CommandReceipt>("/api/prompt", {
      method: "POST",
      body: JSON.stringify({ sessionId, content, commandId, retry }),
      timeoutMs: 30_000,
      timeoutMessage:
        "Request timed out; admission may still be pending. Retry the same message to recover its receipt.",
    });
    if (
      typeof receipt.id !== "string" ||
      !receipt.id ||
      receipt.accepted !== true
    ) {
      throw new Error(
        "Invalid prompt receipt; retry the same message to recover its admission.",
      );
    }
    return receipt;
  }
}
