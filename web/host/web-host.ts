import { execFile } from "node:child_process";
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { URL } from "node:url";
import { promisify } from "node:util";
import {
  runWebCapabilityAction,
  subscribeWebCapabilities,
  type WebCapabilityActionRequest,
  webCapabilityDetail,
  webCapabilitySnapshot,
} from "../../extensions/shared/web-observer-registry.ts";
import { loadSetupConfig } from "../../extensions/shared/setup-config.ts";
import { projectWebSetupConfig } from "../runtime/settings-catalog.ts";
import { validModelConfiguration } from "../runtime/model-configuration.ts";
import { projectPlanControl } from "../../extensions/plan-mode/control.ts";
import { registerWebCommandFeedback, WEB_COMMAND_FEEDBACK } from "../../extensions/shared/web-command-feedback.ts";
import {
  PiWebAdapter,
  WebReadOnlySessionError,
} from "../adapter/pi-adapter.ts";
import {
  jsonByteLength,
  boundThinkingProjection,
  WEB_MAX_ARCHIVED_SESSION_PAGE,
  WEB_MAX_EVENT_BYTES,
  WEB_MAX_EVENTS,
  WEB_MAX_MODEL_QUERY,
  WEB_MAX_MODEL_SEARCH_RESULTS,
  WEB_MAX_SNAPSHOT_BYTES,
  WEB_PROMPT_IMAGE_MAX_BYTES,
  WEB_PROMPT_IMAGE_MAX_COUNT,
  WEB_PROMPT_IMAGE_MAX_TOTAL_BYTES,
  WEB_PROTOCOL_VERSION,
  type WebEvent,
  type WebEmbeddedBrowserAction,
  WEB_BROWSER_TEXT_MAX_LENGTH,
  type WebInteractiveTerminalEvent,
  type WebPromptImage,
  type WebSnapshot,
} from "../protocol/types.ts";
import {
  WebRuntimeRequestError,
  type WebRuntimeController,
} from "../runtime/types.ts";
import { elapsed, traceWeb } from "../trace.ts";
import { reduceLiveTools } from "../protocol/live-tools.ts";
import type { LiveToolEvidence } from "../protocol/evidence.ts";
import { ArtifactError, ArtifactReader } from "./artifacts.ts";
import {
  EmbeddedBrowserManager,
  type EmbeddedBrowserService,
} from "./embedded-browser.ts";
import {
  GitReviewBaselineStore,
  type GitReviewService,
} from "./git-review.ts";
import {
  InteractiveTerminalManager,
  INTERACTIVE_TERMINAL_MAX_INPUT,
  type InteractiveTerminalService,
} from "./interactive-terminal.ts";
import { registerWebQuestionBridge } from "../../extensions/ask-user/web-bridge.ts";
import { isWebControllerId, WEB_QUESTION_BODY_BYTES } from "../protocol/questions.ts";
import { WebQuestionBroker } from "./questions.ts";

const HOST = "127.0.0.1";
const UI_ROOT = new URL("../dist/", import.meta.url);
const MAX_COMMAND_BYTES = 16 * 1024;
const MAX_PROMPT_REQUEST_BYTES = 12 * 1024 * 1024;
const MAX_SSE_CLIENTS = 8;
const MAX_TERMINAL_STREAMS = 8;
const MAX_SSE_BUFFER_BYTES = 256 * 1024;
const MAX_SSE_REPLAY_BYTES = MAX_SSE_BUFFER_BYTES;
const DEFAULT_SSE_HEARTBEAT_MS = 15_000;
const SERVER_CLOSE_DRAIN_MS = 500;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;
const MAX_PROMPT_ADMISSIONS = 128;
const THINKING_LEVELS = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const execFileAsync = promisify(execFile);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const promptImageMimeTypes = new Set<WebPromptImage["mimeType"]>([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

function hasImageSignature(bytes: Buffer, mimeType: WebPromptImage["mimeType"]) {
  if (mimeType === "image/png")
    return bytes
      .subarray(0, 8)
      .equals(Buffer.from("89504e470d0a1a0a", "hex"));
  if (mimeType === "image/jpeg")
    return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mimeType === "image/gif") {
    const signature = bytes.subarray(0, 6).toString("ascii");
    return signature === "GIF87a" || signature === "GIF89a";
  }
  return (
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  );
}

function parsePromptImages(value: unknown) {
  if (value === undefined)
    return { ok: true as const, images: [] as WebPromptImage[], bytes: 0 };
  if (!Array.isArray(value) || value.length > WEB_PROMPT_IMAGE_MAX_COUNT)
    return { ok: false as const, error: "prompt images exceed the count limit" };
  const images: WebPromptImage[] = [];
  let totalBytes = 0;
  for (const item of value) {
    if (!isRecord(item))
      return { ok: false as const, error: "prompt images must be objects" };
    const mimeType = item.mimeType;
    const data = item.data;
    const name = item.name;
    if (
      typeof mimeType !== "string" ||
      !promptImageMimeTypes.has(mimeType as WebPromptImage["mimeType"]) ||
      typeof data !== "string" ||
      data.length === 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
        data,
      ) ||
      (name !== undefined &&
        (typeof name !== "string" || name.length === 0 || name.length > 255)) ||
      Object.keys(item).some(
        (key) => !["data", "mimeType", "name"].includes(key),
      )
    ) {
      return { ok: false as const, error: "prompt image metadata is invalid" };
    }
    const bytes = Buffer.from(data, "base64");
    if (
      bytes.length === 0 ||
      bytes.length > WEB_PROMPT_IMAGE_MAX_BYTES ||
      !hasImageSignature(bytes, mimeType as WebPromptImage["mimeType"])
    ) {
      return {
        ok: false as const,
        error: "prompt image data is invalid or too large",
      };
    }
    totalBytes += bytes.length;
    if (totalBytes > WEB_PROMPT_IMAGE_MAX_TOTAL_BYTES)
      return {
        ok: false as const,
        error: "prompt images exceed the total size limit",
      };
    images.push({
      data,
      mimeType: mimeType as WebPromptImage["mimeType"],
      ...(typeof name === "string" ? { name } : {}),
    });
  }
  return { ok: true as const, images, bytes: totalBytes };
}

function promptImageSignature(images: readonly WebPromptImage[]) {
  const hash = createHash("sha256");
  for (const image of images) {
    hash.update(image.mimeType);
    hash.update("\0");
    hash.update(image.name ?? "");
    hash.update("\0");
    hash.update(image.data);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function browserAddress(value: unknown) {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048)
    return undefined;
  try {
    const target = new URL(value);
    if (
      (target.protocol !== "http:" && target.protocol !== "https:") ||
      target.username ||
      target.password
    )
      return undefined;
    return target.toString();
  } catch {
    return undefined;
  }
}

function finiteNumber(
  value: unknown,
  min: number,
  max: number,
): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function parseBrowserAction(
  body: Record<string, unknown>,
): WebEmbeddedBrowserAction | undefined {
  const action = body.action;
  if (
    action === "text" &&
    typeof body.text === "string" &&
    body.text.length > 0 &&
    body.text.length <= WEB_BROWSER_TEXT_MAX_LENGTH
  ) return { type: "text", text: body.text };
  if (action === "navigate") {
    const url = browserAddress(body.url);
    return url ? ({ type: "navigate", url } satisfies WebEmbeddedBrowserAction) : undefined;
  }
  if (
    action === "back" ||
    action === "forward" ||
    action === "reload" ||
    action === "stop"
  )
    return { type: action } satisfies WebEmbeddedBrowserAction;
  if (
    action === "resize" &&
    isBoundedInteger(body.width, 320, 2_560) &&
    isBoundedInteger(body.height, 240, 2_560) &&
    (body.deviceScaleFactor === undefined || finiteNumber(body.deviceScaleFactor, 1, 2))
  ) {
    return {
      type: "resize",
      width: body.width,
      height: body.height,
      ...(typeof body.deviceScaleFactor === "number" ? { deviceScaleFactor: body.deviceScaleFactor } : {}),
    } satisfies WebEmbeddedBrowserAction;
  }
  if (
    action === "mouse" &&
    ["move", "down", "up", "wheel"].includes(String(body.event)) &&
    finiteNumber(body.x, 0, 4_096) &&
    finiteNumber(body.y, 0, 4_096) &&
    (body.button === undefined ||
      ["left", "middle", "right"].includes(String(body.button))) &&
    (body.buttons === undefined || isBoundedInteger(body.buttons, 0, 7)) &&
    (body.deltaX === undefined || finiteNumber(body.deltaX, -10_000, 10_000)) &&
    (body.deltaY === undefined || finiteNumber(body.deltaY, -10_000, 10_000))
  ) {
    return {
      type: "mouse",
      event: body.event as "move" | "down" | "up" | "wheel",
      x: body.x,
      y: body.y,
      ...(body.button
        ? { button: body.button as "left" | "middle" | "right" }
          : {}),
      ...(typeof body.buttons === "number" ? { buttons: body.buttons } : {}),
      ...(typeof body.deltaX === "number" ? { deltaX: body.deltaX } : {}),
      ...(typeof body.deltaY === "number" ? { deltaY: body.deltaY } : {}),
    } satisfies WebEmbeddedBrowserAction;
  }
  if (
    action === "key" &&
    (body.event === "down" || body.event === "up") &&
    typeof body.key === "string" &&
    body.key.length > 0 &&
    body.key.length <= 32 &&
    (body.modifiers === undefined || isBoundedInteger(body.modifiers, 0, 15)) &&
    (body.code === undefined ||
      (typeof body.code === "string" && body.code.length <= 64)) &&
    (body.text === undefined ||
      (typeof body.text === "string" && body.text.length <= 8))
  ) {
    return {
      type: "key",
      event: body.event,
      key: body.key,
      ...(typeof body.modifiers === "number" ? { modifiers: body.modifiers } : {}),
      ...(typeof body.code === "string" ? { code: body.code } : {}),
      ...(typeof body.text === "string" ? { text: body.text } : {}),
    } satisfies WebEmbeddedBrowserAction;
  }
  return undefined;
}

function isBoundedInteger(
  value: unknown,
  min: number,
  max: number,
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= min &&
    value <= max
  );
}

type PromptAdmissionResponse = {
  readonly status: number;
  readonly body: Record<string, unknown>;
};

type PromptAdmission = {
  readonly sessionId: string;
  readonly sessionPath: string;
  readonly content: string;
  readonly imageSignature: string;
  readonly controllerId?: string;
  readonly completion: Promise<PromptAdmissionResponse>;
  result?: PromptAdmissionResponse;
};

function validSessionPath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\u0000");
}

type WebRequestErrorCode =
  | "INVALID_REQUEST_BODY"
  | "REQUEST_BODY_TOO_LARGE";

class WebRequestError extends Error {
  readonly code: WebRequestErrorCode;
  readonly statusCode: 400 | 413;
  readonly maxBytes?: number;

  constructor(
    message: string,
    code: WebRequestErrorCode,
    statusCode: 400 | 413,
    maxBytes?: number,
  ) {
    super(message);
    this.name = "WebRequestError";
    this.code = code;
    this.statusCode = statusCode;
    this.maxBytes = maxBytes;
  }
}

export interface WebHostOptions {
  runtime: WebRuntimeController;
  onEvent?: (type: string, detail?: Record<string, unknown>) => void;
  port?: number;
  token?: string;
  allowedOrigins?: readonly string[];
  directoryChooser?: (signal: AbortSignal) => Promise<string | undefined>;
  embeddedBrowser?: EmbeddedBrowserService;
  gitReviews?: GitReviewService;
  interactiveTerminals?: InteractiveTerminalService;
  shutdownTimeoutMs?: number;
  sseHeartbeatMs?: number;
}

