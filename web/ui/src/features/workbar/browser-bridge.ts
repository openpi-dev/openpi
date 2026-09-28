import { useEffect, useRef, useState } from "react";
import { browserAddress } from "./browser-address.ts";

interface BrowserPageState {
  id: string;
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
}

export function useBrowserBridge(
  id: string,
  onState: (state: BrowserPageState) => void,
  onOpen: (url: string) => void,
) {
  const callbacks = useRef({ onState, onOpen });
  callbacks.current = { onState, onOpen };
  const [page, setPage] = useState<BrowserPageState>();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const updateStatus = () => {
      const active =
        document.documentElement.dataset.openpiBrowserExtension === "ready";
      setReady(active);
      if (!active) setPage(undefined);
    };
    updateStatus();
    const observer = new MutationObserver(updateStatus);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-openpi-browser-extension"],
    });
    const receive = (event: MessageEvent) => {
      if (event.source !== window || event.origin !== location.origin) return;
      const message = event.data;
      if (
        !message ||
        message.source !== "openpi-browser-extension" ||
        message.id !== id
      )
        return;
      if (message.type === "lost") {
        setPage(undefined);
        return;
      }
      if (typeof message.url !== "string") return;
      const url = browserAddress(message.url, location.origin);
      if (!url) return;
      if (message.type === "open") callbacks.current.onOpen(url);
      if (message.type === "state" && typeof message.title === "string") {
        const state = {
          id,
          url,
          title: message.title.slice(0, 256),
          canGoBack: message.canGoBack === true,
          canGoForward: message.canGoForward === true,
        };
        setPage(state);
        callbacks.current.onState(state);
      }
    };
    window.addEventListener("message", receive);
    return () => {
      observer.disconnect();
      window.removeEventListener("message", receive);
    };
  }, [id]);
  return {
    ready,
    page: ready && page?.id === id ? page : undefined,
    command: (action: "back" | "forward" | "reload") =>
      window.postMessage(
        { source: "openpi-browser-ui", type: "command", id, action },
        location.origin,
      ),
  };
}
