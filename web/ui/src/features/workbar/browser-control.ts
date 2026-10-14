import { useEffect, useRef } from "react";
import type { BrowserRequest } from "../../../../../extensions/browser/web-bridge.ts";
import { WebClient } from "../../protocol/client.ts";
import { browserAddress } from "./browser-address.ts";

function connectedPages() {
  return document.documentElement.dataset.openpiBrowserExtension === "ready"
    ? [
        ...document.querySelectorAll<HTMLIFrameElement>(
          "iframe[data-openpi-browser-document]",
        ),
      ].map((frame) => ({
        id: frame.dataset.openpiBrowserPage!,
        document: frame.dataset.openpiBrowserDocument!,
        url: frame.dataset.openpiBrowserUrl!,
        title: frame.dataset.openpiBrowserTitle || "",
      }))
    : [];
}

export function useBrowserControl(
  sessionId: string | undefined,
  sessionPath: string | undefined,
  onOpen: (
    url: string,
    signal: AbortSignal,
  ) => string | undefined | Promise<string | undefined>,
) {
  const open = useRef(onOpen);
  const connectorSeen = useRef(0);
  open.current = onOpen;
  useEffect(() => {
    if (!sessionId || !sessionPath) return;
    const client = new WebClient();
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let active: string | undefined;
    let stopOpen: (() => void) | undefined;
    const post = (message: Record<string, unknown>) =>
      window.postMessage(
        { source: "openpi-browser-ui", ...message },
        location.origin,
      );
    const cancel = () => {
      stopOpen?.();
      stopOpen = undefined;
      if (active) post({ type: "control-cancel", requestId: active });
      active = undefined;
    };
    const reply = (requestId: string, result?: unknown, error?: string) => {
      if (requestId !== active) return;
      stopOpen?.();
      stopOpen = undefined;
      active = undefined;
      void client
        .request("/api/browser/control", {
          method: "POST",
          signal: abort.signal,
          body: JSON.stringify({
            sessionId,
            sessionPath,
            requestId,
            result,
            error,
            pages: connectedPages(),
          }),
        })
        .catch(() => {});
    };
    const receive = (event: MessageEvent) => {
      const message = event.data;
      if (
        event.source === window &&
        event.origin === location.origin &&
        message?.source === "openpi-browser-extension"
      ) {
        if (message.type === "connector-hello")
          connectorSeen.current = Date.now();
        else if (message.type === "control-result")
          reply(message.requestId, message.result, message.error);
      }
    };
    const openPage = async (
      requestId: string,
      requestedUrl: string | undefined,
    ) => {
      const url = browserAddress(requestedUrl || "", location.origin);
      if (!url) {
        reply(requestId, undefined, "Invalid internal browser URL.");
        return;
      }
      const opening = new AbortController();
      stopOpen = () => opening.abort();
      const containerId = await open.current(
        url,
        AbortSignal.any([abort.signal, opening.signal]),
      );
      if (abort.signal.aborted || active !== requestId) return;
      if (!containerId) {
        reply(
          requestId,
          undefined,
          "The internal browser has reached its page limit.",
        );
        return;
      }
      const inspect = () => {
        const frame = document
          .getElementById(containerId)
          ?.querySelector<HTMLIFrameElement>(
            "iframe[data-openpi-browser-document]",
          );
        const created =
          frame &&
          connectedPages().find(
            (page) => page.id === frame.dataset.openpiBrowserPage,
          );
        if (created) reply(requestId, { root: created.id });
      };
      const observer = new MutationObserver(inspect);
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["data-openpi-browser-document"],
      });
      const timeout = setTimeout(
        () =>
          reply(
            requestId,
            undefined,
            "The internal page did not bind. Inspect the browser's loading or embedding error.",
          ),
        10000,
      );
      stopOpen = () => {
        opening.abort();
        observer.disconnect();
        clearTimeout(timeout);
      };
      inspect();
    };
    const poll = async () => {
      // Presence only gates transport traffic; the host still owns all grants.
      // Ordinary iframe browsing without the optional extension needs no API polling.
      if (
        Date.now() - connectorSeen.current > 15_000 &&
        document.documentElement.dataset.openpiBrowserExtension !== "ready"
      ) {
        cancel();
        if (!abort.signal.aborted) timer = setTimeout(() => void poll(), 1000);
        return;
      }
      try {
        const { pending } = await client.request<{
          pending: null | {
            requestId: string;
            running?: boolean;
            page?: { id: string; document: string };
            request?: BrowserRequest;
          };
        }>("/api/browser/control", {
          method: "POST",
          signal: abort.signal,
          body: JSON.stringify({
            sessionId,
            sessionPath,
            pages: connectedPages(),
          }),
        });
        if (active && active !== pending?.requestId) cancel();
        if (pending && !pending.running && pending.request && !active) {
          active = pending.requestId;
          if (pending.request.operation === "open")
            void openPage(pending.requestId, pending.request.url).catch(() =>
              reply(
                pending.requestId,
                undefined,
                "The embedded browser could not open.",
              ),
            );
          else if (pending.page)
            post({
              type: "control",
              id: pending.page.id,
              document: pending.page.document,
              requestId: pending.requestId,
              request: pending.request,
            });
          else
            reply(
              pending.requestId,
              undefined,
              "The embedded page is unavailable.",
            );
        }
      } catch {
        cancel();
      }
      if (!abort.signal.aborted) timer = setTimeout(() => void poll(), 250);
    };
    window.addEventListener("message", receive);
    void poll();
    return () => {
      clearTimeout(timer);
      abort.abort();
      cancel();
      window.removeEventListener("message", receive);
    };
  }, [sessionId, sessionPath]);
}