export class WebHost {
  private readonly server: Server;
  private readonly token: Buffer;
  private readonly adapter: PiWebAdapter;
  private readonly clients = new Set<ServerResponse>();
  private readonly terminalStreams = new Set<ServerResponse>();
  private readonly browserStreams = new Set<() => void>();
  private readonly clientHeartbeats = new Map<
    ServerResponse,
    ReturnType<typeof setInterval>
  >();
  private readonly events: WebEvent[] = [];
  private sequence = 0;
  private liveTools: LiveToolEvidence[] = [];
  private readonly artifacts: ArtifactReader;
  private port = 0;
  private readonly runtime: WebRuntimeController;
  private readonly requestedPort: number;
  private readonly onEvent?: WebHostOptions["onEvent"];
  private readonly allowedOrigins: ReadonlySet<string>;
  private readonly directoryChooser: NonNullable<
    WebHostOptions["directoryChooser"]
  >;
  private readonly embeddedBrowser: EmbeddedBrowserService;
  private readonly gitReviews: GitReviewService;
  private readonly interactiveTerminals: InteractiveTerminalService;
  private readonly shutdownTimeoutMs: number;
  private readonly sseHeartbeatMs: number;
  private readonly unsubscribeCapabilities: () => void;
  private readonly unsubscribeRuntime: () => void;
  private readonly chooserAbort = new AbortController();
  private readonly leaseSensitiveRequests = new Set<Promise<void>>();
  private readonly leaseSensitiveMessages = new Set<IncomingMessage>();
  private readonly promptAdmissions = new Map<
    string,
    PromptAdmission
  >();
  private stopping = false;
  private stopPromise?: Promise<void>;
  private readonly questions: WebQuestionBroker;
  private questionSession?: object;
  private unregisterQuestions?: () => void;

