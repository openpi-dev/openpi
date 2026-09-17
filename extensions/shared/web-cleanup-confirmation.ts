export type CleanupConfirmation = "approved" | "denied" | "unavailable";

type Confirm = (
  paths: readonly string[],
  signal?: AbortSignal,
) => Promise<CleanupConfirmation>;

const key = Symbol.for("@tt-a1i/openpi/web-cleanup-confirmation/v1");

function providers(): Map<object, Confirm> {
  const existing: unknown = Reflect.get(globalThis, key);
  if (existing !== undefined) {
    if (!(existing instanceof Map))
      throw new Error("Incompatible Web confirmation registry");
    return existing as Map<object, Confirm>;
  }
  const registry = new Map<object, Confirm>();
  Object.defineProperty(globalThis, key, { value: registry });
  return registry;
}

export function registerWebCleanupConfirmation(
  scope: object,
  confirm: Confirm,
) {
  const registry = providers();
  registry.set(scope, confirm);
  return () => {
    if (registry.get(scope) === confirm) registry.delete(scope);
  };
}

export function requestWebCleanupConfirmation(
  scope: object,
  paths: readonly string[],
  signal?: AbortSignal,
): Promise<CleanupConfirmation> {
  return (
    providers().get(scope)?.(paths, signal) ?? Promise.resolve("unavailable")
  );
}
