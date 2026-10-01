// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { createElement } from "react";
import { I18nextProvider } from "react-i18next";
import { afterEach, expect, it, vi } from "vitest";
import {
  TurnNavigation,
  type TurnNavigationItem,
} from "../../web/ui/src/features/transcript/TurnNavigation.tsx";
import { i18n } from "../../web/ui/src/i18n.ts";

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function fixture(count: number, jump = false) {
  const items: TurnNavigationItem[] = Array.from(
    { length: count },
    (_, index) => ({
      entryId: `native-${index}`,
      title: `Prompt ${index}`,
      reply: `Reply ${index}`,
    }),
  );
  const shell = document.createElement("section");
  const root = document.createElement("div");
  const container = document.createElement("div");
  shell.append(root, container);
  document.body.append(shell);
  Object.defineProperties(root, {
    clientHeight: { configurable: true, value: 500 },
    scrollHeight: { configurable: true, get: () => items.length * 200 },
  });
  vi.spyOn(shell, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 10, 1000, 890),
  );
  vi.spyOn(root, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 120, 1000, 500),
  );
  items.forEach((item, index) => {
    const target = document.createElement("article");
    target.dataset.historyEntry = item.entryId;
    target.tabIndex = -1;
    root.append(target);
    vi.spyOn(target, "getBoundingClientRect").mockImplementation(
      () => new DOMRect(80, 120 + index * 200 - root.scrollTop, 840, 140),
    );
  });
  if (jump) {
    const button = document.createElement("button");
    button.className = "jump-to-latest";
    vi.spyOn(button, "getBoundingClientRect").mockReturnValue(
      new DOMRect(800, 580, 140, 42),
    );
    shell.append(button);
  }
  const onNavigate = vi.fn();
  const node = (nextItems = items, scope = "s", enabled = true) =>
    createElement(
      I18nextProvider,
      { i18n },
      createElement(TurnNavigation, {
        key: scope,
        items: nextItems,
        viewport: { current: root },
        readingHistory: jump,
        onNavigate,
        enabled,
      }),
    );
  const view = render(node(), { container });
  return { items, root, node, view, onNavigate };
}

it("shows every native landmark, including first/last, and hides fewer than four", () => {
  const small = fixture(3);
  expect(screen.queryByRole("navigation")).toBeNull();
  small.view.unmount();
  const large = fixture(130);
  const buttons = screen.getAllByRole("button");
  expect(buttons).toHaveLength(130);
  expect(buttons[0]?.dataset.turnEntry).toBe("native-0");
  expect(buttons.at(-1)?.dataset.turnEntry).toBe("native-129");
  expect(new Set(buttons.map((button) => button.dataset.turnEntry)).size).toBe(
    130,
  );
  expect(buttons.map((button) => button.dataset.turnEntry)).toEqual(
    large.items.map((item) => item.entryId),
  );
  large.view.unmount();
});

it("uses the scrollport safe area and reserves Jump's measured rectangle", () => {
  fixture(5, true);
  const rail = screen.getByRole("navigation");
  expect(rail.style.top).toBe("338px");
  expect(rail.style.maxHeight).toBe("440px");
  expect(
    Number.parseFloat(rail.style.top) +
      Number.parseFloat(rail.style.maxHeight) / 2,
  ).toBe(580 - 10 - 12);
});

it("keeps hover separate from the reading marker and dismisses the one preview with Escape", async () => {
  vi.useFakeTimers();
  const matches = Element.prototype.matches;
  vi.spyOn(Element.prototype, "matches").mockImplementation(function (
    this: Element,
    selector: string,
  ) {
    // jsdom has no native Popover API; expose the primitive's visible fallback.
    if (selector === ":popover-open")
      return this instanceof HTMLElement && this.style.display === "block";
    return matches.call(this, selector);
  });
  const { root } = fixture(5);
  const buttons = screen.getAllByRole("button");
  expect(buttons[0]?.getAttribute("aria-current")).toBe("location");
  fireEvent.mouseEnter(buttons[4]!);
  await act(() => vi.advanceTimersByTimeAsync(150));
  expect(document.querySelectorAll(".turn-preview")).toHaveLength(1);
  expect(document.querySelector(".turn-preview")?.textContent).toBe(
    "Prompt 4Reply 4",
  );
  expect(
    Reflect.get(
      document.querySelector<HTMLElement>(".turn-preview-layer")!.style,
      "positionArea",
    ),
  ).toBe("self-inline-start");
  expect(buttons[0]?.getAttribute("aria-current")).toBe("location");
  act(() => buttons[3]!.focus());
  expect(document.querySelectorAll(".turn-preview")).toHaveLength(1);
  expect(document.querySelector(".turn-preview")?.textContent).toBe(
    "Prompt 3Reply 3",
  );
  root.scrollTop = 420;
  fireEvent.scroll(root);
  await act(() => vi.advanceTimersByTimeAsync(20));
  expect(buttons[2]?.getAttribute("aria-current")).toBe("location");
  expect(buttons[0]?.hasAttribute("aria-current")).toBe(false);
  fireEvent.keyDown(document, { key: "Escape" });
  expect(document.querySelector(".turn-preview")).toBeNull();
});

