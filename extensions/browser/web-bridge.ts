import type { AgentToolResult } from "@earendil-works/pi-coding-agent";

export interface BrowserAction {
  action: "press" | "setText" | "typeText" | "scroll";
  ref?: string;
  text?: string;
  scrollY?: number;
}

export interface BrowserRequest {
  operation: "browsers" | "tabs" | "open" | "observe" | "act" | "navigate";
  browser?: string;
  root?: string;
  stateId?: string;
  url?: string;
  image?: boolean;
  actions?: BrowserAction[];
}

type BrowserBridge = (
  request: BrowserRequest,
  signal?: AbortSignal,
) => Promise<AgentToolResult<unknown>>;
const key = Symbol.for("@tt-a1i/openpi/web-browser/v1");
const existing: unknown = Reflect.get(globalThis, key);
if (existing !== undefined && !(existing instanceof WeakMap))
  throw new Error("Incompatible OpenPI browser bridge");
const bridges: WeakMap<object, BrowserBridge> = existing ?? new WeakMap();
if (existing === undefined)
  Object.defineProperty(globalThis, key, { value: bridges });

export function registerWebBrowserBridge(scope: object, bridge: BrowserBridge) {
  if (bridges.has(scope))
    throw new Error("Session already has a browser bridge");
  bridges.set(scope, bridge);
  return () => {
    if (bridges.get(scope) === bridge) bridges.delete(scope);
  };
}

export function controlWebBrowser(
  scope: object,
  request: BrowserRequest,
  signal?: AbortSignal,
) {
  const bridge = bridges.get(scope);
  if (!bridge)
    throw new Error(
      "The OpenPI embedded browser is unavailable in this Session.",
    );
  return bridge(request, signal);
}
