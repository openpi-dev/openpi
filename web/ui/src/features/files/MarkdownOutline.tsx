import { ListTree } from "lucide-react";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";

export function MarkdownOutline({
  children,
  text,
}: {
  children: ReactNode;
  text: string;
}) {
  const { t } = useTranslation();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLElement>(null);
  const id = useId();
  const [open, setOpen] = useState(false);
  const [headings, setHeadings] = useState<HTMLElement[]>([]);
  const [active, setActive] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    void text;
    const found = [
      ...(root.current?.querySelectorAll<HTMLElement>(
        ".markdown h1, .markdown h2, .markdown h3, .markdown h4, .markdown h5, .markdown h6",
      ) ?? []),
    ].filter((heading) => heading.textContent?.trim());
    setHeadings(found);
    const container = root.current?.closest(".artifact-panel-body");
    const update = () => {
      const top = container?.getBoundingClientRect().top ?? 0;
      setActive(
        found
          .filter((heading) => heading.getBoundingClientRect().top <= top + 56)
          .at(-1) ??
          found[0] ??
          null,
      );
    };
    update();
    container?.addEventListener("scroll", update, { passive: true });
    return () => container?.removeEventListener("scroll", update);
  }, [text]);
  useEffect(() => {
    if (!open) return;
    popup.current?.querySelector("button")?.focus();
    const dismiss = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !popup.current?.contains(event.target)
      )
        setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open]);
  const jump = (heading: HTMLElement) => {
    let ancestor = heading.parentElement;
    while (ancestor && ancestor !== root.current) {
      if (ancestor instanceof HTMLDetailsElement) ancestor.open = true;
      ancestor = ancestor.parentElement;
    }
    const container = root.current?.closest(".artifact-panel-body");
    if (container)
      container.scrollTo({
        top:
          container.scrollTop +
          heading.getBoundingClientRect().top -
          container.getBoundingClientRect().top -
          16,
        behavior: "instant",
      });
    setActive(heading);
    setOpen(false);
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
  };
  return (
    <div className="file-markdown" ref={root}>
      {headings.length > 1 && (
        <div className="file-outline-bar">
          <section
            className="file-outline"
            aria-label={t("filesOutline")}
            ref={popup}
            onKeyDown={(event) => {
              if (event.key === "Escape" && open) {
                event.preventDefault();
                event.stopPropagation();
                setOpen(false);
                button.current?.focus();
              }
            }}
          >
            <button
              type="button"
              ref={button}
              className="icon-button"
              title={t("filesOutline")}
              aria-label={t("filesOutline")}
              aria-expanded={open}
              aria-controls={id}
              onClick={() => setOpen((value) => !value)}
            >
              <ListTree aria-hidden="true" />
            </button>
            {open && (
              <nav
                id={id}
                aria-label={t("filesOutline")}
                className="file-outline-panel"
              >
                {headings.map((heading, index) => (
                  <button
                    // biome-ignore lint/suspicious/noArrayIndexKey: Stateless entries map a complete, immutable DOM heading snapshot; duplicate titles are valid.
                    key={`${index}:${heading.textContent}`}
                    type="button"
                    aria-current={active === heading ? "location" : undefined}
                    style={{
                      paddingInlineStart:
                        10 + (Number(heading.tagName.slice(1)) - 1) * 10,
                    }}
                    onClick={() => jump(heading)}
                  >
                    <small aria-hidden="true">{heading.tagName.slice(1)}</small>
                    <span>{heading.textContent}</span>
                  </button>
                ))}
              </nav>
            )}
          </section>
        </div>
      )}
      {children}
    </div>
  );
}
