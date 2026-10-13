import { beforeEach, vi } from "vitest";

// jsdom omits this browser API. Components may subscribe before a test opens
// their menus; viewport-specific cases replace this default with their fixture.
beforeEach(() => {
  if (typeof window === "undefined" || typeof window.matchMedia === "function")
    return;
  vi.stubGlobal("matchMedia", (query: string) => {
    const events = new EventTarget();
    return {
      matches: false,
      media: query,
      onchange: null,
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
      dispatchEvent: events.dispatchEvent.bind(events),
      addListener() {},
      removeListener() {},
    } satisfies MediaQueryList;
  });
});
