import type { RefObject } from "react";
import { useCallback, useLayoutEffect, useRef } from "react";

const landmarks =
  "[data-history-entry], [data-history-message], [data-history-result]";

/** Keep the same visible message under the reader as surrounding rows resize. */
export function useReadingAnchor(
  viewport: RefObject<HTMLElement | null>,
  pinned: RefObject<boolean>,
  scope: string,
  lastScrollTop: RefObject<number>,
) {
  const saved = useRef<{
    scope: string;
    element: HTMLElement;
    offset: number;
  } | null>(null);
  const capture = useCallback(() => {
    const root = viewport.current;
    if (!root || pinned.current) {
      saved.current = null;
      return;
    }
    const bounds = root.getBoundingClientRect();
    const visible = Array.from(
      root.querySelectorAll<HTMLElement>(landmarks),
    ).filter((item) => {
      const rect = item.getBoundingClientRect();
      if (
        rect.height <= 0 ||
        rect.bottom <= bounds.top ||
        rect.top >= bounds.bottom
      )
        return false;
      // Nested tool/thinking scrollports own their own reading position. Anchor
      // their outer row so scrolling inside them cannot move this conversation.
      for (
        let parent = item.parentElement;
        parent && parent !== root;
        parent = parent.parentElement
      ) {
        if (parent.hidden) return false;
        const style = getComputedStyle(parent);
        if (
          /^(auto|scroll|overlay)$/.test(style.overflowY) &&
          parent.scrollHeight > parent.clientHeight
        )
          return false;
      }
      return true;
    });
    const element = visible.find(
      (item) =>
        !visible.some((child) => child !== item && item.contains(child)),
    );
    saved.current = element
      ? {
          scope,
          element,
          offset: element.getBoundingClientRect().top - bounds.top,
        }
      : null;
  }, [viewport, pinned, scope]);
  const restore = useCallback(() => {
    const root = viewport.current;
    const anchor = saved.current;
    if (!root || pinned.current || !anchor || anchor.scope !== scope) return;
    if (
      !root.contains(anchor.element) ||
      !anchor.element.getClientRects().length
    ) {
      saved.current = null;
      return;
    }
    const delta =
      anchor.element.getBoundingClientRect().top -
      root.getBoundingClientRect().top -
      anchor.offset;
    if (Math.abs(delta) > 0.5) {
      const top = root.scrollTop + delta;
      if (typeof root.scrollTo === "function")
        root.scrollTo({ top, behavior: "instant" });
      else root.scrollTop = top;
      lastScrollTop.current = root.scrollTop;
    }
  }, [viewport, pinned, scope, lastScrollTop]);
  useLayoutEffect(() => {
    restore();
    capture();
  });
  const clear = useCallback(() => {
    saved.current = null;
  }, []);
  return { capture, restore, clear };
}