it("retains a focused native button on prepend, activates only its native ID, and resets preview across scope", async () => {
  vi.useFakeTimers();
  const { items, node, view, onNavigate } = fixture(5);
  const button = screen.getByRole("button", {
    name: i18n.t("conversationTurnPosition", { position: 4 }),
  });
  act(() => button.focus());
  fireEvent.mouseEnter(button);
  await act(() => vi.advanceTimersByTimeAsync(150));
  expect(document.querySelector(".turn-preview")).toBeTruthy();
  view.rerender(node([{ entryId: "older", title: "Older prompt" }, ...items]));
  expect(view.container.querySelector('[data-turn-entry="native-3"]')).toBe(
    button,
  );
  expect(document.activeElement).toBe(button);
  fireEvent.click(button);
  expect(onNavigate).toHaveBeenCalledExactlyOnceWith("native-3", false);
  expect(document.querySelector(".turn-preview")).toBeNull();
  fireEvent.mouseEnter(button);
  await act(() => vi.advanceTimersByTimeAsync(150));
  view.rerender(node(items, "copied-session-path"));
  expect(document.querySelector(".turn-preview")).toBeNull();
  expect(view.container.querySelector('[data-turn-entry="native-3"]')).not.toBe(
    button,
  );
});

it("keeps the same current native tick reachable after prepend without moving the transcript", () => {
  const { items, root, node, view } = fixture(5);
  const rail = screen.getByRole("navigation");
  const active = screen.getByRole("button", {
    name: i18n.t("conversationTurnPosition", { position: 1 }),
  });
  vi.spyOn(rail, "getBoundingClientRect").mockReturnValue(
    new DOMRect(952, 130, 36, 44),
  );
  vi.spyOn(active, "getBoundingClientRect").mockReturnValue(
    new DOMRect(956, 190, 26, 11),
  );
  const older = document.createElement("article");
  older.dataset.historyEntry = "older";
  vi.spyOn(older, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, -80, 900, 140),
  );
  root.prepend(older);
  view.rerender(node([{ entryId: "older", title: "Older prompt" }, ...items]));
  expect(active.getAttribute("aria-current")).toBe("location");
  expect(rail.scrollTop).toBe(27);
  expect(root.scrollTop).toBe(0);
});

it("closes an existing preview and rejects a delayed opening when its rail becomes hidden", async () => {
  vi.useFakeTimers();
  fixture(5);
  const rail = screen.getByRole("navigation");
  const button = screen.getByRole("button", {
    name: i18n.t("conversationTurnPosition", { position: 4 }),
  });
  fireEvent.mouseEnter(button);
  await act(() => vi.advanceTimersByTimeAsync(150));
  expect(document.querySelector(".turn-preview")).toBeTruthy();
  rail.style.display = "none";
  fireEvent.resize(window);
  await act(() => vi.advanceTimersByTimeAsync(20));
  expect(document.querySelector(".turn-preview")).toBeNull();
  rail.style.display = "flex";
  fireEvent.mouseLeave(button);
  fireEvent.mouseEnter(button);
  rail.style.display = "none";
  fireEvent.resize(window);
  await act(() => vi.advanceTimersByTimeAsync(150));
  expect(document.querySelector(".turn-preview")).toBeNull();
});

it("marks every visible native turn, navigates adjacent turns with Alt arrows, and excludes outside focus", async () => {
  vi.useFakeTimers();
  const { root, onNavigate } = fixture(8);
  const current = () =>
    [...document.querySelectorAll<HTMLElement>(".turn-tick[aria-current]")].map(
      (item) => item.dataset.turnEntry,
    );
  expect(current()).toEqual(["native-0", "native-1", "native-2"]);
  (root.firstElementChild as HTMLElement).focus();
  fireEvent.keyDown(document, { key: "ArrowDown", altKey: true });
  expect(onNavigate).toHaveBeenLastCalledWith("native-1", false);
  root.scrollTop = 420;
  fireEvent.scroll(root);
  await act(() => vi.advanceTimersByTimeAsync(20));
  expect(current()).toEqual(["native-2", "native-3", "native-4"]);
  fireEvent.keyDown(document, { key: "ArrowUp", altKey: true });
  expect(onNavigate).toHaveBeenLastCalledWith("native-1", false);
  root.scrollTop = 450;
  fireEvent.keyDown(document, { key: "ArrowUp", altKey: true });
  expect(onNavigate).toHaveBeenLastCalledWith("native-2", false);
  fireEvent.keyDown(document, { key: "ArrowDown", altKey: true });
  expect(onNavigate).toHaveBeenLastCalledWith("native-3", false);
  const outside = document.createElement("button");
  document.body.append(outside);
  outside.focus();
  onNavigate.mockClear();
  fireEvent.keyDown(document, { key: "ArrowDown", altKey: true });
  expect(onNavigate).not.toHaveBeenCalled();
});