  constructor(options: WebHostOptions) {
    this.runtime = options.runtime;
    this.questions = new WebQuestionBroker(() => {
      if (this.stopping || !this.runtime.workspaceSelected) return undefined;
      const turn = this.runtime.getActiveTurn();
      const admission = turn && this.promptAdmissions.get(turn.commandId);
      if (!turn || !admission?.controllerId || admission.sessionId !== turn.sessionId ||
          !this.adapter.isCurrentSession({ id: admission.sessionId, path: admission.sessionPath })) return undefined;
      return { ...turn, workspace: this.runtime.cwd, controllerId: admission.controllerId };
    }, () => this.publish("questions_changed"));
    this.artifacts = new ArtifactReader(() => this.runtime.workspaceSelected && !this.stopping ? { sessionId: this.runtime.sessionManager.getSessionId(), cwd: this.runtime.cwd } : undefined);
    this.requestedPort = options.port ?? 0;
    this.token = options.token
      ? Buffer.from(options.token, "hex")
      : randomBytes(32);
    if (this.token.length !== 32)
      throw new Error("Web host token must be 64 hexadecimal characters");
    this.allowedOrigins = new Set(options.allowedOrigins ?? []);
    this.directoryChooser =
      options.directoryChooser ?? (() => this.chooseDirectory());
    this.embeddedBrowser = options.embeddedBrowser ?? new EmbeddedBrowserManager();
    this.gitReviews =
      options.gitReviews ??
      new GitReviewBaselineStore(this.runtime.sessionDirectory);
    this.interactiveTerminals =
      options.interactiveTerminals ?? new InteractiveTerminalManager();
    this.shutdownTimeoutMs =
      options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(this.shutdownTimeoutMs) ||
      this.shutdownTimeoutMs <= 0
    ) {
      throw new Error("Web host shutdown timeout must be a positive integer");
    }
    this.sseHeartbeatMs =
      options.sseHeartbeatMs ?? DEFAULT_SSE_HEARTBEAT_MS;
    if (
      !Number.isSafeInteger(this.sseHeartbeatMs) ||
      this.sseHeartbeatMs <= 0
    ) {
      throw new Error("SSE heartbeat interval must be a positive integer");
    }
    this.adapter = new PiWebAdapter(options.runtime);
    this.onEvent = options.onEvent;
    this.unsubscribeCapabilities = subscribeWebCapabilities((scope) => {
      if (scope === this.runtime.sessionManager) this.publish("runtime_changed");
    });
    this.unsubscribeRuntime = this.runtime.subscribe(({ type, detail }) =>
      this.publish(type, detail),
    );
    this.server = createServer((request, response) => {
      const leaseSensitive = this.isLeaseSensitiveMutation(request);
      if (this.stopping && leaseSensitive) {
        request.resume();
        response.setHeader("Connection", "close");
        this.json(response, 503, {
          code: "HOST_STOPPING",
          error: "Web host is stopping",
        });
        response.once("finish", () => request.socket.destroy());
        return;
      }
      const operation = this.dispatchRequest(request, response);
      if (leaseSensitive) {
        this.leaseSensitiveRequests.add(operation);
        this.leaseSensitiveMessages.add(request);
        void operation.then(
          () => {
            this.leaseSensitiveRequests.delete(operation);
            this.leaseSensitiveMessages.delete(request);
          },
          () => {
            this.leaseSensitiveRequests.delete(operation);
            this.leaseSensitiveMessages.delete(request);
          },
        );
      }
      void operation;
    });
    this.syncQuestionBridge();
  }

  async start() {
    await this.adapter.initialize();
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.requestedPort, HOST, () => resolve());
    });
    const address = this.server.address();
    if (!address || typeof address === "string")
      throw new Error("Web host did not expose a TCP port");
    this.port = address.port;
    this.publish("web_host_started", {
      port: this.port,
      ...(this.runtime.workspaceSelected === true
        ? { cwd: this.runtime.cwd }
        : {}),
      mode: "local-workbench",
    });
  }

  get origin() {
    return `http://${HOST}:${this.port}`;
  }

  get url() {
    return `${this.origin}/#token=${this.token.toString("hex")}`;
  }

  publish(type: string, detail?: Record<string, unknown>) {
    this.syncQuestionBridge();
    this.questions.reconcile();
    if (["session_start", "session_switched", "session_created", "session_archived", "workspace_removed"].includes(type)) {
      this.artifacts.revoke();
      if (this.runtime.workspaceSelected) {
        this.embeddedBrowser.retain(
          this.runtime.sessionManager.getSessionId(),
        );
        this.interactiveTerminals.retain(
          this.runtime.sessionManager.getSessionId(),
          this.runtime.cwd,
        );
      } else {
        this.embeddedBrowser.retain();
        this.interactiveTerminals.dispose();
      }
    }
    this.liveTools = reduceLiveTools(this.liveTools, type, detail ?? {});
    let event: WebEvent = {
      protocolVersion: WEB_PROTOCOL_VERSION,
      sequence: ++this.sequence,
      type,
      timestamp: new Date().toISOString(),
      ...(detail ? { detail } : {}),
    };
    let serialized = JSON.stringify(event);
    if (Buffer.byteLength(serialized) > WEB_MAX_EVENT_BYTES) {
      event = {
        protocolVersion: WEB_PROTOCOL_VERSION,
        sequence: event.sequence,
        type: "state_invalidated",
        timestamp: event.timestamp,
        detail: { reason: "event_too_large", originalType: type },
      };
      serialized = JSON.stringify(event);
    }
    this.events.push(event);
    if (this.events.length > WEB_MAX_EVENTS) this.events.shift();
    const record = `id: ${event.sequence}\ndata: ${serialized}\n\n`;
    for (const client of this.clients) {
      this.writeSseRecord(client, record);
    }
    this.onEvent?.(event.type, event.detail);
    traceWeb("sse_event", {
      type: event.type,
      sequence: event.sequence,
      detailKeys: event.detail ? Object.keys(event.detail) : [],
    });
  }

  private syncQuestionBridge() {
    const scope = this.stopping ? undefined : this.runtime.sessionManager;
    if (scope === this.questionSession) return;
    this.unregisterQuestions?.();
    this.unregisterCommandFeedback?.();
    this.unregisterCommandFeedback = undefined;
    this.unregisterQuestions = undefined;
    this.questionSession = scope;
    this.questions.cancel();
    if (scope) this.unregisterQuestions = registerWebQuestionBridge(scope,
      (toolCallId, questions, signal, handoff) => this.questions.request(toolCallId, questions, signal, handoff));
    if (scope) this.unregisterCommandFeedback = registerWebCommandFeedback(scope, (text, level) => {
      if (this.stopping || scope !== this.runtime.sessionManager) return;
      scope.appendCustomEntry(WEB_COMMAND_FEEDBACK, { text: text.slice(0, 12_000), level, truncated: text.length > 12_000 });
      this.publish("command_feedback");
    });
  }

  private unregisterCommandFeedback?: () => void;

  stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    this.stopPromise = (async () => {
      this.syncQuestionBridge();
      this.unsubscribeCapabilities();
      this.artifacts.dispose();
      this.interactiveTerminals.dispose();
      for (const close of this.browserStreams) close();
      this.unsubscribeRuntime();
      this.chooserAbort.abort();
      for (const client of [...this.clients]) this.removeSseClient(client, "end");
      for (const stream of [...this.terminalStreams]) {
        if (!stream.writableEnded) stream.end();
      }
      this.terminalStreams.clear();
      const closeServer = this.server.listening
        ? new Promise<void>((resolve) => {
            const forceClose = setTimeout(
              () => {
                for (const request of this.leaseSensitiveMessages) {
                  request.destroy();
                }
                this.server.closeAllConnections();
              },
              SERVER_CLOSE_DRAIN_MS,
            );
            forceClose.unref();
            this.server.close(() => {
              clearTimeout(forceClose);
              resolve();
            });
            this.server.closeIdleConnections();
          })
        : Promise.resolve();
      const disposeRuntime = (async () => {
        await this.drainLeaseSensitiveRequests();
        await Promise.all([
          this.runtime.dispose(),
          this.gitReviews.dispose?.(),
          this.embeddedBrowser.dispose(),
        ]);
      })();
      const cleanup = Promise.all([disposeRuntime, closeServer]).then(
        () => undefined,
      );
      void cleanup.catch(() => undefined);
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () =>
            reject(
              new Error(
                `Web runtime cleanup did not settle within ${this.shutdownTimeoutMs} ms; cleanup state is uncertain`,
              ),
            ),
          this.shutdownTimeoutMs,
        );
        void cleanup.then(
          () => {
            clearTimeout(timeout);
            resolve();
          },
          (error) => {
            clearTimeout(timeout);
            reject(error);
          },
        );
      });
    })();
    return this.stopPromise;
  }

  private async dispatchRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ) {
    try {
      await this.handle(request, response);
    } catch (error) {
      if (response.destroyed || response.writableEnded) return;
      if (error instanceof ArtifactError) return this.json(response, error.statusCode, { code: error.code, error: error.message });
      if (error instanceof WebRequestError) {
        return this.json(response, error.statusCode, {
          code: error.code,
          error: error.message,
          ...(error.maxBytes === undefined
            ? {}
            : { maxBytes: error.maxBytes }),
        });
      }
      this.json(response, 500, {
        error: error instanceof Error ? error.message : "request failed",
      });
    }
  }

  private isLeaseSensitiveMutation(request: IncomingMessage) {
    if (request.method === "GET" || request.method === "HEAD") return false;
    const pathname = new URL(request.url ?? "/", `http://${HOST}`).pathname;
    if (pathname === "/api/prompt") return false;
    if (pathname === "/api/turns/cancel") return true;
    if (pathname === "/api/questions/answer") return true;
    if (pathname === "/api/plan") return true;
    return pathname.startsWith("/api/workspaces") ||
      pathname.startsWith("/api/sessions") ||
      pathname.startsWith("/api/terminal") ||
      pathname.startsWith("/api/browser") ||
      pathname === "/api/model" ||
      pathname === "/api/thinking" ||
      pathname === "/api/capabilities/action";
  }

  private async drainLeaseSensitiveRequests() {
    while (this.leaseSensitiveRequests.size > 0) {
      await Promise.allSettled([...this.leaseSensitiveRequests]);
    }
  }

  private async handle(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? "/", `http://${HOST}`);
    const expectedHost = `${HOST}:${this.port}`;
    if (
      request.headers.host !== expectedHost ||
      (request.headers.origin &&
        request.headers.origin !== `http://${expectedHost}` &&
        !this.allowedOrigins.has(request.headers.origin))
    ) {
      this.json(response, 403, { error: "invalid host or origin" });
      return;
    }
    if (url.pathname === "/" && request.method === "GET") {
      // The credential is issued only to the exact local document origin.
      // allowedOrigins remains an API compatibility option, not a bootstrap grant.
      const site = request.headers["sec-fetch-site"];
      const destination = request.headers["sec-fetch-dest"];
      const mode = request.headers["sec-fetch-mode"];
      let foreignReferrer = false;
      if (request.headers.referer) {
        try { foreignReferrer = new URL(request.headers.referer).origin !== this.origin; }
        catch { foreignReferrer = true; }
      }
      if (
        (request.headers.origin && request.headers.origin !== this.origin) ||
        (site !== undefined && site !== "none" && site !== "same-origin") ||
        (destination !== undefined && destination !== "document") ||
        (mode !== undefined && mode !== "navigate") || foreignReferrer
      ) {
        return this.json(response, 403, { error: "Open the local Web address directly in your browser." });
      }
      const template = await readFile(new URL("index.html", UI_ROOT), "utf8");
      const body = template.replace("<head>", `<head><meta name="openpi-web-token" content="${this.token.toString("hex")}">`);
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy":
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
        "Referrer-Policy": "no-referrer",
        "Cross-Origin-Resource-Policy": "same-origin",
        "Cross-Origin-Opener-Policy": "same-origin",
        "X-Frame-Options": "DENY",
        "X-Content-Type-Options": "nosniff",
      });
      response.end(body);
      return;
    }
    if (
      url.pathname === "/styles.css" ||
      url.pathname === "/app.js" ||
      url.pathname === "/favicon.svg"
    ) {
      if (request.method !== "GET")
        return this.json(response, 405, {
          error: "static assets accept GET only",
        });
      const file = url.pathname.slice(1);
      const body = await readFile(new URL(file, UI_ROOT));
      response.writeHead(200, {
        "Content-Type": file.endsWith(".css")
          ? "text/css; charset=utf-8"
          : file.endsWith(".svg")
            ? "image/svg+xml; charset=utf-8"
            : "text/javascript; charset=utf-8",
        "Cache-Control": "no-store",
      });
      response.end(body);
      return;
    }
    if (!this.authorized(request))
      return this.json(response, 401, { error: "invalid or missing token" });
    if (url.pathname === "/api/browser/open") {
      if (request.method !== "POST")
        return this.json(response, 405, {
          error: "browser launch requires POST",
        });
      const body = await this.readJson(request);
      const target = browserAddress(body.url);
      if (
        typeof body.sessionId !== "string" ||
        !target ||
        (body.width !== undefined && !isBoundedInteger(body.width, 320, 2_560)) ||
        (body.height !== undefined && !isBoundedInteger(body.height, 240, 2_560)) ||
        (body.deviceScaleFactor !== undefined && !finiteNumber(body.deviceScaleFactor, 1, 2)) ||
        Object.keys(body).some(
          (key) => !["sessionId", "url", "width", "height", "deviceScaleFactor"].includes(key),
        )
      ) {
        return this.json(response, 400, {
          code: "INVALID_BROWSER_OPEN_REQUEST",
          error:
            "an exact Session id, bounded HTTP address, and optional viewport are required",
        });
      }
      if (!(await this.requireActiveToolSession(body.sessionId, response)))
        return;
      const state = await this.embeddedBrowser.open(
        body.sessionId,
        target,
        {
          width: typeof body.width === "number" ? body.width : 1_024,
          height: typeof body.height === "number" ? body.height : 768,
          ...(typeof body.deviceScaleFactor === "number" ? { deviceScaleFactor: body.deviceScaleFactor } : {}),
        },
      );
      return this.json(response, 200, state);
    }
    if (url.pathname === "/api/browser/state") {
      if (request.method !== "GET")
        return this.json(response, 405, { error: "browser state requires GET" });
      const sessionId = url.searchParams.get("sessionId");
      if (!sessionId || !this.validTerminalQuery(url, ["sessionId"]))
        return this.json(response, 400, {
          code: "INVALID_BROWSER_TARGET",
          error: "an exact Session id is required",
        });
      if (!(await this.requireActiveToolSession(sessionId, response))) return;
      const state = await this.embeddedBrowser.state(sessionId);
      return state
        ? this.json(response, 200, state)
        : this.json(response, 404, {
            code: "BROWSER_NOT_FOUND",
            error: "the embedded browser is not running",
          });
    }
    if (url.pathname === "/api/browser/frames") {
      if (request.method !== "GET") return this.json(response, 405, { error: "Browser frames require GET" });
      const sessionId = url.searchParams.get("sessionId");
      if (!sessionId || !this.validTerminalQuery(url, ["sessionId"])) return this.json(response, 400, { error: "An exact Session id is required" });
      if (!(await this.requireActiveToolSession(sessionId, response))) return;
      if (!this.embeddedBrowser.subscribeFrames) return this.json(response, 501, { error: "Browser streaming is unavailable" });
      if (this.browserStreams.size >= 4) return this.json(response, 429, { error: "Browser viewer limit reached" });
      if (!(await this.embeddedBrowser.state(sessionId))) return this.json(response, 404, { error: "Browser is not open" });
      if (response.destroyed || response.writableEnded) return;
      if (this.browserStreams.size >= 4) return this.json(response, 429, { error: "Browser viewer limit reached" });
      let stop: (() => void) | undefined;
      let pending: import("../protocol/types.ts").WebBrowserFrame | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let closed = false;
      let unsubscribe = () => {};
      const flush = () => {
        timer = undefined;
        if (closed || !pending || response.writableNeedDrain) return;
        if (this.runtime.sessionManager.getSessionId() !== sessionId) { close(); return; }
        const frame = pending; pending = undefined;
        response.write(`data: ${JSON.stringify(frame)}\n\n`);
      };
      const schedule = () => { if (!closed && !timer) timer = setTimeout(flush, 16); };
      const heartbeat = setInterval(() => { if (!closed && !response.writableNeedDrain) response.write(": heartbeat\n\n"); }, 15_000);
      const close = () => {
        if (closed) return;
        closed = true; pending = undefined;
        clearTimeout(timer); clearInterval(heartbeat);
        stop?.(); unsubscribe();
        this.browserStreams.delete(close);
        response.off("drain", schedule);
        response.destroy();
      };
      this.browserStreams.add(close);
      response.once("close", close);
      response.on("drain", schedule);
      unsubscribe = this.runtime.subscribe(() => {
        if (this.runtime.sessionManager.getSessionId() !== sessionId) close();
      });
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
      response.write(": connected\n\n");
      try {
        stop = await this.embeddedBrowser.subscribeFrames(sessionId, frame => {
          if (!frame) { close(); return; }
          if (!closed) { pending = frame; schedule(); }
        });
        if (!stop || closed) { stop?.(); close(); }
      } catch { close(); }
      return;
    }
    if (url.pathname === "/api/browser/frame") {
      if (request.method !== "GET")
        return this.json(response, 405, { error: "browser frame requires GET" });
      const sessionId = url.searchParams.get("sessionId");
      if (!sessionId || !this.validTerminalQuery(url, ["sessionId"]))
        return this.json(response, 400, {
          code: "INVALID_BROWSER_TARGET",
          error: "an exact Session id is required",
        });
      if (!(await this.requireActiveToolSession(sessionId, response))) return;
      const frame = await this.embeddedBrowser.frame(sessionId);
      if (!frame)
        return this.json(response, 404, {
          code: "BROWSER_NOT_FOUND",
          error: "the embedded browser is not running",
        });
      response.writeHead(200, {
        "Content-Type": "image/jpeg",
        "Content-Length": frame.length,
        "Cache-Control": "no-store",
        "Cross-Origin-Resource-Policy": "same-origin",
        "X-Content-Type-Options": "nosniff",
      });
      response.end(frame);
      return;
    }
    if (url.pathname === "/api/browser/action") {
      if (request.method !== "POST")
        return this.json(response, 405, { error: "browser actions require POST" });
      // JSON can escape each UTF-16 code unit into six ASCII bytes.
      const body = await this.readJson(request, WEB_BROWSER_TEXT_MAX_LENGTH * 6 + MAX_COMMAND_BYTES);
      if (typeof body.sessionId !== "string")
        return this.json(response, 400, {
          code: "INVALID_BROWSER_ACTION",
          error: "an exact Session id and browser action are required",
        });
      const action = parseBrowserAction(body);
      if (!action)
        return this.json(response, 400, {
          code: "INVALID_BROWSER_ACTION",
          error: "the browser action is invalid",
        });
      if (!(await this.requireActiveToolSession(body.sessionId, response)))
        return;
      const state = await this.embeddedBrowser.action(body.sessionId, action);
      return state
        ? this.json(response, 200, state)
        : this.json(response, 404, {
            code: "BROWSER_NOT_FOUND",
            error: "the embedded browser is not running",
          });
    }
    if (url.pathname === "/api/terminal/events") {
      if (request.method !== "GET")
        return this.json(response, 405, {
          error: "terminal events require GET",
        });
      return this.interactiveTerminalEvents(request, response, url);
    }
    if (url.pathname === "/api/terminal") {
      if (request.method === "POST") {
        const body = await this.readJson(request);
        if (
          Object.keys(body).length !== 3 ||
          typeof body.sessionId !== "string" ||
          !isBoundedInteger(body.cols, 2, 1_000) ||
          !isBoundedInteger(body.rows, 2, 1_000)
        ) {
          return this.json(response, 400, {
            code: "INVALID_TERMINAL_CREATE_REQUEST",
            error:
              "an exact Session id and bounded terminal dimensions are required",
          });
        }
        const cwd = await this.requireActiveToolSession(
          body.sessionId,
          response,
        );
        if (!cwd) return;
        const terminal = await this.interactiveTerminals.create({
          sessionId: body.sessionId,
          cwd,
          cols: body.cols,
          rows: body.rows,
        });
        return this.json(response, terminal.reused ? 200 : 201, terminal);
      }
      const sessionId = url.searchParams.get("sessionId");
      const id = url.searchParams.get("id");
      if (
        !this.validTerminalQuery(url, ["sessionId", "id"]) ||
        !sessionId ||
        !id
      ) {
        return this.json(response, 400, {
          code: "INVALID_TERMINAL_TARGET",
          error: "an exact terminal and Session id are required",
        });
      }
      if (!(await this.requireActiveToolSession(sessionId, response))) return;
      if (request.method === "GET") {
        const terminal = this.interactiveTerminals.get(sessionId, id);
        return terminal
          ? this.json(response, 200, terminal)
          : this.json(response, 404, {
              code: "TERMINAL_NOT_FOUND",
              error: "the interactive terminal expired or closed",
            });
      }
      if (request.method === "DELETE") {
        this.interactiveTerminals.close(sessionId, id);
        return this.json(response, 200, { closed: true });
      }
      return this.json(response, 405, {
        error: "terminal accepts GET, POST, or DELETE",
      });
    }
    if (url.pathname === "/api/terminal/input") {
      if (request.method !== "POST")
        return this.json(response, 405, {
          error: "terminal input requires POST",
        });
      const body = await this.readJson(request);
      if (
        Object.keys(body).length !== 3 ||
        typeof body.sessionId !== "string" ||
        typeof body.id !== "string" ||
        typeof body.data !== "string" ||
        body.data.length === 0 ||
        body.data.length > INTERACTIVE_TERMINAL_MAX_INPUT
      ) {
        return this.json(response, 400, {
          code: "INVALID_TERMINAL_INPUT",
          error: "bounded input for an exact terminal is required",
        });
      }
      if (!(await this.requireActiveToolSession(body.sessionId, response)))
        return;
      return this.interactiveTerminals.write(
        body.sessionId,
        body.id,
        body.data,
      )
        ? this.json(response, 200, { written: true })
        : this.json(response, 404, {
            code: "TERMINAL_NOT_FOUND",
            error: "the interactive terminal expired or closed",
          });
    }
    if (url.pathname === "/api/terminal/resize") {
      if (request.method !== "POST")
        return this.json(response, 405, {
          error: "terminal resize requires POST",
        });
      const body = await this.readJson(request);
      if (
        Object.keys(body).length !== 4 ||
        typeof body.sessionId !== "string" ||
        typeof body.id !== "string" ||
        !isBoundedInteger(body.cols, 2, 1_000) ||
        !isBoundedInteger(body.rows, 2, 1_000)
      ) {
        return this.json(response, 400, {
          code: "INVALID_TERMINAL_RESIZE",
          error: "bounded dimensions for an exact terminal are required",
        });
      }
      if (!(await this.requireActiveToolSession(body.sessionId, response)))
        return;
      return this.interactiveTerminals.resize(
        body.sessionId,
        body.id,
        body.cols,
        body.rows,
      )
        ? this.json(response, 200, { resized: true })
        : this.json(response, 404, {
            code: "TERMINAL_NOT_FOUND",
            error: "the interactive terminal expired or closed",
          });
    }
    if (url.pathname.startsWith("/api/artifacts/")) {
      try { await this.adapter.requireWorkspace(this.runtime.cwd); }
      catch { throw new ArtifactError("ARTIFACT_DENIED", 403, "File access requires an available Session workspace."); }
    }
    if (url.pathname === "/api/artifacts/resolve") {
      if (request.method !== "POST") return this.json(response, 405, { error: "File access requires POST" });
      const body = await this.readJson(request);
      if (typeof body.sessionId !== "string" || typeof body.reference !== "string" || body.access !== "read-file" || (body.parent !== undefined && typeof body.parent !== "string")) return this.json(response, 400, { error: "An explicit Session file-read request is required" });
      const handle = await this.artifacts.resolveFile(body.sessionId, body.reference, body.parent);
      return this.json(response, 200, { handle });
    }
    if (url.pathname === "/api/artifacts/authorize-file") {
      if (request.method !== "POST") return this.json(response, 405, { error: "File authorization requires POST" });
      const body = await this.readJson(request);
      if (Object.keys(body).length !== 3 || typeof body.sessionId !== "string" || typeof body.reference !== "string" || body.access !== "read-external-file")
        return this.json(response, 400, { error: "An explicit single-file authorization is required" });
      const handle = await this.artifacts.authorizeFile(body.sessionId, body.reference);
      return this.json(response, 200, { handle });
    }
    if (url.pathname === "/api/artifacts/content") {
      const handle = url.searchParams.get("handle");
      const sessionId = url.searchParams.get("sessionId");
      if (!handle || !sessionId || handle.length > 100 || sessionId.length > 500) return this.json(response, 400, { error: "File handle and Session are required" });
      if (request.method === "DELETE") {
        this.artifacts.release(handle, sessionId);
        return this.json(response, 200, { released: true });
      }
      if (request.method !== "GET") return this.json(response, 405, { error: "File content accepts GET or DELETE" });
      const download = url.searchParams.get("download") === "1";
      if (url.searchParams.get("metadata") === "1" && !download)
        return this.json(response, 200, await this.artifacts.metadata(handle, sessionId));
      const revision = url.searchParams.get("revision") ?? undefined;
      if (download && !/^[a-f0-9]{64}$/u.test(revision ?? "")) return this.json(response, 400, { error: "Download requires the preview content revision" });
      const result = await this.artifacts.read(handle, sessionId, revision);
      if (!download) return this.json(response, 200, result.preview);
      response.writeHead(200, {
        "Content-Type": "application/octet-stream", "Content-Length": result.bytes.length,
        "Content-Disposition": `attachment; filename="artifact"; filename*=UTF-8''${encodeURIComponent(result.preview.artifact.name).replace(/['()*]/gu, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`,
        "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Cross-Origin-Resource-Policy": "same-origin",
      });
      response.end(result.bytes);
      return;
    }
    if (
      url.pathname === "/api/workspaces/select" &&
      request.method === "POST"
    ) {
      const path = await this.directoryChooser(this.chooserAbort.signal);
      if (!path) return this.json(response, 200, { cancelled: true });
      const importedPath = await this.adapter.importWorkspace(path);
      this.publish("workspace_imported", { path: importedPath });
      return this.json(response, 201, { path: importedPath });
    }
    if (url.pathname === "/api/workspaces" && request.method === "POST") {
      const body = await this.readJson(request);
      if (typeof body.path !== "string" || body.path.trim().length === 0) {
        return this.json(response, 400, {
          error: "workspace path is required",
        });
      }
      const path = await this.adapter.importWorkspace(body.path);
      this.publish("workspace_imported", { path });
      return this.json(response, 201, { path });
    }
    if (url.pathname === "/api/workspaces" && request.method === "PATCH") {
      const body = await this.readJson(request);
      if (typeof body.path !== "string" || typeof body.name !== "string") {
        return this.json(response, 400, {
          error: "workspace path and name are required",
        });
      }
      const name = await this.adapter.renameWorkspace(body.path, body.name);
      this.publish("workspace_renamed", { path: body.path, name });
      return this.json(response, 200, { path: body.path, name });
    }
    if (url.pathname === "/api/workspaces" && request.method === "DELETE") {
      const path = url.searchParams.get("path");
      if (!path)
        return this.json(response, 400, {
          error: "workspace path is required",
        });
      await this.adapter.removeWorkspace(path);
      this.publish("workspace_removed", { path });
      return this.json(response, 200, { path, removed: true });
    }
    if (url.pathname === "/api/sessions" && request.method === "POST") {
      const body = await this.readJson(request);
      if (
        typeof body.workspacePath !== "string" ||
        typeof body.commandId !== "string" ||
        body.commandId.length === 0 ||
        body.commandId.length > 128
      ) {
        return this.json(response, 400, {
          error: "workspace path and bounded commandId are required",
        });
      }
      const workspacePath = await this.adapter.requireWorkspace(
        body.workspacePath,
      );
      const result = await this.runtime.newSession(workspacePath, {
        commandId: body.commandId,
      });
      const sessionPath =
        result.sessionPath ??
        this.runtime.sessionManager.getSessionFile() ??
        `current:${result.sessionId}`;
      await this.gitReviews.capture(sessionPath, this.runtime.cwd);
      if (!result.replayed) this.publish("session_created", {
        workspacePath,
        sessionId: result.sessionId,
        commandId: body.commandId,
        ...(result.sessionPath ? { sessionPath: result.sessionPath } : {}),
      });
      return this.json(response, 201, {
        ...result,
        commandId: body.commandId,
      });
    }
    if (url.pathname === "/api/sessions" && request.method === "PATCH") {
      const body = await this.readJson(request);
      if (typeof body.path !== "string" || typeof body.name !== "string") {
        return this.json(response, 400, {
          error: "session path and name are required",
        });
      }
      const name = await this.adapter.renameSession(body.path, body.name);
      this.publish("session_renamed", { sessionPath: body.path, name });
      return this.json(response, 200, { path: body.path, name });
    }
    if (url.pathname === "/api/sessions/archive" && request.method === "POST") {
      const path = url.searchParams.get("path");
      if (!path) return this.json(response, 400, { error: "session path is required" });
      await this.adapter.archiveSession(path);
      this.publish("session_archived", { sessionPath: path });
      return this.json(response, 200, { path, archived: true });
    }
    if (url.pathname === "/api/sessions/unarchive" && request.method === "POST") {
      const path = url.searchParams.get("path");
      if (!path) return this.json(response, 400, { error: "session path is required" });
      await this.adapter.unarchiveSession(path);
      this.publish("session_unarchived", { sessionPath: path });
      return this.json(response, 200, { path, archived: false });
    }
    if (url.pathname === "/api/sessions/select" && request.method === "POST") {
      const body = await this.readJson(request);
      if (typeof body.path !== "string" || body.path.trim().length === 0) {
        return this.json(response, 400, { error: "session path is required" });
      }
      const session = await this.adapter.requireSession(body.path);
      const result =
        this.adapter.isCurrentSession(session)
          ? { cancelled: false }
          : await this.runtime.switchSession(session.path);
      this.publish("session_selected", { sessionPath: session.path });
      return this.json(response, 200, result);
    }
    if (url.pathname === "/api/providers/api-key" && request.method === "POST") {
      const body = await this.readJson(request);
      if (Object.keys(body).length !== 3 || typeof body.sessionId !== "string" || typeof body.provider !== "string" || body.provider.length > 160 || typeof body.apiKey !== "string" || !body.apiKey.trim() || body.apiKey.length > 8192 || /[\r\n\u0000]/u.test(body.apiKey)) {
        return this.json(response, 400, { error: "sessionId, provider and a valid API key are required" });
      }
      if (!this.runtime.saveProviderKey) return this.json(response, 501, { error: "Provider configuration unavailable" });
      try {
        await this.runtime.saveProviderKey(body.sessionId, body.provider, body.apiKey.trim());
        this.publish("settings_changed", {});
        return this.json(response, 200, { saved: true });
      } catch (error) {
        // Provider errors can contain credential material. Never project them.
        return this.json(response, error instanceof WebRuntimeRequestError ? error.statusCode : 422, {
          error: "Could not complete credential save. Wait for an idle Session, refresh status and retry; this provider may require additional authentication settings.",
        });
      }
    }
    if (url.pathname === "/api/models/configuration" && request.method === "POST") {
      const body = await this.readJson(request);
      if (Object.keys(body).length !== 3 || typeof body.sessionId !== "string" || typeof body.revision !== "string" || !validModelConfiguration(body.model)) return this.json(response, 400, { error: "Invalid model configuration" });
      if (!this.runtime.saveModelConfiguration) return this.json(response, 501, { error: "Model configuration unavailable" });
      try {
        await this.runtime.saveModelConfiguration(body.sessionId, body.revision, body.model);
        this.publish("settings_changed", {});
        return this.json(response, 200, { saved: true });
      } catch {
        return this.json(response, 409, { error: "Could not complete model save. Wait for an idle Session and refresh configuration before retrying." });
      }
    }
    if (url.pathname === "/api/model" && request.method === "POST") {
      const body = await this.readJson(request);
      if (
        typeof body.provider !== "string" ||
        typeof body.modelId !== "string" ||
        typeof body.sessionId !== "string" ||
        !validSessionPath(body.sessionPath)
      ) {
        return this.json(response, 400, {
          error: "provider, modelId, sessionId, and sessionPath are required",
        });
      }
      if (this.runtime.workspaceSelected !== true) {
        return this.json(response, 409, {
          code: "WORKSPACE_REQUIRED",
          error: "Choose a workspace before using the Web runtime",
        });
      }
      try {
        if (!this.adapter.isCurrentSession({ id: body.sessionId, path: body.sessionPath })) {
          throw new WebRuntimeRequestError("Only the active Web session accepts model changes", "SESSION_CONFLICT", 409);
        }
        const model = await this.runtime.setModel(body.provider, body.modelId, {
          expectedSessionId: body.sessionId,
          expectedSessionPath: body.sessionPath,
        });
        this.publish("model_selected", {
          provider: model.provider,
          modelId: model.id,
        });
        return this.json(response, 200, model);
      } catch (error) {
        const failure = this.runtimeRequestFailure(
          error,
          "MODEL_SELECTION_FAILED",
          "model selection failed",
        );
        return this.json(response, failure.status, {
          code: failure.code,
          error: failure.error,
        });
      }
    }
    if (url.pathname === "/api/prompt" && request.method === "POST") {
      const requestStarted = performance.now();
      const body = await this.readJson(request, MAX_PROMPT_REQUEST_BYTES);
      const content =
        typeof body.content === "string" ? body.content.trim() : "";
      const parsedImages = parsePromptImages(body.images);
      if (!parsedImages.ok) {
        return this.json(response, 400, {
          code: "INVALID_PROMPT_IMAGES",
          error: parsedImages.error,
        });
      }
      if ((!content && parsedImages.images.length === 0) || content.length > 12_000) {
        return this.json(response, 400, {
          error: "prompt must contain text or images and at most 12000 characters",
        });
      }
      const imageSignature = promptImageSignature(parsedImages.images);
      const commandId =
        typeof body.commandId === "string" && body.commandId.length > 0
          ? body.commandId
          : randomUUID();
      if (commandId.length > 128) {
        return this.json(response, 400, {
          error: "commandId must be at most 128 characters",
        });
      }
      if (body.retry !== undefined && typeof body.retry !== "boolean") {
        return this.json(response, 400, {
          error: "retry must be a boolean when provided",
        });
      }
      if (typeof body.sessionId !== "string" || !validSessionPath(body.sessionPath)) {
        return this.json(response, 400, {
          error: "sessionId and sessionPath are required",
        });
      }
      if (body.controllerId !== undefined && !isWebControllerId(body.controllerId)) {
        return this.json(response, 400, { code: "INVALID_CONTROLLER", error: "a valid browser controller id is required" });
      }
      const existing = this.promptAdmissions.get(commandId);
      if (existing) {
        if (
          existing.sessionId !== body.sessionId ||
          existing.sessionPath !== body.sessionPath ||
          existing.content !== content ||
          existing.imageSignature !== imageSignature ||
          existing.controllerId !== body.controllerId
        ) {
          return this.json(response, 409, {
            code: "COMMAND_CONFLICT",
            error: "commandId is already bound to a different prompt",
          });
        }
        const result = await existing.completion;
        traceWeb("prompt_admission_replayed", {
          commandId,
          sessionId: body.sessionId,
          status: result.status,
          elapsedMs: elapsed(requestStarted),
        });
        return this.json(response, result.status, result.body);
      }
      if (body.retry === true) {
        return this.json(response, 409, {
          code: "COMMAND_ADMISSION_UNKNOWN",
          error: "previous prompt admission is unknown; refresh canonical state before sending a new request",
        });
      }
      if (this.runtime.workspaceSelected !== true) {
        return this.json(response, 409, {
          code: "WORKSPACE_REQUIRED",
          error: "Choose a workspace before using the Web runtime",
        });
      }
      if (
        !this.adapter.isCurrentSession({ id: body.sessionId, path: body.sessionPath })
      ) {
        return this.json(response, 409, {
          code: "SESSION_CONFLICT",
          error: "Only the active Web session accepts messages",
        });
      }
      if (!this.makePromptAdmissionSpace()) {
        return this.json(response, 503, {
          code: "PROMPT_ADMISSION_CAPACITY",
          error: "prompt admission capacity is full; wait for a pending admission to settle",
        });
      }
      const admission = this.beginPromptAdmission(
        commandId,
        body.sessionId,
        body.sessionPath,
        content,
        parsedImages.images,
        imageSignature,
        body.controllerId,
      );
      const result = await admission.completion;
      return this.json(response, result.status, result.body);
    }
    if (url.pathname === "/api/questions/pending" && request.method === "GET") {
      const sessionId = url.searchParams.get("sessionId");
      const controller = request.headers["x-openpi-web-controller"];
      if (!sessionId || sessionId.length > 128 || !isWebControllerId(controller)) {
        return this.json(response, 400, { code: "INVALID_QUESTION_TARGET", error: "Session and browser controller are required" });
      }
      return this.json(response, 200, { pending: this.questions.read(sessionId, controller) });
    }
    if (url.pathname === "/api/questions/answer" && request.method === "POST") {
      const body = await this.readJson(request, WEB_QUESTION_BODY_BYTES);
      const controller = request.headers["x-openpi-web-controller"];
      if (!isWebControllerId(controller) || !isWebControllerId(body.requestId) ||
          typeof body.sessionId !== "string" || !body.sessionId || body.sessionId.length > 128) {
        return this.json(response, 400, { code: "INVALID_QUESTION_TARGET", error: "An exact question request and browser controller are required" });
      }
      const result = this.questions.answer(body.sessionId, body.requestId, controller, body.action, body.answers);
      return this.json(response, result.status, result.body);
    }
    if (url.pathname === "/api/turns/cancel" && request.method === "POST") {
      const body = await this.readJson(request);
      if (
        typeof body.sessionId !== "string" ||
        body.sessionId.length === 0 ||
        body.sessionId.length > 128 ||
        typeof body.commandId !== "string" ||
        body.commandId.length === 0 ||
        body.commandId.length > 128 ||
        typeof body.epoch !== "number" ||
        !Number.isSafeInteger(body.epoch) ||
        body.epoch <= 0
      ) {
        return this.json(response, 400, {
          code: "INVALID_TURN",
          error: "bounded sessionId, commandId, and positive turn epoch are required",
        });
      }
      if (this.runtime.workspaceSelected !== true) {
        return this.json(response, 409, {
          code: "WORKSPACE_REQUIRED",
          error: "Choose a workspace before using the Web runtime",
        });
      }
      const result = await this.runtime.cancelTurn({
        sessionId: body.sessionId,
        commandId: body.commandId,
        epoch: body.epoch,
      });
      traceWeb("turn_cancel_receipt", { ...result });
      const status =
        result.state === "accepted"
          ? 202
          : result.state === "already-settled"
            ? 200
            : result.state === "failed"
              ? 500
              : 409;
      return this.json(response, status, {
        ...result,
        accepted: result.state === "accepted",
        cursor: this.sequence,
      });
    }
    if (url.pathname === "/api/plan" && request.method === "POST") {
      const body = await this.readJson(request, 1024);
      if (typeof body.sessionId !== "string" || !body.sessionId || body.sessionId.length > 256 ||
        !validSessionPath(body.sessionPath) ||
        typeof body.enabled !== "boolean" ||
        !(body.expectedRevision === null || (typeof body.expectedRevision === "string" && body.expectedRevision.length <= 256)) ||
        Object.keys(body).some((key) => !["sessionId", "sessionPath", "enabled", "expectedRevision"].includes(key)))
        return this.json(response, 400, { code: "INVALID_PLAN_REQUEST", error: "An exact Session id and path, enabled flag and expected Plan revision are required" });
      if (!this.runtime.setPlanMode)
        return this.json(response, 501, { code: "PLAN_CONTROL_UNAVAILABLE", error: "Plan control is unavailable" });
      try {
        if (!this.adapter.isCurrentSession({ id: body.sessionId, path: body.sessionPath }))
          throw new WebRuntimeRequestError("Only the active Web session accepts Plan changes", "SESSION_CONFLICT", 409);
        const plan = await this.runtime.setPlanMode({ sessionId: body.sessionId, sessionPath: body.sessionPath, enabled: body.enabled, expectedRevision: body.expectedRevision });
        return this.json(response, 200, { sessionId: body.sessionId, ...plan });
      } catch (error) {
        const failure = this.runtimeRequestFailure(error, "PLAN_SELECTION_FAILED", "Plan mode could not be changed");
        return this.json(response, failure.status, { code: failure.code, error: failure.error });
      }
    }
    if (url.pathname === "/api/thinking" && request.method === "POST") {
      const body = await this.readJson(request);
      if (
        typeof body.sessionId !== "string" ||
        body.sessionId.length > 256 ||
        !validSessionPath(body.sessionPath) ||
        typeof body.level !== "string" ||
        !THINKING_LEVELS.has(body.level)
      ) {
        return this.json(response, 400, {
          error: "sessionId, sessionPath, and a valid level are required",
        });
      }
      if (this.runtime.workspaceSelected !== true) {
        return this.json(response, 409, {
          code: "WORKSPACE_REQUIRED",
          error: "Choose a workspace before using the Web runtime",
        });
      }
      if (!this.runtime.setThinkingLevel) {
        return this.json(response, 501, {
          code: "THINKING_CONTROL_UNAVAILABLE",
          error: "thinking control is unavailable",
        });
      }
      try {
        if (!this.adapter.isCurrentSession({ id: body.sessionId, path: body.sessionPath })) {
          throw new WebRuntimeRequestError("Only the active Web session accepts thinking changes", "SESSION_CONFLICT", 409);
        }
        const projection = await this.runtime.setThinkingLevel(body.level, {
          expectedSessionId: body.sessionId,
          expectedSessionPath: body.sessionPath,
        });
        return this.json(response, 200, {
          sessionId: body.sessionId,
          ...boundThinkingProjection(projection),
          revision: this.sequence,
        });
      } catch (error) {
        const failure = this.runtimeRequestFailure(
          error,
          "THINKING_SELECTION_FAILED",
          "thinking selection failed",
        );
        return this.json(response, failure.status, {
          code: failure.code,
          error: failure.error,
        });
      }
    }
    if (
      url.pathname === "/api/capabilities/action" &&
      request.method === "POST"
    ) {
      const body = await this.readJson(request);
      const keys = Object.keys(body);
      const sessionId = body.sessionId;
      const kind = body.kind;
      const action = body.action;
      const id = body.id;
      const prompt = body.prompt;
      const text = body.text;
      const validBase =
        typeof sessionId === "string" &&
        sessionId.length > 0 &&
        sessionId.length <= 128 &&
        kind === "subagents";
      const validId =
        typeof id === "string" &&
        id.length > 0 &&
        id.length <= 160 &&
        !/[\u0000-\u001f\u007f]/u.test(id);
      const validPrompt =
        typeof prompt === "string" &&
        prompt.trim().length > 0 &&
        prompt.length <= 12_000;
      const validText =
        typeof text === "string" &&
        text.trim().length > 0 &&
        text.length <= 12_000;
      const validAction =
        (action === "spawn-btw" &&
          validPrompt &&
          keys.length === 4 &&
          keys.every((key) =>
            ["sessionId", "kind", "action", "prompt"].includes(key),
          )) ||
        (action === "send-btw" &&
          validId &&
          validText &&
          keys.length === 5 &&
          keys.every((key) =>
            ["sessionId", "kind", "action", "id", "text"].includes(key),
          )) ||
        (action === "cancel-btw" &&
          validId &&
          keys.length === 4 &&
          keys.every((key) =>
            ["sessionId", "kind", "action", "id"].includes(key),
          ));
      if (!validBase || !validAction) {
        return this.json(response, 400, {
          code: "INVALID_CAPABILITY_ACTION",
          error: "a bounded action for the active Session is required",
        });
      }
      if (sessionId !== this.runtime.sessionManager.getSessionId()) {
        return this.json(response, 409, {
          code: "SESSION_CHANGED",
          error: "The active Session changed. Reopen the tool panel.",
        });
      }
      if (this.runtime.workspaceSelected !== true) {
        return this.json(response, 409, {
          code: "WORKSPACE_REQUIRED",
          error: "Choose a workspace before using Session tools",
        });
      }
      const controller = new AbortController();
      const abort = () => controller.abort();
      request.once("aborted", abort);
      response.once("close", abort);
      try {
        let requestAction: WebCapabilityActionRequest;
        if (action === "spawn-btw" && typeof prompt === "string") {
          requestAction = {
            kind: "subagents",
            action,
            prompt: prompt.trim(),
          };
        } else if (
          action === "send-btw" &&
          typeof id === "string" &&
          typeof text === "string"
        ) {
          requestAction = {
            kind: "subagents",
            action,
            id,
            text: text.trim(),
          };
        } else if (action === "cancel-btw" && typeof id === "string") {
          requestAction = { kind: "subagents", action, id };
        } else {
          return this.json(response, 400, {
            code: "INVALID_CAPABILITY_ACTION",
            error: "a bounded action for the active Session is required",
          });
        }
        const detail = await runWebCapabilityAction(
          this.runtime.sessionManager,
          requestAction,
          controller.signal,
        );
        if (!detail) {
          return this.json(response, 501, {
            code: "CAPABILITY_ACTION_UNAVAILABLE",
            error: "This Session does not expose the requested action",
          });
        }
        return this.json(response, 200, { sessionId, detail });
      } catch (error) {
        return this.json(response, 409, {
          code: "CAPABILITY_ACTION_FAILED",
          error:
            error instanceof Error
              ? error.message
              : "The capability action failed",
        });
      } finally {
        request.off("aborted", abort);
        response.off("close", abort);
      }
    }
    if (request.method !== "GET") {
      return this.json(response, 405, { error: "method not allowed" });
    }
    const diagnosticSession = url.searchParams.get("sessionId");
    if (
      diagnosticSession !== null &&
      ["/api/thinking", "/api/trust", "/api/providers/auth-status", "/api/models/configuration", "/api/capabilities/detail", "/api/settings/catalog"].includes(url.pathname) &&
      diagnosticSession !== this.runtime.sessionManager.getSessionId()
    ) {
      return this.json(response, 409, {
        code: "SESSION_CHANGED",
        error: "The active Session changed. Reopen the panel to inspect it.",
      });
    }
    if (url.pathname === "/events") return this.eventsStream(request, response);
    if (url.pathname === "/api/commands") {
      if (
        diagnosticSession === null ||
        diagnosticSession.length === 0 ||
        diagnosticSession.length > 128 ||
        url.searchParams.getAll("sessionId").length !== 1 ||
        [...url.searchParams.keys()].some((key) => key !== "sessionId")
      ) {
        return this.json(response, 400, {
          code: "INVALID_COMMAND_DISCOVERY_REQUEST",
          error: "the active Session id is required",
        });
      }
      if (diagnosticSession !== this.runtime.sessionManager.getSessionId()) {
        return this.json(response, 409, {
          code: "SESSION_CHANGED",
          error: "The active Session changed. Reopen command discovery.",
        });
      }
      if (this.runtime.workspaceSelected !== true) {
        return this.json(response, 409, {
          code: "WORKSPACE_REQUIRED",
          error: "Choose a workspace before discovering commands",
        });
      }
      if (!this.runtime.listCommands) {
        return this.json(response, 501, {
          code: "COMMAND_DISCOVERY_UNAVAILABLE",
          error: "Pi command discovery is unavailable",
        });
      }
      return this.json(response, 200, this.runtime.listCommands());
    }
    if (url.pathname === "/api/settings/catalog") {
      if (
        diagnosticSession === null ||
        diagnosticSession.length === 0 ||
        diagnosticSession.length > 128 ||
        url.searchParams.getAll("sessionId").length !== 1 ||
        [...url.searchParams.keys()].some((key) => key !== "sessionId")
      ) {
        return this.json(response, 400, {
          code: "INVALID_SETTINGS_CATALOG_REQUEST",
          error: "the active Session id is required",
        });
      }
      if (this.runtime.workspaceSelected !== true) {
        return this.json(response, 409, {
          code: "WORKSPACE_REQUIRED",
          error: "Choose a workspace before reading settings resources",
        });
      }
      if (!this.runtime.listSettingsResources) {
        return this.json(response, 501, {
          code: "SETTINGS_CATALOG_UNAVAILABLE",
          error: "Pi settings resources are unavailable",
        });
      }
      return this.json(response, 200, {
        sessionId: diagnosticSession,
        setup: projectWebSetupConfig(loadSetupConfig()),
        resources: this.runtime.listSettingsResources(),
      });
    }
    if (url.pathname === "/api/git-review") {
      const sessionId = url.searchParams.get("sessionId");
      const sessionPath = url.searchParams.get("path");
      const source = url.searchParams.get("source") ?? "unstaged";
      const filePath = url.searchParams.get("file");
      if (
        !["unstaged", "staged", "branch", "session"].includes(source) ||
        (filePath !== null && (!filePath || filePath.length > 4096 || filePath.includes("\0"))) ||
        url.searchParams.getAll("source").length > 1 ||
        url.searchParams.getAll("file").length > 1 ||
        !sessionId ||
        sessionId.length > 256 ||
        !sessionPath ||
        url.searchParams.getAll("sessionId").length !== 1 ||
        url.searchParams.getAll("path").length !== 1 ||
        [...url.searchParams.keys()].some(
          (key) => !["sessionId", "path", "source", "file"].includes(key),
        )
      ) {
        return this.json(response, 400, {
          code: "INVALID_GIT_REVIEW_REQUEST",
          error: "an exact Session id and path are required",
        });
      }
      const session = await this.adapter.getSession(sessionPath);
      if (!session || session.id !== sessionId) {
        return this.json(response, 404, {
          code: "SESSION_NOT_FOUND",
          error: "the Session is not available in the current workspace",
        });
      }
      return this.json(
        response,
        200,
        await this.gitReviews.read(session.path, session.cwd, {
          source: source as import("../protocol/types.ts").WebGitReviewSource,
          summary: filePath === null,
          ...(filePath === null ? {} : { filePath }),
        }),
      );
    }
    if (url.pathname === "/api/sessions") {
      const projection = await this.adapter.listSessionProjection();
      return this.json(response, 200, {
        sessions: projection.sessions,
        truncation: {
          truncated: projection.omitted > 0,
          sessionsOmitted: projection.omitted,
        },
      });
    }
    if (url.pathname === "/api/terminal-sessions") {
      const query = url.searchParams.get("query") ?? "";
      if (query.length > 200) {
        return this.json(response, 400, {
          code: "QUERY_TOO_LONG",
          error: "query must be at most 200 characters",
        });
      }
      const cursor = this.parseCursor(url.searchParams.get("cursor"));
      if (cursor.invalid) {
        return this.json(response, 400, {
          code: "INVALID_CURSOR",
          error: "cursor must be a non-negative integer",
        });
      }
      const rawLimit = url.searchParams.get("limit");
      const limit = rawLimit === null ? 50 : Number(rawLimit);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        return this.json(response, 400, {
          code: "INVALID_LIMIT",
          error: "limit must be an integer from 1 to 100",
        });
      }
      const controller = new AbortController();
      const abort = () => controller.abort();
      request.once("aborted", abort);
      response.once("close", abort);
      const signal = AbortSignal.any([controller.signal, this.chooserAbort.signal]);
      try {
        const path = url.searchParams.get("path");
        if (path) {
          return this.json(
            response,
            200,
            await this.adapter.getReadOnlyTerminalSession(path, { signal }),
          );
        }
        return this.json(
          response,
          200,
          await this.adapter.listReadOnlyTerminalSessions({
            query,
            cursor: cursor.value,
            limit,
            signal,
          }),
        );
      } catch (error) {
        if (error instanceof WebReadOnlySessionError) {
          return this.json(response, error.statusCode, {
            code: error.code,
            error: error.message,
          });
        }
        throw error;
      } finally {
        request.off("aborted", abort);
        response.off("close", abort);
      }
    }
    if (url.pathname === "/api/sessions/archived") {
      const rawLimit = url.searchParams.get("limit");
      const limit = rawLimit === null ? undefined : Number(rawLimit);
      if (
        rawLimit !== null &&
        (!/^\d+$/u.test(rawLimit) ||
          !Number.isSafeInteger(limit) ||
          limit! <= 0 ||
          limit! > WEB_MAX_ARCHIVED_SESSION_PAGE)
      ) {
        return this.json(response, 400, {
          code: "INVALID_ARCHIVED_SESSION_QUERY",
          error: "archived Session limit must be a bounded positive integer",
        });
      }
      const result = await this.adapter.listArchivedSessions({
        ...(url.searchParams.has("cursor")
          ? { cursor: url.searchParams.get("cursor") ?? "" }
          : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(url.searchParams.has("q")
          ? { query: url.searchParams.get("q") ?? "" }
          : {}),
      });
      if (result.status === "invalid") {
        return this.json(response, 400, {
          code: "INVALID_ARCHIVED_SESSION_QUERY",
          error: "archived Session query is invalid or exceeds its bounds",
        });
      }
      if (result.status === "stale_cursor") {
        return this.json(response, 409, {
          code: "ARCHIVED_SESSION_CURSOR_STALE",
          error: "archived Session cursor is stale for this query",
        });
      }
      return this.json(response, 200, {
        sessions: result.sessions,
        ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
        truncation: result.truncation,
      });
    }
    if (url.pathname === "/api/models")
      {
        const query = url.searchParams.get("query") ?? "";
        const limitText = url.searchParams.get("limit");
        const limit = limitText === null ? WEB_MAX_MODEL_SEARCH_RESULTS : Number(limitText);
        const sessionId = url.searchParams.get("sessionId");
        if (query.length > WEB_MAX_MODEL_QUERY) {
          return this.json(response, 400, {
            code: "INVALID_MODEL_QUERY",
            error: `model query must be at most ${WEB_MAX_MODEL_QUERY} characters`,
          });
        }
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > WEB_MAX_MODEL_SEARCH_RESULTS) {
          return this.json(response, 400, {
            code: "INVALID_MODEL_LIMIT",
            error: `model limit must be an integer between 1 and ${WEB_MAX_MODEL_SEARCH_RESULTS}`,
          });
        }
        if (
          sessionId !== null &&
          sessionId !== this.runtime.sessionManager.getSessionId()
        ) {
          return this.json(response, 409, {
            code: "SESSION_CHANGED",
            error: "The active Session changed. Refresh the model list.",
          });
        }
        const result = this.runtime.searchModels(query, limit);
        return this.json(response, 200, result);
      }
    if (url.pathname === "/api/trust") {
      if (!this.runtime.getProjectTrustStatus) {
        return this.json(response, 501, {
          code: "PROJECT_TRUST_STATUS_UNAVAILABLE",
          error: "project Trust status is unavailable",
        });
      }
      return this.json(response, 200, this.runtime.getProjectTrustStatus());
    }
    if (url.pathname === "/api/capabilities/detail") {
      const kind = url.searchParams.get("kind");
      const id = url.searchParams.get("id");
      if (
        (kind !== "subagents" &&
          kind !== "workflows" &&
          kind !== "background-terminals") ||
        id === null
      ) {
        return this.json(response, 400, {
          code: "INVALID_CAPABILITY_DETAIL_TARGET",
          error: "a supported capability kind and exact id are required",
        });
      }
      const receipt = webCapabilityDetail(
        this.runtime.sessionManager,
        kind,
        id,
      );
      if (receipt.status === "invalid") {
        return this.json(response, 400, {
          code: "INVALID_CAPABILITY_DETAIL_TARGET",
          error: "a supported capability kind and exact id are required",
        });
      }
      if (receipt.status === "unavailable") {
        return this.json(response, 404, {
          code: "CAPABILITY_DETAILS_UNAVAILABLE",
          error: "capability details are unavailable for the active Session",
        });
      }
      if (receipt.status === "missing") {
        return this.json(response, 404, {
          code: "CAPABILITY_NOT_FOUND",
          error: "capability resource was not found in the active Session",
        });
      }
      return this.json(response, 200, {
        sessionId: this.runtime.sessionManager.getSessionId(),
        detail: receipt.detail,
      });
    }
    if (url.pathname === "/api/capabilities")
      return this.json(response, 200, {
        sessionId: this.runtime.sessionManager.getSessionId(),
        capabilities: webCapabilitySnapshot(this.runtime.sessionManager),
      });
    if (url.pathname === "/api/diagnostics")
      return this.json(response, 200, {
        node: process.version,
        cwd: this.runtime.cwd,
        sessionId: this.runtime.sessionManager.getSessionId(),
        workspaceSelected: this.runtime.workspaceSelected,
        models: this.runtime.listModels().filter((model) => model.current),
      });
    if (url.pathname === "/api/models/configuration") {
      if (!this.runtime.readModelConfigurations) return this.json(response, 501, { error: "Model configuration unavailable" });
      try {
        return this.json(response, 200, await this.runtime.readModelConfigurations());
      } catch {
        return this.json(response, 422, { error: "Cannot read models.json; check its JSON format" });
      }
    }
    if (url.pathname === "/api/providers/auth-status") {
      if (!this.runtime.listProviderAuth) {
        return this.json(response, 501, {
          code: "PROVIDER_AUTH_STATUS_UNAVAILABLE",
          error: "provider authentication status is unavailable",
        });
      }
      return this.json(response, 200, this.runtime.listProviderAuth());
    }
    if (url.pathname === "/api/thinking") {
      let sessionId = "";
      try {
        sessionId = this.runtime.sessionManager.getSessionId();
        const projection = this.runtime.getThinkingState?.();
        return this.json(response, 200, {
          sessionId,
          ...(projection
            ? boundThinkingProjection(projection)
            : {
                level: "unknown",
                available: [],
                supported: false,
              }),
          revision: this.sequence,
        });
      } catch {
        return this.json(response, 200, {
          sessionId,
          level: "unknown",
          available: [],
          supported: false,
          revision: this.sequence,
        });
      }
    }
    if (url.pathname === "/api/snapshot") {
      const historyEntry = url.searchParams.get("historyAnchor");
      const historySession = url.searchParams.get("historySessionId");
      if ((historyEntry !== null || historySession !== null) &&
        (!historyEntry || !historySession || historyEntry.length > 128 || historySession.length > 128 ||
         /[\s\u0000-\u001f]/u.test(historyEntry) || url.searchParams.getAll("historyAnchor").length !== 1 ||
         url.searchParams.getAll("historySessionId").length !== 1))
        return this.json(response, 400, { error: "a bounded history Session and entry anchor are required" });
      const cursor = this.sequence;
      const projection = await this.adapter.getSnapshot(
        url.searchParams.get("path") ?? undefined,
        historyEntry && historySession ? { sessionId: historySession, entryId: historyEntry } : undefined,
      );
      const setup = loadSetupConfig();
      const snapshot: WebSnapshot = {
        protocolVersion: WEB_PROTOCOL_VERSION,
        generatedAt: new Date().toISOString(),
        cursor,
        preferences: {
          theme: setup.ui.webTheme,
          chatWidth: setup.ui.webChatWidth,
          chatFontSize: setup.ui.webChatFontSize,
          expandThinking: setup.ui.webExpandThinking,
        },
        ...projection,
        runtime: { ...projection.runtime, liveTools: this.liveTools, ...this.webPlanState() },
        thinking: projection.thinking
          ? { ...projection.thinking, revision: this.sequence }
          : undefined,
      };
      let finalBytes = jsonByteLength(snapshot);
      while (finalBytes > WEB_MAX_SNAPSHOT_BYTES && snapshot.runtime.liveTools?.length) {
        snapshot.runtime.liveTools = snapshot.runtime.liveTools.slice(1);
        snapshot.truncation.truncated = true;
        finalBytes = jsonByteLength(snapshot);
      }
      while (finalBytes > WEB_MAX_SNAPSHOT_BYTES && snapshot.selectedExecution?.liveTools.length) {
        snapshot.selectedExecution.liveTools = snapshot.selectedExecution.liveTools.slice(1);
        snapshot.selectedExecution.liveToolsOmitted++;
        snapshot.truncation.truncated = true;
        finalBytes = jsonByteLength(snapshot);
      }
      while (snapshot.truncation.bytes !== finalBytes) {
        snapshot.truncation.bytes = finalBytes;
        finalBytes = jsonByteLength(snapshot);
      }
      return this.json(response, 200, snapshot);
    }
    if (url.pathname === "/api/session/history") {
      if (request.method !== "GET") return this.json(response, 405, { error: "GET required" });
      const keys = ["sessionId", "path", "anchorEntryId", "beforeEntryId"] as const;
      const values = keys.map((key) => url.searchParams.get(key));
      if ([...url.searchParams.keys()].some((key) => !keys.includes(key as typeof keys[number])) ||
        keys.some((key, index) => url.searchParams.getAll(key).length !== 1 || !values[index] ||
          values[index]!.length > (key === "path" ? 4096 : 128) || /[\u0000-\u001f]/u.test(values[index]!)))
        return this.json(response, 400, { code: "INVALID_HISTORY_REQUEST", error: "an exact Session id, path and native entry boundaries are required" });
      const page = await this.adapter.getSessionHistory(values[0]!, values[1]!, values[2]!, values[3]!);
      if (page.status === "not_found") return this.json(response, 404, { code: "SESSION_NOT_FOUND", error: "Session is not in the selected workspace" });
      if (page.status === "changed") return this.json(response, 409, { code: "SESSION_HISTORY_CHANGED", error: "The Session branch changed. Refresh the conversation before loading history." });
      return this.json(response, 200, { session: page.session });
    }
    if (url.pathname === "/api/session") {
      const path = url.searchParams.get("path");
      if (!path)
        return this.json(response, 400, { error: "session path is required" });
      const session = await this.adapter.getSession(path);
      return session
        ? this.json(response, 200, { session })
        : this.json(response, 404, {
            error: "session is not in the current workspace",
          });
    }
    this.json(response, 404, { error: "not found" });
  }

  private async chooseDirectory() {
    try {
      if (process.platform === "darwin") {
        const { stdout } = await execFileAsync(
          "osascript",
          [
            "-e",
            'tell application "System Events" to activate',
            "-e",
            'POSIX path of (choose folder with prompt "Choose a workspace")',
          ],
          { signal: this.chooserAbort.signal },
        );
        return stdout.trim() || undefined;
      }
      if (process.platform === "win32") {
        const { stdout } = await execFileAsync(
          "powershell.exe",
          [
            "-NoProfile",
            "-Command",
            "$dialog = New-Object -ComObject Shell.Application; $folder = $dialog.BrowseForFolder(0, 'Choose a workspace', 0); if ($folder) { $folder.Self.Path }",
          ],
          { signal: this.chooserAbort.signal },
        );
        return stdout.trim() || undefined;
      }
      const { stdout } = await execFileAsync(
        "zenity",
        ["--file-selection", "--directory", "--title=Choose a workspace"],
        { signal: this.chooserAbort.signal },
      );
      return stdout.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  private makePromptAdmissionSpace() {
    while (this.promptAdmissions.size >= MAX_PROMPT_ADMISSIONS) {
      const settled = [...this.promptAdmissions.entries()].find(
        ([commandId, admission]) => admission.result !== undefined &&
          commandId !== this.runtime.getActiveTurn()?.commandId,
      );
      if (!settled) return false;
      this.promptAdmissions.delete(settled[0]);
    }
    return true;
  }

  private beginPromptAdmission(
    commandId: string,
    sessionId: string,
    sessionPath: string,
    content: string,
    images: readonly WebPromptImage[],
    imageSignature: string,
    controllerId?: string,
  ) {
    let settle!: (result: PromptAdmissionResponse) => void;
    const admission: PromptAdmission = {
      sessionId,
      sessionPath,
      content,
      imageSignature,
      controllerId,
      completion: new Promise<PromptAdmissionResponse>((resolve) => {
        settle = resolve;
      }),
    };
    // Store before dispatch: a client retry can only replay this record.
    this.promptAdmissions.set(commandId, admission);
    try {
      traceWeb("prompt_received", {
        commandId,
        sessionId,
        chars: content.length,
        images: images.length,
      });
    } catch {}
    void Promise.resolve()
      .then(() =>
        this.runtime.sendPrompt(content, {
          commandId,
          expectedSessionId: sessionId,
          expectedSessionPath: sessionPath,
          ...(images.length > 0 ? { images } : {}),
        }),
      )
      .then(
        (receipt) => {
          const result: PromptAdmissionResponse = {
            status: 202,
            body: {
              id: commandId,
              accepted: true,
              state: "accepted",
              pendingFollowUps: receipt.pendingFollowUps,
              cursor: this.sequence,
            },
          };
          try {
            this.publish("prompt_accepted", {
              commandId,
              sessionId,
              pendingFollowUps: receipt.pendingFollowUps,
            });
            result.body.cursor = this.sequence;
          } catch {}
          return result;
        },
        (error) => {
          const failure = this.runtimeRequestFailure(error);
          return {
            status: failure.status,
            body: { code: failure.code, error: failure.error },
          };
        },
      )
      .then((result: PromptAdmissionResponse) => {
        admission.result = result;
        settle(result);
        try {
          traceWeb(
            result.status === 202
              ? "prompt_admission_finished"
              : "prompt_admission_failed",
            {
              commandId,
              sessionId,
              status: result.status,
              ...(typeof result.body.error === "string"
                ? { error: result.body.error }
                : {}),
            },
          );
        } catch {}
      })
      .catch((error) => {
        if (admission.result) return;
        const failure = this.runtimeRequestFailure(error);
        const result: PromptAdmissionResponse = {
          status: failure.status,
          body: { code: failure.code, error: failure.error },
        };
        admission.result = result;
        settle(result);
      });
    return admission;
  }

  private webPlanState() {
    if (!this.runtime.workspaceSelected) return undefined;
    try {
      if (!this.runtime.listCommands?.().commands.some((command) => command.support === "plan")) return undefined;
      const state = projectPlanControl(this.runtime.sessionManager.getBranch());
      return { plan: state.status, planRevision: state.revision, planHasPrompt: state.hasPrompt };
    } catch { return undefined; }
  }

  private async readJson(request: IncomingMessage, maxBytes = MAX_COMMAND_BYTES) {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > maxBytes) {
        throw new WebRequestError(
          "request body is too large",
          "REQUEST_BODY_TOO_LARGE",
          413,
          maxBytes,
        );
      }
      chunks.push(buffer);
    }
    let value: unknown;
    try {
      value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new WebRequestError(
        "request body is invalid JSON",
        "INVALID_REQUEST_BODY",
        400,
      );
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new WebRequestError(
        "request body must be an object",
        "INVALID_REQUEST_BODY",
        400,
      );
    }
    return value as Record<string, unknown>;
  }

  private async requireActiveToolSession(
    sessionId: string,
    response: ServerResponse,
  ) {
    if (
      sessionId.length === 0 ||
      sessionId.length > 128 ||
      /[\u0000-\u001f\u007f]/u.test(sessionId)
    ) {
      this.json(response, 400, {
        code: "INVALID_SESSION_ID",
        error: "a bounded active Session id is required",
      });
      return undefined;
    }
    if (!this.runtime.workspaceSelected) {
      this.json(response, 409, {
        code: "WORKSPACE_REQUIRED",
        error: "Choose a workspace before using Session tools",
      });
      return undefined;
    }
    const expectedSessionManager = this.runtime.sessionManager;
    const expectedSessionPath = expectedSessionManager.getSessionFile();
    const expectedCwd = this.runtime.cwd;
    if (sessionId !== expectedSessionManager.getSessionId()) {
      this.json(response, 409, {
        code: "SESSION_CHANGED",
        error: "The active Session changed. Reopen the tool panel.",
      });
      return undefined;
    }
    try {
      const workspace = await this.adapter.requireWorkspace(expectedCwd);
      const activeSessionManager = this.runtime.sessionManager;
      if (
        !this.runtime.workspaceSelected ||
        this.runtime.cwd !== expectedCwd ||
        activeSessionManager !== expectedSessionManager ||
        activeSessionManager.getSessionId() !== sessionId ||
        activeSessionManager.getSessionFile() !== expectedSessionPath
      ) {
        this.json(response, 409, {
          code: "SESSION_CHANGED",
          error: "The active Session changed. Reopen the tool panel.",
        });
        return undefined;
      }
      return workspace;
    } catch {
      this.json(response, 403, {
        code: "WORKSPACE_UNAVAILABLE",
        error: "The active Session workspace is unavailable",
      });
      return undefined;
    }
  }

  private validTerminalQuery(
    url: URL,
    required: readonly string[],
    optional: readonly string[] = [],
  ) {
    const allowed = new Set([...required, ...optional]);
    const keys = [...url.searchParams.keys()];
    return (
      required.every(
        (key) => url.searchParams.getAll(key).length === 1,
      ) &&
      optional.every(
        (key) => url.searchParams.getAll(key).length <= 1,
      ) &&
      keys.every((key) => allowed.has(key))
    );
  }

  private async interactiveTerminalEvents(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ) {
    const sessionId = url.searchParams.get("sessionId");
    const id = url.searchParams.get("id");
    const afterValue = url.searchParams.get("after");
    const after = this.parseCursor(afterValue);
    if (
      !this.validTerminalQuery(url, ["sessionId", "id"], ["after"]) ||
      !sessionId ||
      !id ||
      id.length > 128 ||
      /[\u0000-\u001f\u007f]/u.test(id) ||
      after.invalid ||
      (url.searchParams.has("after") && afterValue === "")
    ) {
      return this.json(response, 400, {
        code: "INVALID_TERMINAL_STREAM",
        error: "an exact terminal, Session, and optional output cursor are required",
      });
    }
    if (!(await this.requireActiveToolSession(sessionId, response))) return;
    if (this.terminalStreams.size >= MAX_TERMINAL_STREAMS) {
      return this.json(response, 503, {
        code: "TERMINAL_STREAM_LIMIT",
        error: "too many interactive terminal streams",
      });
    }

    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let closed = false;
    let ready = false;
    const pendingEvents: WebInteractiveTerminalEvent[] = [];
    let subscription: ReturnType<
      InteractiveTerminalService["subscribe"]
    >;
    const cleanup = (close?: "end" | "destroy") => {
      if (closed) return;
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      subscription?.unsubscribe();
      this.terminalStreams.delete(response);
      request.off("aborted", abort);
      response.off("close", onClose);
      if (close === "end" && !response.writableEnded) response.end();
      else if (close === "destroy" && !response.destroyed) response.destroy();
    };
    const abort = () => cleanup("destroy");
    const onClose = () => cleanup();
    const send = (event: WebInteractiveTerminalEvent) => {
      if (!ready) {
        pendingEvents.push(event);
        return;
      }
      if (closed || response.destroyed || response.writableEnded) return;
      if (response.writableLength > MAX_SSE_BUFFER_BYTES) {
        cleanup("destroy");
        return;
      }
      const eventId = event.type === "output" ? `id: ${event.offset}\n` : "";
      response.write(`${eventId}data: ${JSON.stringify(event)}\n\n`);
      if (event.type === "exit" || event.type === "closed") cleanup("end");
    };
    subscription = this.interactiveTerminals.subscribe(
      sessionId,
      id,
      send,
      after.value,
    );
    if (!subscription) {
      return this.json(response, 404, {
        code: "TERMINAL_NOT_FOUND",
        error: "the interactive terminal expired or closed",
      });
    }
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    this.terminalStreams.add(response);
    request.once("aborted", abort);
    response.once("close", onClose);
    ready = true;
    response.write(": connected\n\n");
    send(subscription.output);
    for (const event of pendingEvents.splice(0)) send(event);
    if (subscription.exited && !closed) {
      send({ type: "exit", exitCode: subscription.exitCode ?? 0 });
    }
    if (closed) return;
    heartbeat = setInterval(() => {
      if (
        response.destroyed ||
        response.writableEnded ||
        response.writableLength > MAX_SSE_BUFFER_BYTES
      ) {
        cleanup("destroy");
      } else response.write(": heartbeat\n\n");
    }, this.sseHeartbeatMs);
    heartbeat.unref();
  }

  private authorized(request: IncomingMessage) {
    const value = request.headers.authorization?.replace(/^Bearer\s+/i, "");
    if (!value || !/^[0-9a-f]{64}$/i.test(value)) return false;
    const candidate = Buffer.from(value, "hex");
    return (
      candidate.length === this.token.length &&
      timingSafeEqual(candidate, this.token)
    );
  }

  private eventsStream(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? "/events", `http://${HOST}`);
    const queryCursor = this.parseCursor(url.searchParams.get("cursor"));
    const headerValue = request.headers["last-event-id"];
    const headerCursor = this.parseCursor(
      Array.isArray(headerValue) ? headerValue[0] : headerValue,
    );
    if (queryCursor.invalid || headerCursor.invalid) {
      return this.json(response, 400, {
        code: "INVALID_CURSOR",
        error: "cursor must be a non-negative integer",
      });
    }
    if (
      queryCursor.value !== undefined &&
      headerCursor.value !== undefined &&
      queryCursor.value !== headerCursor.value
    ) {
      return this.json(response, 400, {
        code: "CURSOR_MISMATCH",
        error: "cursor and Last-Event-ID must match",
      });
    }
    const cursor = queryCursor.value ?? headerCursor.value;
    const oldestCursor = this.events[0]?.sequence
      ? this.events[0].sequence - 1
      : this.sequence;
    if (
      cursor === undefined ||
      cursor < oldestCursor ||
      cursor > this.sequence
    ) {
      return this.json(response, 409, {
        code: "RESYNC_REQUIRED",
        error: "event history is not available for this cursor",
        cursor: this.sequence,
        oldestCursor,
      });
    }
    if (this.clients.size >= MAX_SSE_CLIENTS) {
      return this.json(response, 503, {
        code: "SSE_CLIENT_LIMIT",
        error: "too many event clients",
      });
    }
    const replay = this.events
      .filter((event) => event.sequence > cursor)
      .map(
        (event) =>
          `id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`,
      );
    const replayBytes = replay.reduce(
      (bytes, record) => bytes + Buffer.byteLength(record),
      Buffer.byteLength(": connected\n\n"),
    );
    if (replayBytes > MAX_SSE_REPLAY_BYTES) {
      return this.json(response, 409, {
        code: "RESYNC_REQUIRED",
        error: "event replay exceeds the bounded transport budget",
        cursor: this.sequence,
        oldestCursor,
      });
    }
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    response.write(": connected\n\n");
    // The complete replay is bounded before headers. A false return only means
    // Node buffered the write; finishing this synchronous replay preserves
    // ordering without treating normal backpressure as a broken client.
    for (const record of replay) response.write(record);
    this.clients.add(response);
    const heartbeat = setInterval(() => {
      this.writeSseRecord(response, ": heartbeat\n\n");
    }, this.sseHeartbeatMs);
    heartbeat.unref();
    this.clientHeartbeats.set(response, heartbeat);
    response.on("close", () => this.removeSseClient(response));
  }

  private writeSseRecord(response: ServerResponse, record: string) {
    if (
      response.destroyed ||
      response.writableEnded ||
      response.writableLength + Buffer.byteLength(record) > MAX_SSE_BUFFER_BYTES
    ) {
      this.removeSseClient(response, "destroy");
      return;
    }
    // false means Node buffered this write, not that the connection failed.
    // Keep native ordering while bounding each client's outstanding bytes.
    response.write(record);
  }

  private removeSseClient(
    response: ServerResponse,
    close?: "destroy" | "end",
  ) {
    this.clients.delete(response);
    const heartbeat = this.clientHeartbeats.get(response);
    if (heartbeat) clearInterval(heartbeat);
    this.clientHeartbeats.delete(response);
    if (close === "destroy" && !response.destroyed) response.destroy();
    else if (close === "end" && !response.writableEnded) response.end();
  }

  private parseCursor(value: string | undefined | null) {
    if (value === undefined || value === null || value === "") {
      return { invalid: false, value: undefined };
    }
    if (!/^\d+$/.test(value)) return { invalid: true, value: undefined };
    const parsed = Number(value);
    return Number.isSafeInteger(parsed)
      ? { invalid: false, value: parsed }
      : { invalid: true, value: undefined };
  }

  private runtimeRequestFailure(
    error: unknown,
    fallbackCode = "PROMPT_ADMISSION_FAILED",
    fallbackMessage = "prompt admission failed",
  ) {
    if (error instanceof WebRuntimeRequestError) {
      return {
        status: error.statusCode,
        code: error.code,
        error: error.message,
      };
    }
    return {
      status: 500,
      code: fallbackCode,
      error: error instanceof Error ? error.message : fallbackMessage,
    };
  }

  private json(response: ServerResponse, status: number, value: unknown) {
    let body = JSON.stringify(value);
    if (Buffer.byteLength(body) > WEB_MAX_SNAPSHOT_BYTES) {
      status = 500;
      body = JSON.stringify({
        code: "RESPONSE_TOO_LARGE",
        error: "response exceeded the Web protocol byte limit",
        maxBytes: WEB_MAX_SNAPSHOT_BYTES,
      });
    }
    response.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Length": Buffer.byteLength(body),
    });
    response.end(body);
  }
}
