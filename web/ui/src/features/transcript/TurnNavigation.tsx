import { useHoverCard } from "@astryxdesign/core/HoverCard";
import {
  type RefObject,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import "./turn-navigation.css";

export interface TurnNavigationItem {
  entryId: string;
  title: string;
  reply?: string;
  previewState?: "idle" | "loading" | "ready" | "unavailable";
}

function TurnTick({
  item,
  position,
  current,
  onNavigate,
  onPreview,
}: {
  item: TurnNavigationItem;
  position: number;
  current: boolean;
  onNavigate: (entryId: string) => void;
  onPreview: (entryId: string, hide: () => void) => void;
}) {
  const { t } = useTranslation();
  const hide = useRef<() => void>(() => {});
  const onShow = useCallback(
    () => onPreview(item.entryId, () => hide.current()),
    [item.entryId, onPreview],
  );
  const preview = useHoverCard({
    placement: "start",
    delay: 150,
    hideDelay: 100,
    touchTrigger: "none",
    onShow,
  });
  hide.current = preview.hide;
  return (
    <>
      <button
        ref={preview.ref}
        className="turn-tick"
        type="button"
        data-turn-entry={item.entryId}
        aria-label={t("conversationTurnPosition", { position })}
        aria-describedby={preview.describedBy}
        aria-current={current ? "location" : undefined}
        onClick={() => {
          preview.hide();
          onNavigate(item.entryId);
        }}
      >
        <span className="turn-tick-mark" aria-hidden="true" />
      </button>
      {preview.renderHoverCard(
        <span className="turn-preview">
          {item.previewState === "idle" || item.previewState === "loading" ? (
            <span role="status">{t("turnPreviewLoading")}</span>
          ) : item.previewState === "unavailable" ? (
            <span role="status">{t("turnPreviewUnavailable")}</span>
          ) : (
            <>
              <span className="turn-preview-prompt">{item.title}</span>
              {item.reply && (
                <span className="turn-preview-reply">{item.reply}</span>
              )}
            </>
          )}
        </span>,
        { className: "turn-preview-layer" },
      )}
    </>
  );
}

export function TurnNavigation({
  items,
  viewport,
  onNavigate,
  readingHistory,
  onRequestPreview,
  enabled = true,
  onHidden,
}: {
  items: TurnNavigationItem[];
  viewport: RefObject<HTMLElement | null>;
  onNavigate: (
    entryId: string,
    scrub?: boolean,
  ) => void | boolean | Promise<boolean | void>;
  readingHistory: boolean;
  onRequestPreview?: (entryId: string) => void;
  enabled?: boolean;
  onHidden?: () => void;
}) {
  const { t } = useTranslation();
  const rail = useRef<HTMLElement>(null);
  const itemIdentity = JSON.stringify(items.map((item) => item.entryId));
  const previousPreview = useRef<{ entryId: string; hide: () => void } | null>(
    null,
  );
  const scrub = useRef<{
    pointerId: number;
    captureTarget: HTMLElement;
    y: number;
    entryId?: string;
    moved: boolean;
  } | null>(null);
  const suppressClick = useRef(false);
  const navigationSequence = useRef(0);
  const [error, setError] = useState(false);
  const [layout, setLayout] = useState({
    top: 0,
    height: 0,
    visible: false,
    current: [] as string[],
  });
  const close = useCallback(() => {
    previousPreview.current?.hide();
    previousPreview.current = null;
    if (
      scrub.current &&
      scrub.current.captureTarget.hasPointerCapture?.(scrub.current.pointerId)
    )
      scrub.current.captureTarget.releasePointerCapture(
        scrub.current.pointerId,
      );
    scrub.current = null;
    navigationSequence.current++;
    onHidden?.();
  }, [onHidden]);
  const onPreview = useCallback(
    (entryId: string, hide: () => void) => {
      if (
        !enabled ||
        !viewport.current ||
        !rail.current ||
        rail.current.style.visibility === "hidden" ||
        viewport.current.checkVisibility?.() === false ||
        rail.current.checkVisibility?.() === false ||
        getComputedStyle(viewport.current).display === "none" ||
        getComputedStyle(rail.current).display === "none"
      ) {
        hide();
        return;
      }
      if (previousPreview.current?.entryId !== entryId)
        previousPreview.current?.hide();
      previousPreview.current = { entryId, hide };
      onRequestPreview?.(entryId);
    },
    [enabled, viewport, onRequestPreview],
  );
  const navigate = useCallback(
    (entryId: string, dragging = false) => {
      previousPreview.current?.hide();
      const request = ++navigationSequence.current;
      setError(false);
      void Promise.resolve(onNavigate(entryId, dragging)).then((result) => {
        if (navigationSequence.current === request && result === false)
          setError(true);
      });
    },
    [onNavigate],
  );

  useLayoutEffect(() => {
    const root = viewport.current;
    const parent = root?.parentElement;
    const entryIds: string[] = JSON.parse(itemIdentity);
    if (!root || !parent) {
      close();
      return;
    }
    let frame: number | undefined;
    const jump = readingHistory
      ? parent.querySelector<HTMLElement>(".jump-to-latest")
      : null;
    const measure = () => {
      frame = undefined;
      const bounds = root.getBoundingClientRect();
      const parentBounds = parent.getBoundingClientRect();
      const targets = new Map<string, HTMLElement>();
      for (const target of root.querySelectorAll<HTMLElement>(
        "[data-history-entry]",
      )) {
        const id = target.dataset.historyEntry;
        if (id && !targets.has(id)) targets.set(id, target);
      }
      const content =
        root.querySelector<HTMLElement>(".conversation-turn") ??
        targets.values().next().value;
      const scale = root.offsetWidth > 0 ? bounds.width / root.offsetWidth : 1;
      const visible =
        enabled &&
        bounds.height > 0 &&
        scale > 0 &&
        !!content &&
        (bounds.right - content.getBoundingClientRect().right) / scale >= 48 &&
        root.checkVisibility?.() !== false &&
        getComputedStyle(root).display !== "none" &&
        (!rail.current || getComputedStyle(rail.current).display !== "none");
      if (!visible) close();
      const jumpBounds = jump?.getBoundingClientRect();
      const bottom = Math.min(
        bounds.bottom - 8,
        jumpBounds && jumpBounds.height > 0 ? jumpBounds.top - 12 : Infinity,
      );
      const availableHeight = Math.max(0, bottom - bounds.top - 8);
      const current = entryIds.flatMap((entryId) => {
        const target = targets.get(entryId);
        if (!target) return [];
        const turn =
          target.closest<HTMLElement>(".conversation-turn") ?? target;
        const rect = turn.getBoundingClientRect();
        return rect.bottom > bounds.top + 16 && rect.top < bounds.bottom
          ? [entryId]
          : [];
      });
      const next = {
        top: bounds.top - parentBounds.top + 8 + availableHeight / 2,
        height: Math.min(availableHeight, window.innerHeight * 0.7, 640),
        visible,
        current,
      };
      setLayout((previous) =>
        previous.top === next.top &&
        previous.height === next.height &&
        previous.visible === visible &&
        previous.current.join("\0") === current.join("\0")
          ? previous
          : next,
      );
    };
    const schedule = () => {
      if (frame === undefined) frame = requestAnimationFrame(measure);
    };
    measure();
    root.addEventListener("scroll", schedule);
    window.addEventListener("resize", schedule);
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(schedule);
    observer?.observe(root);
    observer?.observe(parent);
    if (jump) observer?.observe(jump);
    for (const child of root.children) observer?.observe(child);
    const mutation = new MutationObserver(schedule);
    mutation.observe(root, { childList: true, subtree: true });
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      root.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      observer?.disconnect();
      mutation.disconnect();
    };
  }, [itemIdentity, viewport, readingHistory, enabled, close]);

  useLayoutEffect(() => {
    void itemIdentity;
    void layout.height;
    if (!layout.visible || scrub.current) return;
    const root = rail.current;
    const ticks = Array.from(
      root?.querySelectorAll<HTMLElement>("[data-turn-entry]") ?? [],
    );
    const active =
      ticks.find((item) => item === document.activeElement) ??
      ticks.find((item) => item.matches(":hover")) ??
      ticks.find((item) =>
        layout.current.includes(item.dataset.turnEntry ?? ""),
      );
    if (!root || !active) return;
    const bounds = root.getBoundingClientRect();
    const rect = active.getBoundingClientRect();
    if (rect.top < bounds.top) root.scrollTop -= bounds.top - rect.top;
    else if (rect.bottom > bounds.bottom)
      root.scrollTop += rect.bottom - bounds.bottom;
  }, [layout.current, layout.height, layout.visible, itemIdentity]);

  useLayoutEffect(() => {
    const root = viewport.current;
    if (!root) return;
    const onKey = (event: KeyboardEvent) => {
      if (
        !enabled ||
        event.defaultPrevented ||
        event.isComposing ||
        !event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        !["ArrowUp", "ArrowDown"].includes(event.key) ||
        !root.parentElement?.contains(document.activeElement) ||
        root.checkVisibility?.() === false ||
        getComputedStyle(root).display === "none" ||
        getComputedStyle(root).visibility === "hidden" ||
        root.getBoundingClientRect().height <= 0
      )
        return;
      const targets = new Map<string, HTMLElement>();
      for (const element of root.querySelectorAll<HTMLElement>(
        "[data-history-entry]",
      )) {
        const id = element.dataset.historyEntry;
        if (id && !targets.has(id)) targets.set(id, element);
      }
      const measured = items.flatMap((item, index) => {
        const element = targets.get(item.entryId);
        return element
          ? [{ item, index, top: element.getBoundingClientRect().top }]
          : [];
      });
      const top = root.getBoundingClientRect().top;
      let target: TurnNavigationItem | undefined;
      if (event.key === "ArrowDown") {
        const next = measured.findIndex((item) => item.top > top + 24);
        target =
          measured.length === 0
            ? items[0]
            : next < 0
              ? items[measured.at(-1)!.index + 1]
              : items[(measured[next - 1]?.index ?? -1) + 1];
      } else {
        for (let index = measured.length - 1; index >= 0; index--) {
          const item = measured[index]!;
          if (Math.abs(item.top - top) <= 24) {
            target = items[item.index - 1];
            break;
          }
          if (item.top < top) {
            target = item.item;
            break;
          }
        }
        if (!target && measured.every((item) => item.top > top + 24))
          target = measured[0]?.item;
        if (measured.length === 0) target = items.at(-1);
      }
      if (!target) return;
      event.preventDefault();
      navigate(target.entryId);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [viewport, enabled, items, navigate]);
  useLayoutEffect(() => () => close(), [close]);

  if (items.length < 4) return null;
  return (
    <>
      <nav
        ref={rail}
        className="turn-rail"
        aria-label={t("conversationTurns")}
        style={{
          top: layout.top,
          maxHeight: layout.height,
          visibility: layout.visible ? "visible" : "hidden",
        }}
        onClickCapture={(event) => {
          if (suppressClick.current) {
            event.preventDefault();
            event.stopPropagation();
            suppressClick.current = false;
          }
        }}
        onPointerDown={(event) => {
          if (!event.isPrimary || event.button !== 0) return;
          const captureTarget =
            event.target instanceof Element
              ? event.target.closest<HTMLElement>(".turn-tick")
              : null;
          if (!captureTarget || !event.currentTarget.contains(captureTarget))
            return;
          suppressClick.current = false;
          scrub.current = {
            pointerId: event.pointerId,
            captureTarget,
            y: event.clientY,
            moved: false,
          };
          captureTarget.setPointerCapture?.(event.pointerId);
        }}
        onPointerMove={(event) => {
          const state = scrub.current;
          if (!state || state.pointerId !== event.pointerId) return;
          if (Math.abs(event.clientY - state.y) < 3 && !state.moved) return;
          state.moved = true;
          suppressClick.current = true;
          const target = Array.from(
            event.currentTarget.querySelectorAll<HTMLElement>(
              "[data-turn-entry]",
            ),
          ).find((button) => {
            const rect = button.getBoundingClientRect();
            return event.clientY >= rect.top && event.clientY < rect.bottom;
          });
          const id = target?.dataset.turnEntry;
          if (id && id !== state.entryId) {
            state.entryId = id;
            navigate(id, true);
          }
        }}
        onPointerUp={(event) => {
          const state = scrub.current;
          scrub.current = null;
          if (state?.captureTarget.hasPointerCapture?.(event.pointerId))
            state.captureTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={(event) => {
          const state = scrub.current;
          scrub.current = null;
          if (state?.captureTarget.hasPointerCapture?.(event.pointerId))
            state.captureTarget.releasePointerCapture(event.pointerId);
          suppressClick.current = false;
        }}
      >
        {items.map((item, index) => (
          <TurnTick
            key={item.entryId}
            item={item}
            position={index + 1}
            current={layout.current.includes(item.entryId)}
            onNavigate={navigate}
            onPreview={onPreview}
          />
        ))}
      </nav>
      {error && (
        <span className="turn-navigation-error" role="status">
          {t("turnPreviewUnavailable")}
        </span>
      )}
    </>
  );
}
