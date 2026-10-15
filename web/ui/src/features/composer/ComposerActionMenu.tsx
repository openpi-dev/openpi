import { type ReactNode, useEffect, useLayoutEffect, useRef } from "react";

export function ComposerActionMenu({
  items,
  onClose,
}: {
  items: Array<{
    id: string;
    section: string;
    label: string;
    alias?: string;
    description?: string;
    icon: ReactNode;
    disabled?: boolean;
    onClick: () => void;
  }>;
  onClose: (restoreFocus?: boolean) => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    menu.current
      ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
      ?.focus();
    const outside = (event: PointerEvent) => {
      if (
        !(event.target instanceof Element) ||
        menu.current?.contains(event.target) ||
        event.target.closest(".composer-context-trigger")
      )
        return;
      close.current();
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, []);
  useLayoutEffect(() => {
    const element = menu.current;
    const composer = element?.closest("form");
    if (!element || !composer) return;
    const place = () => {
      const viewport = window.visualViewport;
      const top = viewport?.offsetTop ?? 0;
      const bottom = top + (viewport?.height ?? window.innerHeight);
      const rect = composer.getBoundingClientRect();
      const above = Math.max(0, rect.top - top - 16);
      const below = Math.max(0, bottom - rect.bottom - 16);
      const useBelow = above < 180 && below > above;
      element.dataset.placement = useBelow ? "below" : "above";
      element.style.maxHeight = `${Math.min(400, useBelow ? below : above)}px`;
    };
    place();
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    observer?.observe(composer);
    window.addEventListener("resize", place);
    window.visualViewport?.addEventListener("resize", place);
    window.visualViewport?.addEventListener("scroll", place);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", place);
      window.visualViewport?.removeEventListener("resize", place);
      window.visualViewport?.removeEventListener("scroll", place);
    };
  }, []);
  return (
    <div
      ref={menu}
      id="composer-action-menu"
      className="composer-action-menu"
      role="menu"
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Escape" || event.key === "Tab") {
          if (event.key === "Escape") event.preventDefault();
          onClose(true);
        } else if (
          ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)
        ) {
          event.preventDefault();
          const buttons = [
            ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
              "button:not(:disabled)",
            ),
          ];
          const current = buttons.indexOf(
            document.activeElement as HTMLButtonElement,
          );
          const next =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? buttons.length - 1
                : (current +
                    (event.key === "ArrowUp" ? -1 : 1) +
                    buttons.length) %
                  buttons.length;
          buttons[next]?.focus();
        }
      }}
    >
      {items.map((item, index) => (
        <div role="none" key={item.id}>
          {items[index - 1]?.section !== item.section && (
            <div className="composer-action-section" role="presentation">
              {item.section}
            </div>
          )}
          <button
            type="button"
            role="menuitem"
            aria-label={[item.label, item.alias].filter(Boolean).join(" ")}
            aria-description={item.description}
            disabled={item.disabled}
            onClick={item.onClick}
            title={item.description}
          >
            {item.icon}
            <span>{item.label}</span>
            {item.alias && <small>{item.alias}</small>}
            <span className="composer-action-description">
              {item.description}
            </span>
          </button>
        </div>
      ))}
    </div>
  );
}
