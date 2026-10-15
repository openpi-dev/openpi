import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { BROWSER_IDS, browserAllowed, isExternalBrowser, type BrowserId, type ExternalBrowser } from "../../extensions/shared/browser-config.ts";
import type { BrowserProfile } from "../protocol/browser.ts";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { BrowserRequest } from "../../extensions/browser/web-bridge.ts";
import { loadSetupConfig } from "../../extensions/shared/setup-config.ts";
import type { QuestionOwner } from "./questions.ts";

export interface EmbeddedBrowserPage {
  id: string;
  document: string;
  url: string;
  title: string;
}

interface BrowserNode {
  ref: string;
  role: string;
  name: string;
  value?: string;
}
interface BrowserObservation {
  nodes: BrowserNode[];
  text: string;
  truncated: boolean;
  image?: string;
}

export function validBrowserPages(
  input: unknown,
  limit = 8,
): input is EmbeddedBrowserPage[] {
  return (
    Array.isArray(input) &&
    input.length <= limit &&
    input.every((p: unknown) => {
      if (!p || typeof p !== "object") return false;
      const page = p as Partial<EmbeddedBrowserPage>;
      return (
        typeof page.id === "string" &&
        page.id.length > 0 &&
        page.id.length <= 150 &&
        typeof page.document === "string" &&
        // Chrome returns an opaque 128-bit document ID (32 hex characters),
        // while embedded bindings use a UUID nonce. Preserve either identity exactly.
        /^(?:[\da-f]{32}|[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})$/i.test(page.document) &&
        typeof page.title === "string" &&
        page.title.length <= 256 &&
        browserUrl(page.url)
      );
    }) &&
    new Set(input.map((page: EmbeddedBrowserPage) => page.id)).size ===
      input.length
  );
}

