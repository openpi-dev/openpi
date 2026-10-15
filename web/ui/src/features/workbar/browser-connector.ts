import { useEffect } from "react";
import { isExternalBrowser } from "../../../../../extensions/shared/browser-config.ts";
import { WebClient } from "../../protocol/client.ts";

/** Pair only a live extension handshake. The extension receives a transport credential, never the Web token. */
export function useBrowserConnector() {
  useEffect(() => {
    const client = new WebClient();
    const abort = new AbortController();
    let paired: string | undefined;
    const receive = async (event: MessageEvent) => {
      const message = event.data;
      if (
        event.source !== window ||
        event.origin !== location.origin ||
        message?.source !== "openpi-browser-extension" ||
        message.type !== "connector-hello" ||
        typeof message.bridgeId !== "string" ||
        !/^[\da-f-]{36}$/.test(message.bridgeId) ||
        !isExternalBrowser(message.browser) ||
        paired === message.bridgeId
      )
        return;
      paired = message.bridgeId;
      try {
        const credentials = await client.request<{
          connectionId: string;
          token: string;
        }>("/api/browser/connections", {
          method: "POST",
          signal: abort.signal,
          body: JSON.stringify({
            browser: message.browser,
            profileId: message.profileId,
            extensionId: message.extensionId,
            extensionOrigin: message.extensionOrigin,
            version: message.version,
          }),
        });
        if (!abort.signal.aborted && paired === message.bridgeId)
          window.postMessage(
            {
              source: "openpi-browser-ui",
              type: "connector-authorize",
              ...credentials,
            },
            location.origin,
          );
      } catch {
        if (paired === message.bridgeId) paired = undefined;
      }
    };
    const probe = () =>
      window.postMessage(
        { source: "openpi-browser-ui", type: "connector-probe" },
        location.origin,
      );
    window.addEventListener("message", receive);
    probe();
    const timer = setInterval(probe, 5000);
    return () => {
      abort.abort();
      clearInterval(timer);
      window.removeEventListener("message", receive);
    };
  }, []);
}
