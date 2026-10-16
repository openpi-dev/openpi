import { configure } from "@testing-library/react";
import { beforeEach, vi } from "vitest";

// findBy*/waitFor budgets are harness give-up limits, not product deadlines:
// a missing element still fails, only later. The 1 s library default is less
// than one App-level jsdom render on a loaded Windows runner, which made
// unrelated UI tests fail at random there (#829). No case asserts that an
// element appears within a time bound; product timers use explicit clocks.
configure({ asyncUtilTimeout: 5_000 });

// jsdom omits this browser API. Components may subscribe before a test opens
// their menus; viewport-specific cases replace this default with their fixture.
beforeEach(() => {
  // Component tests mount a foreground document by default. Focus-specific
  // cases override this, just as viewport cases override matchMedia below.
  if (typeof document !== "undefined")
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
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
