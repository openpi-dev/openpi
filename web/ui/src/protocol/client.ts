import type {
  WebBackgroundTerminalDetail,
  WebCapabilityActionRequest,
  WebSubagentDetail,
} from "../../../../extensions/shared/web-observer-registry.ts";
import {
  type WebQuestionRequest,
  type WebQuestionAnswers,
  type WebQuestionReceipt,
} from "../../../protocol/questions.ts";
import {
  ARTIFACT_MAX_BYTES,
  type ArtifactMetadata,
  type ArtifactPreview,
} from "../../../protocol/artifacts.ts";
import {
  WEB_MAX_MODEL_SEARCH_RESULTS,
  type WebCommandDiscoveryResult,
  type WebEmbeddedBrowserAction,
  type WebEmbeddedBrowserState,
  type WebGitReviewResult,
  type WebInteractiveTerminal,
  type WebInteractiveTerminalEvent,
  type WebModelSearchResult,
  type WebModelSummary,
  type WebPromptImage,
  type WebSettingsCatalog,
  type WebSnapshot,
  type WebThinkingState,
} from "../../../protocol/types.ts";
import type { WebProjectTrustStatus } from "../../../runtime/trust-status.ts";
import type { WebProviderAuthProjection } from "../../../runtime/types.ts";

const tokenStorageKey = "openpi.web.token";
import { controllerIdentity } from "./controller.ts";

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
  async headers(json = false) {
    return {
      Authorization: `Bearer ${this.token ?? ""}`,
      "X-OpenPI-Web-Controller": await controllerIdentity(),
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
        headers: {
          ...(await this.headers(Boolean(options.body))),
          ...options.headers,
        },
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

  gitReview(sessionId: string, path: string, signal?: AbortSignal) {
    return this.request<WebGitReviewResult>(
      `/api/git-review?${new URLSearchParams({ sessionId, path })}`,
      { signal, timeoutMessage: "Git review timed out. Please retry." },
    );
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
        { headers: await this.headers(), signal: controller.signal },
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

  openBrowser(
    sessionId: string,
    url: string,
    viewport: { width: number; height: number },
    signal?: AbortSignal,
  ) {
    return this.request<WebEmbeddedBrowserState>("/api/browser/open", {
      method: "POST",
      body: JSON.stringify({ sessionId, url, ...viewport }),
      signal,
    });
  }

  browserState(sessionId: string, signal?: AbortSignal) {
    return this.request<WebEmbeddedBrowserState>(
      `/api/browser/state?${new URLSearchParams({ sessionId })}`,
      { signal },
    );
  }

  browserAction(
    sessionId: string,
    action: WebEmbeddedBrowserAction,
    signal?: AbortSignal,
  ) {
    const { type, ...detail } = action;
    return this.request<WebEmbeddedBrowserState>("/api/browser/action", {
      method: "POST",
      body: JSON.stringify({ sessionId, action: type, ...detail }),
      signal,
    });
  }

  async browserFrame(sessionId: string, signal?: AbortSignal) {
    const response = await fetch(
      `/api/browser/frame?${new URLSearchParams({ sessionId })}`,
      { headers: await this.headers(), signal },
    );
    if (response.status === 404) return null;
    if (!response.ok) {
      const body = (await response.json()) as { error?: string; code?: string };
      throw new WebApiError(
        body.error || `Request failed (${response.status})`,
        response.status,
        body.code,
      );
    }
    return response.blob();
  }

  createInteractiveTerminal(
    sessionId: string,
    cols: number,
    rows: number,
    signal?: AbortSignal,
  ) {
    return this.request<WebInteractiveTerminal>("/api/terminal", {
      method: "POST",
      body: JSON.stringify({ sessionId, cols, rows }),
      signal,
    });
  }

  interactiveTerminal(sessionId: string, id: string, signal?: AbortSignal) {
    return this.request<WebInteractiveTerminal>(
      `/api/terminal?${new URLSearchParams({ sessionId, id })}`,
      { signal },
    );
  }

  closeInteractiveTerminal(sessionId: string, id: string) {
    return this.request<{ closed: true }>(
      `/api/terminal?${new URLSearchParams({ sessionId, id })}`,
      { method: "DELETE" },
    );
  }

  writeInteractiveTerminal(sessionId: string, id: string, data: string) {
    return this.request<{ written: true }>("/api/terminal/input", {
      method: "POST",
      body: JSON.stringify({ sessionId, id, data }),
    });
  }

  resizeInteractiveTerminal(
    sessionId: string,
    id: string,
    cols: number,
    rows: number,
  ) {
    return this.request<{ resized: true }>("/api/terminal/resize", {
      method: "POST",
      body: JSON.stringify({ sessionId, id, cols, rows }),
    });
  }

  async streamInteractiveTerminal(
    sessionId: string,
    id: string,
    after: number | undefined,
    signal: AbortSignal,
    onEvent: (event: WebInteractiveTerminalEvent) => void,
  ) {
    const query = new URLSearchParams({ sessionId, id });
    if (after !== undefined) query.set("after", String(after));
    const response = await fetch(`/api/terminal/events?${query}`, {
      headers: await this.headers(),
      signal,
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        code?: string;
      };
      throw new WebApiError(
        body.error || `Terminal stream failed (${response.status})`,
        response.status,
        body.code,
      );
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Terminal stream is unavailable");
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (!signal.aborted) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        while (true) {
          const boundary = buffer.search(/\r?\n\r?\n/u);
          if (boundary < 0) break;
          const frame = buffer.slice(0, boundary);
          const separatorLength = buffer.startsWith("\r\n", boundary) ? 4 : 2;
          buffer = buffer.slice(boundary + separatorLength);
          const data = frame
            .split(/\r?\n/u)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (!data) continue;
          onEvent(JSON.parse(data) as WebInteractiveTerminalEvent);
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
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

  setThinkingLevel(sessionId: string, level: string, sessionPath: string) {
    return this.request<WebThinkingState & { sessionId: string }>(
      "/api/thinking",
      {
        method: "POST",
        body: JSON.stringify({ sessionId, sessionPath, level }),
      },
    );
  }

  setPlanMode(
    sessionId: string,
    enabled: boolean,
    expectedRevision: string | null,
  ) {
    return this.request<{ sessionId: string }>("/api/plan", {
      method: "POST",
      body: JSON.stringify({ sessionId, enabled, expectedRevision }),
    });
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

  settingsCatalog(sessionId: string, signal?: AbortSignal) {
    return this.request<WebSettingsCatalog>(
      `/api/settings/catalog?sessionId=${encodeURIComponent(sessionId)}`,
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

  subagentDetail(sessionId: string, id: string, signal: AbortSignal) {
    return this.request<{ sessionId: string; detail: WebSubagentDetail }>(
      `/api/capabilities/detail?kind=subagents&id=${encodeURIComponent(id)}&sessionId=${encodeURIComponent(sessionId)}`,
      { signal },
    );
  }

  subagentAction(
    sessionId: string,
    action: WebCapabilityActionRequest,
    signal?: AbortSignal,
  ) {
    return this.request<{ sessionId: string; detail: WebSubagentDetail }>(
      "/api/capabilities/action",
      {
        method: "POST",
        body: JSON.stringify({ sessionId, ...action }),
        signal,
      },
    );
  }

  selectModel(
    provider: string,
    modelId: string,
    sessionId: string,
    sessionPath: string,
  ) {
    return this.request<WebModelSummary>("/api/model", {
      method: "POST",
      body: JSON.stringify({ provider, modelId, sessionId, sessionPath }),
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

  pendingQuestions(sessionId: string, signal?: AbortSignal) {
    return this.request<{ pending: WebQuestionRequest | null }>(
      `/api/questions/pending?sessionId=${encodeURIComponent(sessionId)}`,
      { signal },
    );
  }

  async answerQuestions(
    request: WebQuestionRequest,
    answers: WebQuestionAnswers | null,
    signal?: AbortSignal,
  ) {
    try {
      return await this.request<WebQuestionReceipt>("/api/questions/answer", {
        method: "POST",
        body: JSON.stringify({
          sessionId: request.sessionId,
          requestId: request.requestId,
          action: answers === null ? "dismiss" : "answer",
          ...(answers === null ? {} : { answers }),
        }),
        signal,
      });
    } catch (error) {
      if (error instanceof WebApiError && error.code === "STALE_QUESTION")
        return { state: "stale" } as const;
      throw error;
    }
  }

  async prompt(
    sessionId: string,
    content: string,
    commandId: string,
    sessionPath: string,
    retry = false,
    images: readonly WebPromptImage[] = [],
  ) {
    const receipt = await this.request<CommandReceipt>("/api/prompt", {
      method: "POST",
      body: JSON.stringify({
        sessionId,
        sessionPath,
        content,
        commandId,
        retry,
        images,
        controllerId: await controllerIdentity(),
      }),
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