export function browserUrl(input: unknown) {
  if (typeof input !== "string" || input.length > 8192) return false;
  try {
    const url = new URL(input);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

function sameOwner(a: QuestionOwner, b: QuestionOwner | undefined) {
  return (
    b &&
    a.sessionId === b.sessionId &&
    a.workspace === b.workspace &&
    a.commandId === b.commandId &&
    a.epoch === b.epoch &&
    a.controllerId === b.controllerId
  );
}

export interface BrowserConnectionIdentity {
  browser: ExternalBrowser;
  profileId: string;
  extensionId: string;
  extensionOrigin?: string;
  version: string;
}

export function validBrowserIdentity(value: unknown): value is BrowserConnectionIdentity {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<BrowserConnectionIdentity>;
  return isExternalBrowser(v.browser) && typeof v.profileId === "string" && /^[\da-f-]{36}$/.test(v.profileId) &&
    typeof v.extensionId === "string" && (v.browser === "safari"
      ? /^[a-zA-Z0-9._-]{1,180}(?: \([A-Z0-9 -]{1,40}\))?$/.test(v.extensionId)
      : v.browser === "firefox"
      ? /^[a-zA-Z0-9@._{}-]{1,200}$/.test(v.extensionId)
      : /^[a-p]{32}$/.test(v.extensionId)) && validExtensionOrigin(v) &&
    typeof v.version === "string" && /^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v.version);
}

function validExtensionOrigin(value: Partial<BrowserConnectionIdentity>) {
  if (value.browser === "firefox") return typeof value.extensionOrigin === "string" && /^moz-extension:\/\/[\da-f-]{36}$/i.test(value.extensionOrigin);
  if (value.browser === "safari") return typeof value.extensionOrigin === "string" && /^safari-web-extension:\/\/[\da-f-]{36}$/i.test(value.extensionOrigin);
  return value.extensionOrigin === undefined || value.extensionOrigin === `chrome-extension://${value.extensionId}`;
}

const extensionOrigin = (connection: BrowserConnectionIdentity) => connection.extensionOrigin ?? `chrome-extension://${connection.extensionId}`;

interface NativeConnection extends BrowserConnectionIdentity {
  id: string;
  token: Buffer;
  controllerId: string;
  pages: EmbeddedBrowserPage[];
  seen: number;
  created: number;
}

/** Ephemeral transport on the native Session. No page or input authority survives a document/turn change. */
export class WebBrowserBroker {
  private readonly native = new Map<string, NativeConnection>();
  private readonly connections = new Map<
    string,
    { sessionId: string; pages: EmbeddedBrowserPage[]; seen: number }
  >();
  private readonly states = new Map<
    string,
    { owner: QuestionOwner; transport: string; page: EmbeddedBrowserPage; refs: Set<string> }
  >();
  private pending?: {
    id: string;
    owner: QuestionOwner;
    transport: string;
    browser: BrowserId;
    page?: EmbeddedBrowserPage;
    request: BrowserRequest;
    settle: (result?: unknown, error?: string) => void;
    taken: boolean;
  };
  private readonly owner: () => QuestionOwner | undefined;
  private readonly timeoutMs: number;
  constructor(owner: () => QuestionOwner | undefined, timeoutMs = 15000) {
    this.owner = owner;
    this.timeoutMs = timeoutMs;
  }

  connect(controllerId: string, identity: BrowserConnectionIdentity) {
    // A reconnect replaces only this workbench controller's previous connection.
    for (const [id, connection] of this.native) {
      if (connection.controllerId === controllerId || Date.now() - (connection.seen || connection.created) > 60_000) {
        if (this.pending?.transport === id) this.pending.settle(undefined, "Browser connection replaced. Observe again.");
        this.native.delete(id);
        for (const [stateId, state] of this.states) if (state.transport === id) this.states.delete(stateId);
      }
    }
    if (this.native.size >= 16) throw new Error("Too many browser connections. Close an unused OpenPI tab.");
    const connection: NativeConnection = { ...identity, id: randomUUID(), token: randomBytes(32), controllerId, pages: [], seen: 0, created: Date.now() };
    this.native.set(connection.id, connection);
    return { connectionId: connection.id, token: connection.token.toString("hex") };
  }

  authenticate(connectionId: string, authorization: string | undefined, origin: string | undefined) {
    const connection = this.native.get(connectionId);
    if (connection && Date.now() - (connection.seen || connection.created) > 15_000) { this.disconnect(connectionId); return false; }
    if (!connection || !authorization?.match(/^Bearer [a-f0-9]{64}$/) ||
      (origin !== undefined && origin !== extensionOrigin(connection))) return false;
    return timingSafeEqual(connection.token, Buffer.from(authorization.slice(7), "hex"));
  }

  allowsOrigin(connectionId: string, origin: string | undefined) {
    const connection = this.native.get(connectionId);
    return Boolean(connection && origin === extensionOrigin(connection));
  }

  disconnect(id: string) {
    if (this.pending?.transport === id) this.pending.settle(undefined, "Browser disconnected; dispatched effects may be uncertain.");
    this.native.delete(id);
    for (const [stateId, state] of this.states) if (state.transport === id) this.states.delete(stateId);
  }

  profiles(controllerId?: string): BrowserProfile[] {
    return [...this.native.values()].map(({ id, browser, profileId, extensionId, version, seen, controllerId: owner }) => ({
      id, browser, profileId, extensionId, version, connected: Date.now() - seen < 5_000, current: owner === controllerId,
    }));
  }

  pollNative(id: string, pages: EmbeddedBrowserPage[]) {
    this.reconcile();
    const connection = this.native.get(id);
    if (!connection) throw new Error("Browser connection expired");
    connection.seen = Date.now();
    const enabled = browserAllowed(loadSetupConfig().browser, connection.browser);
    connection.pages = enabled ? structuredClone(pages) : [];
    return { enabled, pending: enabled ? this.take(id, pages) : null };
  }

  resultNative(id: string, requestId: string, result: unknown, error?: string) {
    this.reconcile();
    const pending = this.pending;
    if (!pending?.taken || pending.id !== requestId || pending.transport !== id) return false;
    pending.settle(result, error);
    return true;
  }

  dispose() { this.close(); this.native.clear(); }

  poll(sessionId: string, controllerId: string, pages: EmbeddedBrowserPage[]) {
    this.reconcile();
    const owner = this.owner();
    if (!browserAllowed(loadSetupConfig().browser, "embedded")) return null;
    if (this.connections.size >= 8 && !this.connections.has(controllerId))
      this.connections.delete(this.connections.keys().next().value!);
    this.connections.set(controllerId, {
      sessionId,
      pages: structuredClone(pages),
      seen: Date.now(),
    });
    if (
      !owner ||
      owner.sessionId !== sessionId ||
      owner.controllerId !== controllerId
    )
      return null;
    return this.take(controllerId, pages);
  }

  private take(transport: string, pages: EmbeddedBrowserPage[]) {
    const pending = this.pending;
    if (!pending || pending.transport !== transport) return null;
    if (
      pending.page &&
      pending.request.operation !== "navigate" &&
      !pages.some(
        (page) =>
          page.id === pending.page!.id &&
          page.document === pending.page!.document,
      )
    ) {
      pending.settle(
        undefined,
        "The browser page closed or navigated. Observe again.",
      );
      return null;
    }
    if (pending.taken) return { requestId: pending.id, running: true as const };
    pending.taken = true;
    return {
      requestId: pending.id,
      page: pending.page,
      request: pending.request,
    };
  }

  result(
    sessionId: string,
    controllerId: string,
    requestId: string,
    result: unknown,
    error?: string,
  ) {
    this.reconcile();
    const pending = this.pending;
    if (
      !pending ||
      !pending.taken ||
      pending.id !== requestId ||
      pending.owner.sessionId !== sessionId ||
      pending.owner.controllerId !== controllerId
      || pending.transport !== controllerId
    )
      return false;
    pending.settle(result, error);
    return true;
  }

  reconcile() {
    const config = loadSetupConfig().browser;
    if (!config.control) {
      this.close();
      for (const connection of this.native.values()) connection.pages = [];
      return;
    }
    for (const connection of this.native.values()) if (!browserAllowed(config, connection.browser)) connection.pages = [];
    if (this.pending && !browserAllowed(config, this.pending.browser))
      this.pending.settle(undefined, "Browser access was revoked. Dispatched effects may be uncertain.");
    for (const [id, state] of this.states) {
      const family = this.native.get(state.transport)?.browser ?? "embedded";
      if (!browserAllowed(config, family)) this.states.delete(id);
    }
    if (this.pending && !sameOwner(this.pending.owner, this.owner()))
      this.pending.settle(
        undefined,
        "Browser request cancelled because its turn or Session changed.",
      );
  }

  close() {
    this.pending?.settle(
      undefined,
      "Browser bridge closed; execution may have been interrupted.",
    );
    this.connections.clear();
    this.states.clear();
  }

  private resolve(request: BrowserRequest, owner: QuestionOwner) {
    const config = loadSetupConfig().browser;
    const embedded = this.connections.get(owner.controllerId);
    const native = [...this.native.values()].filter((connection) => Date.now() - connection.seen < 5000);
    // A root returned by this broker identifies its transport independently of later default changes.
    // Strict tool-schema providers may serialize an omitted optional string as "".
    let selected = request.browser?.trim().toLowerCase() || undefined;
    if (!selected && request.root) {
      const existing = native.find((connection) => connection.pages.some((page) => page.id === request.root));
      selected = existing?.id ?? (embedded?.pages.some((page) => page.id === request.root) ? "embedded" : undefined);
      if (!selected) throw new Error("This browser root is no longer connected. Call tabs again.");
    }
    selected ??= config.defaultBrowser;
    const exact = this.native.get(selected);
    const browser = exact?.browser ?? selected;
    if (!BROWSER_IDS.some((id) => id === browser)) throw new Error("Unknown browser. Call browsers to inspect available targets.");
    if (!browserAllowed(config, browser as BrowserId)) throw new Error(`Browser ${browser} is not allowed. Enable it in Settings → Browser; do not switch to another browser.`);
    if (browser === "embedded") {
      if (!embedded || embedded.sessionId !== owner.sessionId || Date.now() - embedded.seen > 5000)
        throw new Error("The initiating OpenPI tab is not connected. Open it and finish Settings → Browser setup.");
      return { browser: "embedded" as const, transport: owner.controllerId, connection: embedded };
    }
    const matches = native.filter((connection) => exact ? connection.id === exact.id : connection.browser === browser);
    // Workbench tabs in the same native profile share a target; prefer the initiating tab's live connection.
    const current = matches.find((connection) => connection.controllerId === owner.controllerId);
    const profiles = new Set(matches.map((connection) => connection.profileId));
    if (!current && profiles.size > 1) throw new Error(`Multiple ${browser} profiles are connected. Call browsers and select an exact profile ID.`);
    const connection = current ?? matches[0];
    if (!connection) throw new Error(`Browser ${browser} is not connected. Open OpenPI in that browser and finish Settings → Browser setup. Do not fall back to another browser.`);
    return { browser: connection.browser, transport: connection.id, connection };
  }

  async execute(
    request: BrowserRequest,
    signal?: AbortSignal,
  ): Promise<AgentToolResult<unknown>> {
    signal?.throwIfAborted();
    this.reconcile();
    const owner = this.owner();
    if (!loadSetupConfig().browser.control || !owner) throw new Error("Browser control needs an enabled, active OpenPI turn.");
    if (request.operation === "browsers") {
      const config = loadSetupConfig().browser;
      const details = { defaultBrowser: config.defaultBrowser, browsers: BROWSER_IDS.map((id) => ({ id, allowed: browserAllowed(config, id) })), profiles: this.profiles(owner.controllerId) };
      return { content: [{ type: "text", text: JSON.stringify(details) }], details };
    }
    const { browser, transport, connection } = this.resolve(request, owner);
    if (request.operation === "tabs") {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              connection.pages.map(({ id, title, url }) => ({
                root: id,
                title,
                url,
              })),
            ),
          },
          ...(browser !== "embedded" && connection.pages.length === 64 ? [{ type: "text" as const, text: "Showing at most 64 eligible HTTP(S) tabs. Close unused tabs to expose additional pages or open a new one." }] : []),
        ],
        details: {
          pages: connection.pages.map(({ id, title, url }) => ({
            root: id,
            title,
            url,
          })),
        },
      };
    }
    const page = connection.pages.find((page) => page.id === request.root);
    if (!page && request.operation !== "open")
      throw new Error(
        "An exact connected browser root is required. Call tabs again.",
      );
    if (
      request.operation === "open" &&
      (!browserUrl(request.url) || connection.pages.length >= (browser === "embedded" ? 8 : 64))
    )
      throw new Error(
        "Open requires an HTTP(S) URL and room for another browser page.",
      );
    if (this.pending)
      throw new Error("Another browser request is in progress.");
    if (
      page &&
      (request.operation === "act" || request.operation === "navigate")
    ) {
      const state = request.stateId && this.states.get(request.stateId);
      if (
        !state ||
        !sameOwner(state.owner, owner) ||
        state.transport !== transport ||
        state.page.id !== page.id ||
        state.page.document !== page.document
      )
        throw new Error(
          "Browser state is stale. Observe this page again before acting.",
        );
      if (request.operation === "navigate" && !browserUrl(request.url))
        throw new Error(
          "Navigation requires an HTTP(S) URL without credentials.",
        );
      if (request.operation === "act") {
        if (!request.actions?.length || request.actions.length > 20)
          throw new Error("Act requires 1–20 actions.");
        for (const action of request.actions) {
          if (
            !["press", "setText", "typeText", "scroll"].includes(action.action)
          )
            throw new Error("Unsupported embedded action.");
          if (
            ["press", "setText", "typeText"].includes(action.action) &&
            !action.ref
          )
            throw new Error("Press and text input require an observed ref.");
          if (action.ref && !state.refs.has(action.ref))
            throw new Error(
              "The element ref does not belong to this observation.",
            );
          if (
            ["setText", "typeText"].includes(action.action) &&
            (typeof action.text !== "string" || action.text.length > 16000)
          )
            throw new Error("Text input requires bounded text.");
          if (
            action.action === "scroll" &&
            (!Number.isFinite(action.scrollY) ||
              Math.abs(action.scrollY!) > 10000)
          )
            throw new Error("Scroll requires a bounded distance.");
        }
      }
      // A dispatched write consumes every state for this document, even on unknown/partial outcomes.
    }
    // Only the latest snapshot is actionable in the browser's live document.
    for (const [id, record] of this.states)
      if (record.page.id === page?.id) this.states.delete(id);
    const previousPageIds = new Set(connection.pages.map((page) => page.id));
    const result = await new Promise<unknown>((resolve, reject) => {
      const id = randomUUID();
      const cancel = () =>
        settle(
          undefined,
          "Browser request cancelled; effects already dispatched may be uncertain. Observe again.",
        );
      const timer = setTimeout(
        () =>
          settle(
            undefined,
            "Browser request timed out; delivery is uncertain. Observe again.",
          ),
        this.timeoutMs,
      );
      const settle = (result?: unknown, error?: string) => {
        if (this.pending?.id !== id) return;
        this.pending = undefined;
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
        if (error) reject(new Error(error.slice(0, 1000)));
        else resolve(result);
      };
      this.pending = {
        id,
        owner,
        transport,
        browser,
        page,
        request: structuredClone(request),
        settle,
        taken: false,
      };
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
    });
    if (!sameOwner(owner, this.owner()))
      throw new Error("The owning browser turn changed.");
    if (request.operation === "open") {
      const opened = result as { root?: unknown } | null;
      if (
        !opened ||
        typeof opened.root !== "string" ||
        previousPageIds.has(opened.root) ||
        !(browser === "embedded" ? this.connections.get(transport) : this.native.get(transport))?.pages.some((page) => page.id === opened.root)
      )
        throw new Error("The browser page did not bind successfully.");
      return {
        content: [
          {
            type: "text",
            text: `Opened ${browser} root ${opened.root}. Observe it to inspect the loaded page.`,
          },
        ],
        details: { root: opened.root },
      };
    }
    if (request.operation === "navigate") {
      if (
        !result ||
        typeof result !== "object" ||
        (result as { navigated?: unknown }).navigated !== true
      )
        throw new Error(
          "Navigation delivery was not confirmed; observe again.",
        );
      return {
        content: [
          {
            type: "text",
            text: "Navigation was dispatched. Call tabs and observe again after the document binds; this receipt does not verify that loading succeeded.",
          },
        ],
        details: { status: "dispatched" },
      };
    }
    const observation = result as Partial<BrowserObservation> | null;
    if (
      !observation ||
      !Array.isArray(observation.nodes) ||
      observation.nodes.length > 500 ||
      typeof observation.text !== "string" ||
      observation.text.length > 16000 ||
      observation.nodes.some(
        (node) =>
          !node ||
          typeof node.ref !== "string" ||
          !/^@e\d+$/.test(node.ref) ||
          typeof node.role !== "string" ||
          node.role.length > 100 ||
          typeof node.name !== "string" ||
          node.name.length > 500 ||
          (node.value !== undefined &&
            (typeof node.value !== "string" || node.value.length > 500)),
      ) ||
      (observation.image !== undefined &&
        (typeof observation.image !== "string" ||
          observation.image.length > 4_000_000 ||
          !/^[\w+/=]+$/.test(observation.image)))
    )
      throw new Error(
        "The browser returned an invalid or oversized observation.",
      );
    const stateId = randomUUID();
    if (!page) throw new Error("The browser page disappeared.");
    if (this.states.size >= 32)
      this.states.delete(this.states.keys().next().value!);
    this.states.set(stateId, {
      owner,
      transport,
      page,
      refs: new Set(observation.nodes.map((node) => node.ref)),
    });
    const details = {
      root: page.id,
      stateId,
      nodes: observation.nodes,
      text: observation.text,
      truncated: observation.truncated === true,
    };
    return {
      content: [
        { type: "text", text: JSON.stringify(details) },
        ...(observation.image
          ? [
              {
                type: "image" as const,
                data: observation.image,
                mimeType: "image/png",
              },
            ]
          : []),
      ],
      details,
    };
  }
}
