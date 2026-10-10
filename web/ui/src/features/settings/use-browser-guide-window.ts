import { useCallback, useEffect, useRef, useState } from "react";

/** A second view of the same React state and controller, with the opener's lifetime. */
export function useBrowserGuideWindow() {
  const [container, setContainer] = useState<HTMLElement>();
  const owned = useRef<Window | undefined>(undefined);
  const opening = useRef(false);
  const mounted = useRef(true);
  const dispose = useRef<(() => void) | undefined>(undefined);
  const close = useCallback(() => {
    dispose.current?.();
    dispose.current = undefined;
    owned.current?.close();
    owned.current = undefined;
    if (mounted.current) setContainer(undefined);
  }, []);
  useEffect(() => {
    mounted.current = true;
    window.addEventListener("pagehide", close);
    return () => {
      mounted.current = false;
      window.removeEventListener("pagehide", close);
      close();
    };
  }, [close]);
  const open = async () => {
    if (owned.current && !owned.current.closed) {
      owned.current.focus();
      return true;
    }
    if (opening.current) return false;
    opening.current = true;
    try {
      const pip = (
        window as Window & {
          documentPictureInPicture?: {
            requestWindow: (options: {
              width: number;
              height: number;
            }) => Promise<Window>;
          };
        }
      ).documentPictureInPicture;
      const target = pip
        ? await pip.requestWindow({ width: 460, height: 740 })
        : window.open("about:blank", "_blank", "popup,width=460,height=740");
      if (!target) return false;
      if (!mounted.current) {
        target.close();
        return false;
      }
      owned.current = target;
      target.document.title = "OpenPI Browser Bridge";
      const mirror = () => {
        target.document.documentElement.lang = document.documentElement.lang;
        target.document.documentElement.dataset.theme =
          document.documentElement.dataset.theme;
        target.document.documentElement.style.cssText =
          document.documentElement.style.cssText;
      };
      mirror();
      target.document.documentElement.classList.add("browser-guide-window");
      for (const sheet of document.styleSheets) {
        try {
          const copy = target.document.createElement("style");
          copy.textContent = [...sheet.cssRules]
            .map((rule) => rule.cssText)
            .join("\n");
          target.document.head.append(copy);
        } catch {
          if (!sheet.href) continue;
          const copy = target.document.createElement("link");
          copy.rel = "stylesheet";
          copy.href = sheet.href;
          target.document.head.append(copy);
        }
      }
      const root = target.document.createElement("main");
      root.className = "browser-settings browser-settings-detached";
      target.document.body.append(root);
      const observer = new MutationObserver(mirror);
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-theme", "style", "lang"],
      });
      const closed = () => {
        observer.disconnect();
        if (owned.current === target) {
          owned.current = undefined;
          dispose.current = undefined;
          if (mounted.current) setContainer(undefined);
        }
      };
      target.addEventListener("pagehide", closed, { once: true });
      dispose.current = () => {
        observer.disconnect();
        target.removeEventListener("pagehide", closed);
      };
      setContainer(root);
      return true;
    } catch {
      close();
      return false;
    } finally {
      opening.current = false;
    }
  };
  return {
    container,
    open,
    close,
    isOpen: () => Boolean(owned.current && !owned.current.closed),
  };
}
