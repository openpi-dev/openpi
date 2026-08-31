export type WebCapabilityKind =
  | "subagents"
  | "workflows"
  | "background-terminals";

export interface WebCapabilityProvider {
  readonly kind: WebCapabilityKind;
  readonly snapshot: () => unknown;
  readonly subscribe?: (listener: () => void) => () => void;
}

const providers = new Map<WebCapabilityKind, WebCapabilityProvider>();
const listeners = new Map<() => void, Map<WebCapabilityKind, () => void>>();

function connect(provider: WebCapabilityProvider, listener: () => void) {
  const subscriptions = listeners.get(listener);
  subscriptions?.get(provider.kind)?.();
  const unsubscribe = provider.subscribe?.(listener);
  if (unsubscribe) subscriptions?.set(provider.kind, unsubscribe);
}

export function registerWebCapability(provider: WebCapabilityProvider) {
  providers.set(provider.kind, provider);
  for (const listener of listeners.keys()) {
    connect(provider, listener);
    listener();
  }
  return () => {
    if (providers.get(provider.kind) !== provider) return;
    providers.delete(provider.kind);
    for (const [listener, subscriptions] of listeners) {
      subscriptions.get(provider.kind)?.();
      subscriptions.delete(provider.kind);
      listener();
    }
  };
}

export function subscribeWebCapabilities(listener: () => void) {
  listeners.set(listener, new Map());
  for (const provider of providers.values()) connect(provider, listener);
  return () => {
    const subscriptions = listeners.get(listener);
    listeners.delete(listener);
    for (const unsubscribe of subscriptions?.values() ?? []) unsubscribe();
  };
}

export function webCapabilitySnapshot() {
  return Object.fromEntries(
    [...providers].map(([kind, provider]) => [kind, provider.snapshot()]),
  );
}

export function notifyWebCapabilities() {
  for (const listener of listeners.keys()) listener();
}