it("leaves consumed and composing Alt arrows with the focused input", () => {
  const { root, onNavigate } = fixture(8);
  const composer = document.createElement("textarea");
  root.parentElement!.append(composer);
  composer.addEventListener("keydown", (event) => event.preventDefault());
  composer.focus();
  const consumed = new KeyboardEvent("keydown", {
    key: "ArrowDown",
    altKey: true,
    bubbles: true,
    cancelable: true,
  });
  fireEvent(composer, consumed);
  expect(consumed.defaultPrevented).toBe(true);
  expect(onNavigate).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(composer);
  fireEvent.keyDown(document, {
    key: "ArrowDown",
    altKey: true,
    isComposing: true,
  });
  expect(onNavigate).not.toHaveBeenCalled();
});

it("keeps Alt navigation available when only the right rail gutter is narrow", async () => {
  vi.useFakeTimers();
  const { root, onNavigate } = fixture(8);
  const prompt = root.firstElementChild as HTMLElement;
  vi.spyOn(prompt, "getBoundingClientRect").mockReturnValue(
    new DOMRect(80, 120, 896, 140),
  );
  fireEvent.resize(window);
  await act(() => vi.advanceTimersByTimeAsync(20));
  expect(
    screen.getByRole("navigation", { hidden: true }).style.visibility,
  ).toBe("hidden");
  prompt.focus();
  fireEvent.keyDown(document, { key: "ArrowDown", altKey: true });
  expect(onNavigate).toHaveBeenCalledExactlyOnceWith("native-1", false);
});

it("rejects Alt navigation when the transcript is disabled or its viewport is hidden", () => {
  const { items, root, node, view, onNavigate } = fixture(8);
  (root.firstElementChild as HTMLElement).focus();
  view.rerender(node(items, "s", false));
  fireEvent.keyDown(document, { key: "ArrowDown", altKey: true });
  expect(onNavigate).not.toHaveBeenCalled();
  view.rerender(node());
  root.style.display = "none";
  fireEvent.keyDown(document, { key: "ArrowDown", altKey: true });
  expect(onNavigate).not.toHaveBeenCalled();
  root.style.display = "block";
  root.style.visibility = "hidden";
  fireEvent.keyDown(document, { key: "ArrowDown", altKey: true });
  expect(onNavigate).not.toHaveBeenCalled();
  root.style.visibility = "visible";
  fireEvent.keyDown(document, { key: "ArrowDown", altKey: true });
  expect(onNavigate).toHaveBeenCalledExactlyOnceWith("native-1", false);
});

it("does not pull the internal rail back to the latest tick when a historical preview resolves", () => {
  const { items, node, view } = fixture(80);
  const rail = screen.getByRole("navigation");
  const active = screen.getByRole("button", {
    name: i18n.t("conversationTurnPosition", { position: 1 }),
  });
  vi.spyOn(rail, "getBoundingClientRect").mockReturnValue(
    new DOMRect(952, 130, 36, 100),
  );
  vi.spyOn(active, "getBoundingClientRect").mockReturnValue(
    new DOMRect(952, -90, 36, 10),
  );
  rail.scrollTop = 220;
  view.rerender(
    node(
      items.map((item, index) =>
        index === 50
          ? {
              ...item,
              title: "Historical fetched preview",
              previewState: "ready",
            }
          : item,
      ),
    ),
  );
  expect(rail.scrollTop).toBe(220);
});

