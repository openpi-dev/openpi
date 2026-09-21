import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  WebEmbeddedBrowserAction,
  WebEmbeddedBrowserState,
  WebBrowserFrame,
} from "../protocol/types.ts";

const START_TIMEOUT_MS = 8_000;
const DEFAULT_WIDTH = 1_024;
const DEFAULT_HEIGHT = 768;

export interface EmbeddedBrowserService {
  open(
    sessionId: string,
    url: string,
    viewport?: { width: number; height: number; deviceScaleFactor?: number },
  ): Promise<WebEmbeddedBrowserState>;
  state(sessionId: string): Promise<WebEmbeddedBrowserState | undefined>;
  frame(sessionId: string): Promise<Buffer | undefined>;
  subscribeFrames?(sessionId: string, listener: (frame: WebBrowserFrame | null) => void): Promise<(() => void) | undefined>;
  action(
    sessionId: string,
    action: WebEmbeddedBrowserAction,
  ): Promise<WebEmbeddedBrowserState | undefined>;
  retain(sessionId?: string): void;
  dispose(): Promise<void>;
}

interface CdpMessage {
  id?: number;
  result?: Record<string, unknown>;
  error?: { message?: string };
  method?: string;
  params?: Record<string, unknown>;
}

class CdpConnection {
  private readonly socket: WebSocket;
  private readonly opened: Promise<void>;
  private nextId = 0;
  private readonly pending = new Map<
    number,
    { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }
  >();
  private readonly listeners = new Map<
    string,
    Set<(params: Record<string, unknown>) => void>
  >();

