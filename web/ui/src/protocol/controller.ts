import { isWebControllerId } from "../../../protocol/questions.ts";

const storageKey = "openpi.web.controller";
let identity: Promise<string> | undefined;
let release: (() => void) | undefined;
let generation = 0;

function save(id: string) {
  try {
    window.sessionStorage.setItem(storageKey, id);
  } catch {}
  return id;
}

async function claim() {
  const epoch = generation;
  // Without cross-document exclusion, a fresh identity is safer than inheriting
  // another tab's authority. Reload recovery requires Web Locks and storage.
  if (!window.navigator.locks) return save(window.crypto.randomUUID());
  let candidate: string | null = null;
  try {
    candidate = window.sessionStorage.getItem(storageKey);
  } catch {}
  let id = isWebControllerId(candidate)
    ? candidate
    : window.crypto.randomUUID();
  for (;;) {
    const current = id;
    const acquired = await new Promise<boolean | null>((resolve) => {
      void window.navigator.locks
        .request(
          `openpi.web.controller:${current}`,
          { ifAvailable: true },
          async (lock) => {
            if (epoch !== generation) {
              resolve(null);
              return;
            }
            if (!lock) {
              resolve(false);
              return;
            }
            await new Promise<void>((unlock) => {
              release = unlock;
              resolve(true);
            });
          },
        )
        .catch(() => resolve(null));
    });
    if (epoch !== generation)
      throw new DOMException("Page was suspended", "AbortError");
    if (acquired === null) return save(window.crypto.randomUUID());
    if (acquired) return save(current);
    // A copied tab must never use the stored ID even for its first request.
    id = window.crypto.randomUUID();
  }
}

export function controllerIdentity() {
  return (identity ??= claim());
}

window.addEventListener("pagehide", () => {
  generation++;
  release?.();
  release = undefined;
  identity = undefined;
});
// BFCache restores the same JS heap; reclaim before any later request.
window.addEventListener("pageshow", (event) => {
  if (event.persisted) void controllerIdentity().catch(() => {});
});
