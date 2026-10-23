// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useReadingAnchor } from "../../web/ui/src/features/transcript/use-reading-anchor.ts";

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

it("anchors the outer tool row while a nested process scrollport moves independently", () => {
  const root = document.createElement("div");
  const row = document.createElement("article");
  row.dataset.historyEntry = "tool-row";
  const nested = document.createElement("div");
  nested.style.overflowY = "auto";
  const receipt = document.createElement("p");
  receipt.dataset.historyResult = "receipt";
  nested.append(receipt);
  row.append(nested);
  root.append(row);
  document.body.append(root);
  Object.defineProperties(nested, {
    clientHeight: { value: 100 },
    scrollHeight: { value: 500 },
  });
  root.getBoundingClientRect = () => new DOMRect(0, 0, 800, 600);
  row.getBoundingClientRect = () =>
    new DOMRect(0, 40 - root.scrollTop, 800, 200);
  receipt.getBoundingClientRect = () =>
    new DOMRect(0, 50 - root.scrollTop - nested.scrollTop, 800, 20);
  row.getClientRects = () =>
    [row.getBoundingClientRect()] as unknown as DOMRectList;
  receipt.getClientRects = () =>
    [receipt.getBoundingClientRect()] as unknown as DOMRectList;
  const pinned = { current: false };
  const lastScrollTop = { current: 0 };
  const { rerender } = renderHook(() =>
    useReadingAnchor({ current: root }, pinned, "session", lastScrollTop),
  );
  nested.scrollTop = 30;
  rerender();
  expect(root.scrollTop).toBe(0);
  expect(nested.scrollTop).toBe(30);
});

it("drops an old anchor when its message disappears or the Session changes", () => {
  const root = document.createElement("div");
  const row = document.createElement("article");
  row.dataset.historyMessage = "message";
  root.append(row);
  document.body.append(root);
  let offset = 40;
  root.getBoundingClientRect = () => new DOMRect(0, 0, 800, 600);
  row.getBoundingClientRect = () =>
    new DOMRect(0, offset - root.scrollTop, 800, 100);
  row.getClientRects = () =>
    [row.getBoundingClientRect()] as unknown as DOMRectList;
  const pinned = { current: false };
  const { result, rerender } = renderHook(
    ({ scope }) =>
      useReadingAnchor({ current: root }, pinned, scope, { current: 0 }),
    { initialProps: { scope: "first" } },
  );
  offset = 100;
  rerender({ scope: "second" });
  expect(root.scrollTop).toBe(0);
  row.remove();
  act(() => result.current.restore());
  expect(root.scrollTop).toBe(0);
});
