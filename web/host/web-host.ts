import { execFile } from "node:child_process";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { URL } from "node:url";
import { promisify } from "node:util";
import { subscribeWebCapabilities } from "../../extensions/shared/web-observer-registry.ts";
import { PiWebAdapter } from "../adapter/pi-adapter.ts";
import {
  jsonByteLength,
  WEB_MAX_EVENT_BYTES,
  WEB_MAX_EVENTS,
  WEB_MAX_SNAPSHOT_BYTES,
  WEB_PROTOCOL_VERSION,
  type WebEvent,
  type WebSnapshot,
} from "../protocol/types.ts";
import {
  WebRuntimeRequestError,
  type WebRuntimeController,
} from "../runtime/types.ts";
import { elapsed, traceWeb } from "../trace.ts";

const HOST = "127.0.0.1";
const UI_ROOT = new URL("../dist/", import.meta.url);
const MAX_COMMAND_BYTES = 16 * 1024;
const MAX_SSE_CLIENTS = 8;
const MAX_SSE_BUFFER_BYTES = 256 * 1024;
const MAX_SSE_REPLAY_BYTES = MAX_SSE_BUFFER_BYTES;
const SERVER_CLOSE_DRAIN_MS = 500;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;
const execFileAsync = promisify(execFile);

export interface WebHostOptions {
  runtime: WebRuntimeController;
  onEvent?: (type: string, detail?: Record<string, unknown>) => void;
  port?: number;
  token?: string;
  allowedOrigins?: readonly string[];
  directoryChooser?: (signal: AbortSignal) => Promise<string | undefined>;
  shutdownTimeoutMs?: number;
}

export class WebHost {
  private readonly server: Server;
  private readonly token: Buffer;
  private readonly adapter: PiWebAdapter;
  private readonly clients = new Set<ServerResponse>();
  private readonly events: WebEvent[] = [];
  private sequence = 0;
  private port = 0;
  private readonly runtime: WebRuntimeController;
  private readonly requestedPort: number;
  private readonly onEvent?: WebHostOptions["onEvent"];
  private readonly allowedOrigins: ReadonlySet<string>;
  private readonly directoryChooser: NonNullable<
    WebHostOptions["directoryChooser"]
  >;
  private readonly shutdownTimeoutMs: number;
  private readonly unsubscribeCapabilities: () => void;
  private readonly unsubscribeRuntime: () => void;
  private readonly chooserAbort = new AbortController();
  private readonly leaseSensitiveRequests = new Set<Promise<void>>();
  private readonly leaseSensitiveMessages = new Set<IncomingMessage>();
  private stopping = false;
  private stopPromise?: Promise<void>;