  constructor(url: string) {
    this.socket = new WebSocket(url);
    this.opened = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error("Embedded browser connection timed out")); this.socket.close(); }, 5_000);
      this.socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      this.socket.addEventListener(
        "error",
        () => { clearTimeout(timer); reject(new Error("Embedded browser connection failed")); },
        { once: true },
      );
      this.socket.addEventListener(
        "close",
        () => { clearTimeout(timer); reject(new Error("Embedded browser connection closed")); },
        { once: true },
      );
    });
    this.socket.addEventListener("message", (event) => {
      let message: CdpMessage;
      try {
        message = JSON.parse(String(event.data)) as CdpMessage;
      } catch {
        return;
      }
      if (message.id === undefined) {
        if (!message.method) return;
        for (const listener of this.listeners.get(message.method) ?? [])
          listener(message.params ?? {});
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error)
        pending.reject(
          new Error(message.error.message ?? "Embedded browser command failed"),
        );
      else pending.resolve(message.result ?? {});
    });
    this.socket.addEventListener("close", () => {
      for (const pending of this.pending.values())
        pending.reject(new Error("Embedded browser connection closed"));
      this.pending.clear();
    });
  }

  async send(method: string, params: Record<string, unknown> = {}) {
    await this.opened;
    const id = ++this.nextId;
    const response = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Embedded browser command timed out: ${method}`));
      }, 5_000);
      this.pending.set(id, {
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); },
      });
    });
    try { this.socket.send(JSON.stringify({ id, method, params })); }
    catch (error) { this.pending.get(id)?.reject(error instanceof Error ? error : new Error(String(error))); this.pending.delete(id); }
    return response;
  }

  close() {
    this.socket.close();
  }

  on(method: string, listener: (params: Record<string, unknown>) => void) {
    const listeners = this.listeners.get(method) ?? new Set();
    listeners.add(listener);
    this.listeners.set(method, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(method);
    };
  }
}

interface BrowserSession {
  sessionId: string;
  process: ChildProcess;
  profile: string;
  cdp: CdpConnection;
  width: number;
  height: number;
  deviceScaleFactor: number;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  latestFrame?: WebBrowserFrame;
  frameListeners: Set<(frame: WebBrowserFrame | null) => void>;
  stopListening: () => void;
}

function isWebAddress(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

async function executableCandidates() {
  const configured = process.env.OPENPI_CHROME_PATH;
  if (process.platform === "darwin")
    return [
      configured,
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ].filter((value): value is string => Boolean(value));
  if (process.platform === "win32")
    return [
      configured,
      process.env.PROGRAMFILES
        ? join(process.env.PROGRAMFILES, "Google/Chrome/Application/chrome.exe")
        : undefined,
      process.env["PROGRAMFILES(X86)"]
        ? join(
            process.env["PROGRAMFILES(X86)"],
            "Google/Chrome/Application/chrome.exe",
          )
        : undefined,
    ].filter((value): value is string => Boolean(value));
  return [
    configured,
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/microsoft-edge",
  ].filter((value): value is string => Boolean(value));
}

async function findBrowserExecutable() {
  for (const candidate of await executableCandidates()) {
    try {
      await access(candidate);
      return candidate;
    } catch {}
  }
  throw new Error(
    "No Chromium browser was found. Set OPENPI_CHROME_PATH to Chrome, Chromium, or Edge.",
  );
}

async function waitForDebugPort(profile: string, processHandle: ChildProcess) {
  const started = Date.now();
  const target = join(profile, "DevToolsActivePort");
  while (Date.now() - started < START_TIMEOUT_MS) {
    if (processHandle.exitCode !== null)
      throw new Error("Embedded browser exited during startup");
    try {
      const [port] = (await readFile(target, "utf8")).trim().split("\n");
      const value = Number(port);
      if (Number.isSafeInteger(value) && value > 0) return value;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error("Embedded browser startup timed out");
}

function boundedViewport(value: number, fallback: number, minimum = 320) {
  return Number.isSafeInteger(value) && value >= minimum && value <= 2_560
    ? value
    : fallback;
}

function virtualKeyCode(key: string) {
  if (key.length === 1) return key.toUpperCase().charCodeAt(0);
  return {
    Backspace: 8,
    Tab: 9,
    Enter: 13,
    Escape: 27,
    ArrowLeft: 37,
    ArrowUp: 38,
    ArrowRight: 39,
    ArrowDown: 40,
    Delete: 46,
  }[key];
}

export class EmbeddedBrowserManager implements EmbeddedBrowserService {
  private session?: BrowserSession;
  private lifecycle = Promise.resolve();

  async open(
    sessionId: string,
    url: string,
    viewport: { width: number; height: number; deviceScaleFactor?: number } = { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT },
  ) {
    return this.serialize(async () => {
      const width = boundedViewport(viewport.width, DEFAULT_WIDTH);
      const height = boundedViewport(viewport.height, DEFAULT_HEIGHT, 240);
      if (!this.session || this.session.sessionId !== sessionId || this.session.process.exitCode !== null || this.session.process.signalCode !== null) {
        await this.disposeCurrent();
        this.session = await this.start(sessionId, width, height);
      }
      await this.resize(this.session, width, height, viewport.deviceScaleFactor);
      this.session.url = url;
      this.session.loading = true;
      await this.session.cdp.send("Page.navigate", { url });
      return this.readState(this.session);
    });
  }

  async state(sessionId: string) {
    const session = this.forSession(sessionId);
    return session ? this.readState(session) : undefined;
  }

  async frame(sessionId: string) {
    const session = this.forSession(sessionId);
    if (!session) return undefined;
    const result = await session.cdp.send("Page.captureScreenshot", {
      format: "jpeg",
      quality: 95,
      fromSurface: true,
      captureBeyondViewport: false,
    });
    return typeof result.data === "string"
      ? Buffer.from(result.data, "base64")
      : undefined;
  }

  async subscribeFrames(sessionId: string, listener: (frame: WebBrowserFrame | null) => void) {
    return this.serialize(async () => {
      const session = this.forSession(sessionId);
      if (!session) return;
      const first = session.frameListeners.size === 0;
      session.frameListeners.add(listener);
      if (first) session.latestFrame = undefined;
      try { if (first) await this.startFrames(session); }
      catch (error) { session.frameListeners.delete(listener); throw error; }
      if (session.latestFrame) listener(session.latestFrame);
      return () => {
        session.frameListeners.delete(listener);
        if (session.frameListeners.size === 0)
          void this.serialize(async () => {
            if (this.session === session && session.frameListeners.size === 0)
              await session.cdp.send("Page.stopScreencast");
          }).catch(() => undefined);
      };
    });
  }

  async action(sessionId: string, action: WebEmbeddedBrowserAction) {
    return this.serialize(async () => {
      const session = this.forSession(sessionId);
      if (!session) return undefined;
      if (action.type === "navigate") {
        session.url = action.url;
        session.loading = true;
        await session.cdp.send("Page.navigate", { url: action.url });
      } else if (action.type === "reload") {
        session.loading = true;
        await session.cdp.send("Page.reload", { ignoreCache: false });
      } else if (action.type === "stop") {
        await session.cdp.send("Page.stopLoading");
        session.loading = false;
      } else if (action.type === "back" || action.type === "forward") {
        const history = await session.cdp.send("Page.getNavigationHistory");
        const index = Number(history.currentIndex);
        const entries = Array.isArray(history.entries) ? history.entries : [];
        const target = entries[index + (action.type === "back" ? -1 : 1)] as
          | Record<string, unknown>
          | undefined;
        if (target && typeof target.id === "number") {
          session.loading = true;
          await session.cdp.send("Page.navigateToHistoryEntry", {
            entryId: target.id,
          });
        }
      } else if (action.type === "resize") {
        await this.resize(session, action.width, action.height, action.deviceScaleFactor);
      } else if (action.type === "mouse") {
        const mouseType = {
          move: "mouseMoved",
          down: "mousePressed",
          up: "mouseReleased",
          wheel: "mouseWheel",
        }[action.event];
        await session.cdp.send("Input.dispatchMouseEvent", {
          type: mouseType,
          x: action.x,
          y: action.y,
          button: action.button ?? "none",
          ...(action.event === "down" ? { clickCount: 1 } : {}),
          ...(action.event === "up" ? { clickCount: 1 } : {}),
          ...(action.event === "wheel"
            ? { deltaX: action.deltaX ?? 0, deltaY: action.deltaY ?? 0 }
            : {}),
        });
      } else if (action.type === "text") {
        await session.cdp.send("Input.insertText", { text: action.text });
      } else if (action.type === "key") {
        const keyCode = virtualKeyCode(action.key);
        await session.cdp.send("Input.dispatchKeyEvent", {
          type: action.event === "down" ? "keyDown" : "keyUp",
          key: action.key,
          code: action.code ?? "",
          modifiers: action.modifiers ?? 0,
          ...(keyCode ? { windowsVirtualKeyCode: keyCode } : {}),
          ...(action.event === "down" && action.text
            ? { text: action.text }
            : {}),
        });
      }
      // Input dispatch must not wait for three unrelated page-state queries.
      return action.type === "mouse" || action.type === "key" || action.type === "text"
        ? this.snapshot(session)
        : this.readState(session);
    });
  }

  retain(sessionId?: string) {
    void this.serialize(async () => {
      if (this.session && this.session.sessionId !== sessionId)
        await this.disposeCurrent();
    }).catch(() => undefined);
  }

  dispose() {
    return this.serialize(() => this.disposeCurrent());
  }

  private serialize<T>(operation: () => Promise<T>) {
    const result = this.lifecycle.then(operation, operation);
    this.lifecycle = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async disposeCurrent() {
    const session = this.session;
    this.session = undefined;
    if (!session) return;
    for (const listener of session.frameListeners) listener(null);
    session.frameListeners.clear();
    session.stopListening();
    session.cdp.close();
    if (session.process.exitCode === null) session.process.kill("SIGKILL");
    await rm(session.profile, { recursive: true, force: true });
  }

  private forSession(sessionId: string) {
    return this.session?.sessionId === sessionId ? this.session : undefined;
  }

  private async start(sessionId: string, width: number, height: number) {
    const executable = await findBrowserExecutable();
    const profile = await mkdtemp(join(tmpdir(), "openpi-browser-"));
    const args = [
      "--headless=new",
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      `--window-size=${width},${height}`,
      "--force-device-scale-factor=2",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-default-apps",
      "--disable-dev-shm-usage",
      "--disable-features=Translate",
      "--disable-notifications",
      "--deny-permission-prompts",
      "--no-first-run",
      "--no-default-browser-check",
      ...(typeof process.getuid === "function" && process.getuid() === 0
        ? ["--no-sandbox"]
        : []),
      "about:blank",
    ];
    const processHandle = spawn(executable, args, {
      stdio: "ignore",
      windowsHide: true,
    });
    try {
      const port = await waitForDebugPort(profile, processHandle);
      const targets = (await fetch(`http://127.0.0.1:${port}/json/list`).then(
        (response) => response.json(),
      )) as Array<Record<string, unknown>>;
      const target = targets.find(
        (item) => item.type === "page" && typeof item.webSocketDebuggerUrl === "string",
      );
      if (!target || typeof target.webSocketDebuggerUrl !== "string")
        throw new Error("Embedded browser did not expose a page target");
      const cdp = new CdpConnection(target.webSocketDebuggerUrl);
      await cdp.send("Page.enable");
      await cdp.send("Runtime.enable");
      await cdp.send("Browser.setDownloadBehavior", { behavior: "deny" });
      await cdp.send("Page.setInterceptFileChooserDialog", { enabled: true });
      const session: BrowserSession = {
        sessionId,
        process: processHandle,
        profile,
        cdp,
        width,
        height,
        deviceScaleFactor: 1,
        frameListeners: new Set(),
        url: "about:blank",
        title: "",
        loading: false,
        canGoBack: false,
        canGoForward: false,
        stopListening: () => undefined,
      };
      const stops = [
        cdp.on("Page.frameStartedLoading", () => {
          session.loading = true;
        }),
        cdp.on("Page.frameStoppedLoading", () => {
          session.loading = false;
        }),
        cdp.on("Page.loadEventFired", () => {
          session.loading = false;
        }),
        cdp.on("Page.screencastFrame", (params) => {
          if (typeof params.data === "string" && params.data.length <= 24 * 1024 * 1024) {
            const frame: WebBrowserFrame = { data: params.data, mimeType: "image/png", width: session.width, height: session.height };
            session.latestFrame = frame;
            for (const listener of session.frameListeners) listener(frame);
          }
          if (typeof params.sessionId === "number")
            void cdp
              .send("Page.screencastFrameAck", {
                sessionId: params.sessionId,
              })
              .catch(() => undefined);
        }),
        cdp.on("Page.frameNavigated", (params) => {
          const frame = params.frame;
          if (!frame || typeof frame !== "object" || "parentId" in frame)
            return;
          const url = (frame as { url?: unknown }).url;
          if (isWebAddress(url)) session.url = url;
          else if (url !== "about:blank")
            void cdp
              .send("Page.navigate", { url: session.url })
              .catch(() => undefined);
        }),
        cdp.on("Page.windowOpen", (params) => {
          if (isWebAddress(params.url))
            void cdp
              .send("Page.navigate", { url: params.url })
              .catch(() => undefined);
        }),
        cdp.on("Page.javascriptDialogOpening", () => {
          void cdp
            .send("Page.handleJavaScriptDialog", { accept: false })
            .catch(() => undefined);
        }),
        cdp.on("Page.fileChooserOpened", () => {
          void cdp
            .send("Page.handleFileChooser", { action: "cancel" })
            .catch(() => undefined);
        }),
      ];
      session.stopListening = () => {
        for (const stop of stops) stop();
      };
      await this.resize(session, width, height);
      return session;
    } catch (error) {
      if (processHandle.exitCode === null) processHandle.kill("SIGKILL");
      await rm(profile, { recursive: true, force: true });
      throw error;
    }
  }

  private async startFrames(session: BrowserSession) {
    const scale = Math.min(session.deviceScaleFactor, Math.sqrt(4_194_304 / (session.width * session.height)));
    await session.cdp.send("Page.startScreencast", {
      format: "png", everyNthFrame: 1,
      maxWidth: Math.floor(session.width * scale),
      maxHeight: Math.floor(session.height * scale),
    });
  }

  private async resize(session: BrowserSession, width: number, height: number, deviceScaleFactor = session.deviceScaleFactor) {
    session.width = boundedViewport(width, session.width);
    session.height = boundedViewport(height, session.height, 240);
    session.deviceScaleFactor = Math.max(1, Math.min(2, Number.isFinite(deviceScaleFactor) ? deviceScaleFactor : 1, Math.sqrt(4_194_304 / (session.width * session.height))));
    session.latestFrame = undefined;
    if (session.frameListeners.size) await session.cdp.send("Page.stopScreencast");
    await session.cdp.send("Emulation.setDeviceMetricsOverride", {
      width: session.width,
      height: session.height,
      deviceScaleFactor: session.deviceScaleFactor,
      mobile: false,
    });
    if (session.frameListeners.size) await this.startFrames(session);
  }

  private async readState(session: BrowserSession) {
    const [location, title, history] = await Promise.allSettled([
      session.cdp.send("Runtime.evaluate", {
        expression: "location.href",
        returnByValue: true,
      }),
      session.cdp.send("Runtime.evaluate", {
        expression: "document.title",
        returnByValue: true,
      }),
      session.cdp.send("Page.getNavigationHistory"),
    ]);
    const value = (result: PromiseSettledResult<Record<string, unknown>>) => {
      if (result.status === "rejected") return "";
      const remote = result.value.result;
      return remote && typeof remote === "object" && "value" in remote
        ? String((remote as { value?: unknown }).value ?? "")
        : "";
    };
    const nextUrl = value(location);
    if (isWebAddress(nextUrl)) session.url = nextUrl;
    const nextTitle = value(title);
    if (nextTitle) session.title = nextTitle;
    const historyValue = history.status === "fulfilled" ? history.value : {};
    const index = Number(historyValue.currentIndex);
    const entries = Array.isArray(historyValue.entries)
      ? historyValue.entries
      : [];
    session.canGoBack = index > 0;
    session.canGoForward = index >= 0 && index < entries.length - 1;
    return this.snapshot(session);
  }

  private snapshot(session: BrowserSession) {
    return {
      sessionId: session.sessionId,
      url: session.url,
      title: session.title,
      width: session.width,
      height: session.height,
      loading: session.loading,
      canGoBack: session.canGoBack,
      canGoForward: session.canGoForward,
      deviceScaleFactor: session.deviceScaleFactor,
    } satisfies WebEmbeddedBrowserState;
  }
}
