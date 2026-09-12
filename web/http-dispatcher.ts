import { EventEmitter } from "node:events";
import * as undici from "undici";

export const DEFAULT_HTTP_IDLE_TIMEOUT_MS = 300_000;
const DEFAULT_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS = 2_000;
const originalGlobalFetch = globalThis.fetch;
let installedGlobalFetch: typeof globalThis.fetch | undefined;

type ManagedDispatcher = {
  dispatcher: undici.Dispatcher;
  previous: undici.Dispatcher;
  released: boolean;
};

const managedDispatchers = new WeakMap<undici.Dispatcher, ManagedDispatcher>();

export interface HttpDispatcherLease {
  timeoutMs: number;
  release(): Promise<void>;
}

function ignoreDispatcherError(_error: unknown) {}

function withErrorListener<T extends undici.Dispatcher>(dispatcher: T) {
  if (dispatcher instanceof EventEmitter) {
    EventEmitter.prototype.on.call(
      dispatcher,
      "error",
      ignoreDispatcherError,
    );
  }
  return dispatcher;
}

function createClient(origin: string | URL, options: object) {
  return withErrorListener(
    new undici.Client(origin, options as undici.Client.Options),
  );
}

function createOriginDispatcher(origin: string | URL, options: object) {
  const dispatcherOptions = options as undici.Pool.Options;
  if (dispatcherOptions.connections === 1) {
    return createClient(origin, dispatcherOptions);
  }
  return withErrorListener(
    new undici.Pool(origin, {
      ...dispatcherOptions,
      factory: createClient,
    }),
  );
}

export function applyHttpProxySettings(httpProxy: string | undefined) {
  const proxy = httpProxy?.trim();
  if (!proxy) return false;
  process.env.HTTP_PROXY ??= proxy;
  process.env.HTTPS_PROXY ??= proxy;
  return true;
}

function parseHttpIdleTimeoutMs(value: unknown) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.toLowerCase() === "disabled") return 0;
    if (trimmed.length === 0) return undefined;
    return parseHttpIdleTimeoutMs(Number(trimmed));
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.floor(value);
}

export function configureHttpDispatcher(
  timeoutMs = DEFAULT_HTTP_IDLE_TIMEOUT_MS,
): HttpDispatcherLease {
  const normalizedTimeoutMs = parseHttpIdleTimeoutMs(timeoutMs);
  if (normalizedTimeoutMs === undefined) {
    throw new Error(`Invalid HTTP idle timeout: ${String(timeoutMs)}`);
  }
  const previous = undici.getGlobalDispatcher();
  const dispatcher = withErrorListener(
    new undici.EnvHttpProxyAgent({
      allowH2: false,
      bodyTimeout: normalizedTimeoutMs,
      connect: {
        autoSelectFamilyAttemptTimeout: DEFAULT_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS,
      },
      headersTimeout: normalizedTimeoutMs,
      clientFactory: createClient,
      factory: createOriginDispatcher,
    }),
  );
  const managed = { dispatcher, previous, released: false };
  managedDispatchers.set(dispatcher, managed);
  undici.setGlobalDispatcher(dispatcher);
  const shouldInstallGlobals =
    installedGlobalFetch === undefined
      ? globalThis.fetch === originalGlobalFetch
      : globalThis.fetch === installedGlobalFetch;
  if (shouldInstallGlobals) {
    undici.install?.();
    installedGlobalFetch = globalThis.fetch;
  }
  let released = false;
  return {
    timeoutMs: normalizedTimeoutMs,
    async release() {
      if (released) return;
      released = true;
      managed.released = true;
      if (undici.getGlobalDispatcher() === dispatcher) {
        let replacement = managed.previous;
        let replaced = managedDispatchers.get(replacement);
        while (replaced?.released) {
          replacement = replaced.previous;
          replaced = managedDispatchers.get(replacement);
        }
        undici.setGlobalDispatcher(replacement);
      }
      await dispatcher.close();
    },
  };
}
