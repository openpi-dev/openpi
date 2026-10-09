import { randomUUID } from "node:crypto";
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
): input is EmbeddedBrowserPage[] {
  return (
    Array.isArray(input) &&
    input.length <= 8 &&
    input.every((p: unknown) => {
      if (!p || typeof p !== "object") return false;
      const page = p as Partial<EmbeddedBrowserPage>;
      return (
        typeof page.id === "string" &&
        page.id.length > 0 &&
        page.id.length <= 150 &&
        typeof page.document === "string" &&
        /^[\da-f-]{36}$/.test(page.document) &&
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

/** Ephemeral transport on the native Session. No page or input authority survives a document/turn change. */
export class WebBrowserBroker {
  private readonly connections = new Map<
    string,
    { sessionId: string; pages: EmbeddedBrowserPage[]; seen: number }
  >();
  private readonly states = new Map<
    string,
    { owner: QuestionOwner; page: EmbeddedBrowserPage; refs: Set<string> }
  >();
  private pending?: {
    id: string;
    owner: QuestionOwner;
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

  poll(sessionId: string, controllerId: string, pages: EmbeddedBrowserPage[]) {
    this.reconcile();
    const owner = this.owner();
    if (!loadSetupConfig().browser.control) return null;
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
    const pending = this.pending;
    if (!pending) return null;
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
        "The embedded page closed or navigated. Observe again.",
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
    )
      return false;
    pending.settle(result, error);
    return true;
  }

  reconcile() {
    if (!loadSetupConfig().browser.control) {
      this.close();
      return;
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

  async execute(
    request: BrowserRequest,
    signal?: AbortSignal,
  ): Promise<AgentToolResult<unknown>> {
    signal?.throwIfAborted();
    this.reconcile();
    const owner = this.owner();
    const connection = owner && this.connections.get(owner.controllerId);
    if (
      !loadSetupConfig().browser.control ||
      !owner ||
      !connection ||
      connection.sessionId !== owner.sessionId ||
      Date.now() - connection.seen > 5000
    ) {
      throw new Error(
        "Open the embedded browser in the tab initiating this turn, with Browser Bridge installed. No connected page is available.",
      );
    }
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
        "An exact connected embedded root is required. Call tabs again.",
      );
    if (
      request.operation === "open" &&
      (!browserUrl(request.url) || connection.pages.length >= 8)
    )
      throw new Error(
        "Open requires an HTTP(S) URL and room for an internal page.",
      );
    if (this.pending)
      throw new Error("Another embedded browser request is in progress.");
    if (
      page &&
      (request.operation === "act" || request.operation === "navigate")
    ) {
      const state = request.stateId && this.states.get(request.stateId);
      if (
        !state ||
        !sameOwner(state.owner, owner) ||
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
        connection.pages.some((page) => page.id === opened.root) ||
        !this.connections
          .get(owner.controllerId)
          ?.pages.some((page) => page.id === opened.root)
      )
        throw new Error("The internal page did not bind successfully.");
      return {
        content: [
          {
            type: "text",
            text: `Opened embedded root ${opened.root}. Observe it to inspect the loaded page.`,
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