  constructor(options: WebHostOptions) {
    this.runtime = options.runtime;
    this.requestedPort = options.port ?? 0;
    this.token = options.token
      ? Buffer.from(options.token, "hex")
      : randomBytes(32);
    if (this.token.length !== 32)
      throw new Error("Web host token must be 64 hexadecimal characters");
    this.allowedOrigins = new Set(options.allowedOrigins ?? []);
    this.directoryChooser =
      options.directoryChooser ?? (() => this.chooseDirectory());
    this.shutdownTimeoutMs =
      options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(this.shutdownTimeoutMs) ||
      this.shutdownTimeoutMs <= 0
    ) {
      throw new Error("Web host shutdown timeout must be a positive integer");
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
      if (
        client.destroyed ||
        client.writableEnded ||
        client.writableLength > MAX_SSE_BUFFER_BYTES ||
        !client.write(record)
      ) {
        this.clients.delete(client);
        client.destroy();
      }
    }
    this.onEvent?.(event.type, event.detail);
    traceWeb("sse_event", {
      type: event.type,
      sequence: event.sequence,
      detailKeys: event.detail ? Object.keys(event.detail) : [],
    });
  }

  stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    this.stopPromise = (async () => {
      this.unsubscribeCapabilities();
      this.unsubscribeRuntime();
      this.chooserAbort.abort();
      for (const client of this.clients) client.end();
      this.clients.clear();
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
        await this.runtime.dispose();
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
      this.json(response, 500, {
        error: error instanceof Error ? error.message : "request failed",
      });
    }
  }

  private isLeaseSensitiveMutation(request: IncomingMessage) {
    if (request.method === "GET" || request.method === "HEAD") return false;
    const pathname = new URL(request.url ?? "/", `http://${HOST}`).pathname;
    if (pathname === "/api/prompt") return false;
    return pathname.startsWith("/api/workspaces") ||
      pathname.startsWith("/api/sessions") ||
      pathname === "/api/model";
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
      const body = await readFile(new URL("index.html", UI_ROOT));
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy":
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
        "Referrer-Policy": "no-referrer",
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
      this.publish("session_created", {
        workspacePath,
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
    if (url.pathname === "/api/sessions/select" && request.method === "POST") {
      const body = await this.readJson(request);
      if (typeof body.path !== "string" || body.path.trim().length === 0) {
        return this.json(response, 400, { error: "session path is required" });
      }
      const session = await this.adapter.requireSession(body.path);
      const result =
        session.id === this.runtime.sessionManager.getSessionId()
          ? { cancelled: false }
          : await this.runtime.switchSession(session.path);
      this.publish("session_selected", { sessionPath: session.path });
      return this.json(response, 200, result);
    }
    if (url.pathname === "/api/model" && request.method === "POST") {
      const body = await this.readJson(request);
      if (
        typeof body.provider !== "string" ||
        typeof body.modelId !== "string" ||
        typeof body.sessionId !== "string"
      ) {
        return this.json(response, 400, {
          error: "provider, modelId, and sessionId are required",
        });
      }
      if (this.runtime.workspaceSelected !== true) {
        return this.json(response, 409, {
          code: "WORKSPACE_REQUIRED",
          error: "Choose a workspace before using the Web runtime",
        });
      }
      try {
        const model = await this.runtime.setModel(body.provider, body.modelId, {
          expectedSessionId: body.sessionId,
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
      const body = await this.readJson(request);
      const content =
        typeof body.content === "string" ? body.content.trim() : "";
      if (!content || content.length > 12_000) {
        return this.json(response, 400, {
          error: "prompt must be 1-12000 characters",
        });
      }
      if (this.runtime.workspaceSelected !== true) {
        return this.json(response, 409, {
          code: "WORKSPACE_REQUIRED",
          error: "Choose a workspace before using the Web runtime",
        });
      }
      if (
        typeof body.sessionId !== "string" ||
        body.sessionId !== this.runtime.sessionManager.getSessionId()
      ) {
        return this.json(response, 409, {
          code: "SESSION_CONFLICT",
          error: "Only the active Web session accepts messages",
        });
      }
      const commandId = randomUUID();
      traceWeb("prompt_received", {
        commandId,
        sessionId: body.sessionId,
        chars: content.length,
      });
      try {
        await this.runtime.sendPrompt(content, {
          commandId,
          expectedSessionId: body.sessionId,
        });
        traceWeb("prompt_admission_finished", {
          commandId,
          elapsedMs: elapsed(requestStarted),
        });
      } catch (error) {
        const failure = this.runtimeRequestFailure(error);
        traceWeb("prompt_admission_failed", {
          commandId,
          elapsedMs: elapsed(requestStarted),
          error: failure.error,
        });
        return this.json(response, failure.status, {
          code: failure.code,
          error: failure.error,
        });
      }
      this.publish("prompt_accepted", { commandId, sessionId: body.sessionId });
      traceWeb("prompt_response_sent", {
        commandId,
        sessionId: body.sessionId,
        elapsedMs: elapsed(requestStarted),
      });
      return this.json(response, 202, {
        id: commandId,
        accepted: true,
        state: "accepted",
        cursor: this.sequence,
      });
    }
    if (request.method !== "GET") {
      return this.json(response, 405, { error: "method not allowed" });
    }
    if (url.pathname === "/events") return this.eventsStream(request, response);
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
    if (url.pathname === "/api/models")
      return this.json(response, 200, { models: this.runtime.listModels() });
    if (url.pathname === "/api/snapshot") {
      const cursor = this.sequence;
      const projection = await this.adapter.getSnapshot(
        url.searchParams.get("path") ?? undefined,
      );
      const snapshot: WebSnapshot = {
        protocolVersion: WEB_PROTOCOL_VERSION,
        generatedAt: new Date().toISOString(),
        cursor,
        ...projection,
      };
      let finalBytes = jsonByteLength(snapshot);
      while (snapshot.truncation.bytes !== finalBytes) {
        snapshot.truncation.bytes = finalBytes;
        finalBytes = jsonByteLength(snapshot);
      }
      return this.json(response, 200, snapshot);
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

  private async readJson(request: IncomingMessage) {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > MAX_COMMAND_BYTES)
        throw new Error("request body is too large");
      chunks.push(buffer);
    }
    try {
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("request body must be an object");
      }
      return value as Record<string, unknown>;
    } catch (error) {
      throw new Error(
        error instanceof SyntaxError
          ? "request body is invalid JSON"
          : String(error),
      );
    }
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
    response.on("close", () => this.clients.delete(response));
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