it.each(["focus", "hover"])(
  "keeps the interacting native %s tick reachable when metadata inserts earlier IDs",
  (interaction) => {
    const { items, root, node, view } = fixture(80);
    const rail = screen.getByRole("navigation");
    const current = view.container.querySelector<HTMLElement>(
      '[data-turn-entry="native-0"]',
    )!;
    const historic = view.container.querySelector<HTMLElement>(
      '[data-turn-entry="native-50"]',
    )!;
    vi.spyOn(rail, "getBoundingClientRect").mockReturnValue(
      new DOMRect(952, 130, 36, 44),
    );
    vi.spyOn(current, "getBoundingClientRect").mockReturnValue(
      new DOMRect(952, -90, 36, 10),
    );
    let addedHeight = 0;
    vi.spyOn(historic, "getBoundingClientRect").mockImplementation(
      () => new DOMRect(952, 370 + addedHeight - rail.scrollTop, 36, 10),
    );
    if (interaction === "focus") act(() => historic.focus());
    else {
      const matches = historic.matches;
      vi.spyOn(historic, "matches").mockImplementation(
        (selector) => selector === ":hover" || matches.call(historic, selector),
      );
    }
    rail.scrollTop = 220;
    addedHeight = 20;
    view.rerender(
      node([{ entryId: "older", title: "Older prompt" }, ...items]),
    );
    expect(view.container.querySelector('[data-turn-entry="native-50"]')).toBe(
      historic,
    );
    if (interaction === "focus") expect(document.activeElement).toBe(historic);
    expect(rail.scrollTop).toBe(226);
    expect(historic.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      rail.getBoundingClientRect().bottom,
    );
    expect(root.scrollTop).toBe(0);
  },
);

it("does not move the rail under a captured drag when the transcript current changes", async () => {
  vi.useFakeTimers();
  const { root, view } = fixture(8);
  const rail = screen.getByRole("navigation");
  vi.spyOn(rail, "getBoundingClientRect").mockReturnValue(
    new DOMRect(952, 130, 36, 44),
  );
  const nextCurrent = view.container.querySelector<HTMLElement>(
    '[data-turn-entry="native-2"]',
  )!;
  vi.spyOn(nextCurrent, "getBoundingClientRect").mockReturnValue(
    new DOMRect(952, -90, 36, 10),
  );
  const pointer = new Event("pointerdown", { bubbles: true });
  Object.defineProperties(pointer, {
    pointerId: { value: 1 },
    isPrimary: { value: true },
    button: { value: 0 },
    clientY: { value: 140 },
  });
  fireEvent(nextCurrent, pointer);
  rail.scrollTop = 220;
  root.scrollTop = 420;
  fireEvent.scroll(root);
  await act(() => vi.advanceTimersByTimeAsync(20));
  expect(nextCurrent.getAttribute("aria-current")).toBe("location");
  expect(rail.scrollTop).toBe(220);
  expect(root.scrollTop).toBe(420);
  fireEvent.pointerCancel(rail);
});

it("captures the native button so ordinary mouse clicks retain their target and releases that same button when hidden", async () => {
  vi.useFakeTimers();
  const { view, onNavigate } = fixture(8);
  const rail = screen.getByRole("navigation");
  const button = view.container.querySelector<HTMLElement>(
    '[data-turn-entry="native-3"]',
  )!;
  let captured = false;
  const capture = vi.fn(() => {
    captured = true;
  });
  const release = vi.fn(() => {
    captured = false;
  });
  Object.defineProperties(button, {
    setPointerCapture: { value: capture },
    hasPointerCapture: { value: () => captured },
    releasePointerCapture: { value: release },
  });
  const pointer = (type: string) => {
    const event = new Event(type, { bubbles: true });
    Object.defineProperties(event, {
      pointerId: { value: 1 },
      isPrimary: { value: true },
      button: { value: 0 },
      clientY: { value: 140 },
    });
    return event;
  };
  fireEvent(button.firstElementChild!, pointer("pointerdown"));
  expect(capture).toHaveBeenCalledExactlyOnceWith(1);
  fireEvent(button, pointer("pointerup"));
  expect(release).toHaveBeenCalledExactlyOnceWith(1);
  fireEvent.click(button);
  expect(onNavigate).toHaveBeenCalledExactlyOnceWith("native-3", false);
  fireEvent(button, pointer("pointerdown"));
  rail.style.display = "none";
  fireEvent.resize(window);
  await act(() => vi.advanceTimersByTimeAsync(20));
  expect(release).toHaveBeenCalledTimes(2);
  expect(captured).toBe(false);
});

it("measures the 48px right gutter instead of shrinking message content to fit a rail", async () => {
  vi.useFakeTimers();
  const { root } = fixture(5);
  const rail = screen.getByRole("navigation");
  vi.spyOn(root.firstElementChild!, "getBoundingClientRect").mockReturnValue(
    new DOMRect(80, 120, 873, 140),
  );
  fireEvent.resize(window);
  await act(() => vi.advanceTimersByTimeAsync(20));
  expect(rail.style.visibility).toBe("hidden");
  vi.spyOn(root.firstElementChild!, "getBoundingClientRect").mockReturnValue(
    new DOMRect(80, 120, 872, 140),
  );
  fireEvent.resize(window);
  await act(() => vi.advanceTimersByTimeAsync(20));
  expect(rail.style.visibility).toBe("visible");
});
