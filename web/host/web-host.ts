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
  WEB_MAX_EVENTS,
  WEB_PROTOCOL_VERSION,
  type WebEvent,
  type WebSnapshot,
} from "../protocol/types.ts";
import type { WebRuntimeController } from "../runtime/types.ts";
import { elapsed, traceWeb } from "../trace.ts";

const HOST = "127.0.0.1";
const UI_ROOT = new URL("../ui/", import.meta.url);
const MAX_COMMAND_BYTES = 16 * 1024;
const execFileAsync = promisify(execFile);

export interface WebHostOptions {
  runtime: WebRuntimeController;
  onEvent?: (type: string, detail?: Record<string, unknown>) => void;
  port?: number;
  token?: string;
  allowedOrigins?: readonly string[];
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
  private readonly unsubscribeCapabilities: () => void;
  private readonly unsubscribeRuntime: () => void;
  private stopped = false;

  constructor(options: WebHostOptions) {
    this.runtime = options.runtime;
    this.requestedPort = options.port ?? 0;
    this.token = options.token
      ? Buffer.from(options.token, "hex")
      : randomBytes(32);
    if (this.token.length !== 32)
      throw new Error("Web host token must be 64 hexadecimal characters");
    this.allowedOrigins = new Set(options.allowedOrigins ?? []);
    this.adapter = new PiWebAdapter(options.runtime);
    this.onEvent = options.onEvent;
    this.unsubscribeCapabilities = subscribeWebCapabilities(() =>
      this.publish("runtime_changed"),
    );
    this.unsubscribeRuntime = this.runtime.subscribe(({ type, detail }) =>
      this.publish(type, detail),
    );
    this.server = createServer((request, response) => {
      void this.handle(request, response).catch((error: unknown) => {
        this.json(response, 500, {
          error: error instanceof Error ? error.message : "request failed",
        });
      });
    });
  }

  async start() {
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
      cwd: this.runtime.cwd,
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
    const event: WebEvent = {
      protocolVersion: WEB_PROTOCOL_VERSION,
      sequence: ++this.sequence,
      type,
      timestamp: new Date().toISOString(),
      ...(detail ? { detail } : {}),
    };
    this.events.push(event);
    if (this.events.length > WEB_MAX_EVENTS) this.events.shift();
    for (const client of this.clients)
      client.write(`data: ${JSON.stringify(event)}\n\n`);
    this.onEvent?.(type, detail);
    traceWeb("sse_event", {
      type,
      sequence: event.sequence,
      detailKeys: detail ? Object.keys(detail) : [],
    });
  }

  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.unsubscribeCapabilities();
    this.unsubscribeRuntime();
    for (const client of this.clients) client.end();
    this.clients.clear();
    if (this.server.listening) {
      await new Promise<void>((resolve) => this.server.close(() => resolve()));
    }
    await this.runtime.dispose();
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
      });
      response.end(body);
      return;
    }
    if (
      url.pathname === "/styles.css" ||
      url.pathname === "/app.js" ||
      url.pathname === "/marked.js"
    ) {
      if (request.method !== "GET")
        return this.json(response, 405, {
          error: "static assets accept GET only",
        });
      const file = url.pathname.slice(1);
      const body = await readFile(
        file === "marked.js"
          ? new URL("../../node_modules/marked/lib/marked.umd.js", import.meta.url)
          : new URL(file, UI_ROOT),
      );
      response.writeHead(200, {
        "Content-Type": file.endsWith(".css")
          ? "text/css; charset=utf-8"
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
      const path = await this.chooseDirectory();
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
      if (typeof body.workspacePath !== "string") {
        return this.json(response, 400, {
          error: "workspace path is required",
        });
      }
      const workspacePath = await this.adapter.requireWorkspace(
        body.workspacePath,
      );
      const result = await this.runtime.newSession(workspacePath);
      this.publish("session_created", { workspacePath });
      return this.json(response, 201, result);
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
      if (typeof body.provider !== "string" || typeof body.modelId !== "string") {
        return this.json(response, 400, { error: "provider and modelId are required" });
      }
      const model = await this.runtime.setModel(body.provider, body.modelId);
      this.publish("model_selected", { provider: model.provider, modelId: model.id });
      return this.json(response, 200, model);
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
      if (body.sessionId !== this.runtime.sessionManager.getSessionId()) {
        return this.json(response, 409, {
          error: "Only the active Web session accepts messages",
        });
      }
      const commandId = randomUUID();
      traceWeb("prompt_received", {
        commandId,
        sessionId: body.sessionId,
        chars: content.length,
      });
      this.publish("prompt_accepted", { commandId, sessionId: body.sessionId });
      void this.runtime
        .sendPrompt(content, {
          commandId,
          sessionId: String(body.sessionId),
        })
        .then(() => {
          traceWeb("prompt_admission_finished", {
            commandId,
            elapsedMs: elapsed(requestStarted),
          });
        })
        .catch((error: unknown) => {
          traceWeb("prompt_dispatch_failed", {
            commandId,
            elapsedMs: elapsed(requestStarted),
            error: error instanceof Error ? error.message : String(error),
          });
        this.publish("prompt_failed", {
          commandId,
          sessionId: body.sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
        });
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
    if (url.pathname === "/api/sessions")
      return this.json(response, 200, {
        sessions: await this.adapter.listSessions(),
      });
    if (url.pathname === "/api/models")
      return this.json(response, 200, { models: this.runtime.listModels() });
    if (url.pathname === "/api/snapshot") {
      const projection = await this.adapter.getSnapshot(
        url.searchParams.get("path") ?? undefined,
      );
      const snapshot: WebSnapshot = {
        protocolVersion: WEB_PROTOCOL_VERSION,
        generatedAt: new Date().toISOString(),
        cursor: this.sequence,
        ...projection,
      };
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
        const { stdout } = await execFileAsync("osascript", [
          "-e",
          'tell application "System Events" to activate',
          "-e",
          'POSIX path of (choose folder with prompt "Choose a workspace")',
        ]);
        return stdout.trim() || undefined;
      }
      if (process.platform === "win32") {
        const { stdout } = await execFileAsync("powershell.exe", [
          "-NoProfile",
          "-Command",
          "$dialog = New-Object -ComObject Shell.Application; $folder = $dialog.BrowseForFolder(0, 'Choose a workspace', 0); if ($folder) { $folder.Self.Path }",
        ]);
        return stdout.trim() || undefined;
      }
      const { stdout } = await execFileAsync("zenity", [
        "--file-selection",
        "--directory",
        "--title=Choose a workspace",
      ]);
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
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    response.write(": connected\n\n");
    for (const event of this.events)
      response.write(`data: ${JSON.stringify(event)}\n\n`);
    this.clients.add(response);
    request.on("close", () => this.clients.delete(response));
  }

  private json(response: ServerResponse, status: number, value: unknown) {
    const body = JSON.stringify(value);
    response.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Length": Buffer.byteLength(body),
    });
    response.end(body);
  }
}
