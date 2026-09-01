export type WebCapabilityKind =
  | "subagents"
  | "workflows"
  | "background-terminals";

export interface WebCapabilityProvider {
  readonly kind: WebCapabilityKind;
  /** Owning Pi Session; unbound providers must never enter a Web snapshot. */
  readonly sessionId: string;
  readonly snapshot: () => unknown;
  readonly subscribe?: (listener: () => void) => () => void;
}

const providers = new Map<string, WebCapabilityProvider>();
const providerKey = (
  provider: Pick<WebCapabilityProvider, "kind" | "sessionId">,
) => `${provider.sessionId}:${provider.kind}`;
const listeners = new Map<() => void, Map<string, () => void>>();

function connect(provider: WebCapabilityProvider, listener: () => void) {
  const subscriptions = listeners.get(listener);
  const key = providerKey(provider);
  subscriptions?.get(key)?.();
  const unsubscribe = provider.subscribe?.(listener);
  if (unsubscribe) subscriptions?.set(key, unsubscribe);
}

export function registerWebCapability(provider: WebCapabilityProvider) {
  const key = providerKey(provider);
  providers.set(key, provider);
  for (const listener of listeners.keys()) {
    connect(provider, listener);
    listener();
  }
  return () => {
    if (providers.get(key) !== provider) return;
    providers.delete(key);
    for (const [listener, subscriptions] of listeners) {
      subscriptions.get(key)?.();
      subscriptions.delete(key);
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

export function webCapabilitySnapshot(sessionId: string) {
  return Object.fromEntries(
    [...providers.values()]
      .filter((provider) => provider.sessionId === sessionId)
      .map((provider) => [provider.kind, provider.snapshot()]),
  );
}

export function notifyWebCapabilities() {
  for (const listener of listeners.keys()) listener();
}
