import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Globe2,
  RefreshCw,
  X,
} from "lucide-react";
import {
  type FormEvent,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import {
  WEB_BROWSER_TEXT_MAX_LENGTH,
  type WebEmbeddedBrowserState,
} from "../../../../protocol/types.ts";
import { WebApiError, WebClient } from "../../protocol/client.ts";

function normalizedBrowserUrl(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const explicitScheme = /^[a-z][a-z\d+.-]*:\/\//iu.test(trimmed);
  const candidate = explicitScheme ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(candidate);
    if (
      !explicitScheme &&
      (url.hostname === "localhost" ||
        url.hostname.endsWith(".localhost") ||
        url.hostname === "[::1]" ||
        /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(url.hostname))
    )
      return new URL(`http://${trimmed}`).toString();
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

const editingKeys = new Set([
  "a",
  "z",
  "y",
  "arrowleft",
  "arrowright",
  "arrowup",
  "arrowdown",
  "backspace",
  "delete",
  "home",
  "end",
]);
function forwardedKeyModifiers(event: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}) {
  // Clipboard shortcuts must stay in the host browser so paste can supply the
  // clipboard text; browser-window shortcuts must not be swallowed by the pane.
  if (
    (event.ctrlKey || event.metaKey || event.altKey) &&
    !editingKeys.has(event.key.toLowerCase())
  )
    return null;
  return (
    (event.altKey ? 1 : 0) |
    (event.ctrlKey ? 2 : 0) |
    (event.metaKey ? 4 : 0) |
    (event.shiftKey ? 8 : 0)
  );
}

export const EmbeddedBrowserPanel = memo(function EmbeddedBrowserPanel({
  sessionId,
  active,
}: {
  sessionId: string;
  active: boolean;
}) {
  const { t } = useTranslation();
  const client = useMemo(() => new WebClient(), []);
  const abort = useRef<AbortController | null>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const frameImage = useRef<HTMLImageElement>(null);
  const frameUrl = useRef<string | null>(null);
  const stateRef = useRef<WebEmbeddedBrowserState | null>(null);
  const addressEditing = useRef(false);
  const addressDirty = useRef(false);
  const pointerMovePoint = useRef<{ x: number; y: number } | null>(null);
  const pointerMoveSending = useRef(false);
  const pointerMoveEnabled = useRef(active);
  const storageKey = `openpi.browser.${sessionId}`;
  const initial = (() => {
    try {
      return (
        normalizedBrowserUrl(sessionStorage.getItem(storageKey) ?? "") ?? ""
      );
    } catch {
      return "";
    }
  })();
  const [draft, setDraft] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<WebEmbeddedBrowserState | null>(null);
  const [frameReady, setFrameReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const browserStarted = state !== null;

  useEffect(
    () => () => {
      abort.current?.abort();
      if (frameUrl.current) URL.revokeObjectURL(frameUrl.current);
    },
    [],
  );

  useEffect(() => {
    pointerMoveEnabled.current = active;
    return () => {
      pointerMoveEnabled.current = false;
      pointerMovePoint.current = null;
    };
  }, [active]);

  const applyState = useCallback(
    (next: WebEmbeddedBrowserState, forceAddress = false) => {
      stateRef.current = next;
      setState(next);
      if (forceAddress || (!addressEditing.current && !addressDirty.current))
        setDraft(next.url);
    },
    [],
  );

  useEffect(() => {
    if (!active || stateRef.current) return;
    const controller = new AbortController();
    void client
      .browserState(sessionId, controller.signal)
      .then((next) => {
        addressDirty.current = false;
        applyState(next, true);
      })
      .catch((caught) => {
        if (
          controller.signal.aborted ||
          (caught instanceof WebApiError && caught.status === 404)
        )
          return;
        setError(
          caught instanceof Error ? caught.message : t("browserOpenFailed"),
        );
      });
    return () => controller.abort();
  }, [active, applyState, client, sessionId, t]);

  useEffect(() => {
    if (!active || !browserStarted) return;
    const controller = new AbortController();
    let timer = 0;
    let reconnect = 0;
    let pending:
      | import("../../../../protocol/types.ts").WebBrowserFrame
      | undefined;
    let decoding = false;
    let decodingUrl: string | undefined;
    const paint = async () => {
      if (decoding || !pending || controller.signal.aborted) return;
      decoding = true;
      const next = pending;
      pending = undefined;
      try {
        const bytes = Uint8Array.from(atob(next.data), (character) =>
          character.charCodeAt(0),
        );
        const url = URL.createObjectURL(
          new Blob([bytes], { type: next.mimeType }),
        );
        decodingUrl = url;
        const image = new Image();
        image.src = url;
        await image.decode();
        if (!controller.signal.aborted && frameImage.current) {
          const previous = frameUrl.current;
          frameImage.current.src = url;
          frameUrl.current = url;
          decodingUrl = undefined;
          setFrameReady(true);
          setError(null);
          if (previous) URL.revokeObjectURL(previous);
        }
      } catch (caught) {
        if (!controller.signal.aborted)
          setError(
            caught instanceof Error ? caught.message : t("browserOpenFailed"),
          );
      } finally {
        if (decodingUrl) URL.revokeObjectURL(decodingUrl);
        decodingUrl = undefined;
        decoding = false;
        if (pending) void paint();
      }
    };
    const connect = async () => {
      try {
        await client.streamBrowserFrames(
          sessionId,
          controller.signal,
          (frame) => {
            pending = frame;
            void paint();
          },
        );
      } catch (caught) {
        if (!controller.signal.aborted)
          setError(
            caught instanceof Error ? caught.message : t("browserOpenFailed"),
          );
      } finally {
        if (!controller.signal.aborted)
          reconnect = window.setTimeout(connect, 1_000);
      }
    };
    const refreshState = async () => {
      try {
        const next = await client.browserState(sessionId, controller.signal);
        if (!controller.signal.aborted) applyState(next);
      } catch {
      } finally {
        if (!controller.signal.aborted)
          timer = window.setTimeout(refreshState, 1_000);
      }
    };
    void connect();
    void refreshState();
    return () => {
      controller.abort();
      pending = undefined;
      window.clearTimeout(timer);
      window.clearTimeout(reconnect);
      if (decodingUrl) URL.revokeObjectURL(decodingUrl);
    };
  }, [active, applyState, browserStarted, client, sessionId, t]);

  useEffect(() => {
    const element = viewport.current;
    if (
      !active ||
      !browserStarted ||
      !element ||
      typeof ResizeObserver === "undefined"
    )
      return;
    let timer = 0;
    const observer = new ResizeObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const bounds = element.getBoundingClientRect();
        const width = Math.max(320, Math.min(2_560, Math.round(bounds.width)));
        const height = Math.max(
          240,
          Math.min(2_560, Math.round(bounds.height)),
        );
        const current = stateRef.current;
        if (!current || (width === current.width && height === current.height))
          return;
        void client
          .browserAction(sessionId, {
            type: "resize",
            width,
            height,
            deviceScaleFactor: Math.max(
              1,
              Math.min(2, window.devicePixelRatio || 1),
            ),
          })
          .then((next) => applyState(next))
          .catch(() => undefined);
      }, 160);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      window.clearTimeout(timer);
    };
  }, [active, applyState, browserStarted, client, sessionId]);

  const dimensions = () => {
    const bounds = viewport.current?.getBoundingClientRect();
    return {
      width: Math.max(320, Math.min(2_560, Math.round(bounds?.width ?? 1_024))),
      height: Math.max(240, Math.min(2_560, Math.round(bounds?.height ?? 768))),
      deviceScaleFactor: Math.max(1, Math.min(2, window.devicePixelRatio || 1)),
    };
  };

  const launchBrowser = async () => {
    const next = normalizedBrowserUrl(draft);
    if (!next) {
      setError(t("invalidBrowserAddress"));
      return;
    }
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    setDraft(next);
    setError(null);
    try {
      sessionStorage.setItem(storageKey, next);
    } catch {}
    try {
      const opened = await client.openBrowser(
        sessionId,
        next,
        dimensions(),
        controller.signal,
      );
      if (!controller.signal.aborted) {
        addressDirty.current = false;
        applyState(opened, true);
      }
    } catch (caught) {
      if (!controller.signal.aborted) {
        setError(
          caught instanceof Error ? caught.message : t("browserOpenFailed"),
        );
      }
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };

  const navigate = (event: FormEvent) => {
    event.preventDefault();
    void launchBrowser();
  };

  const action = useCallback(
    async (
      browserAction: Parameters<WebClient["browserAction"]>[1],
      syncAddress = false,
    ) => {
      try {
        const next = await client.browserAction(sessionId, browserAction);
        if (["mouse", "key", "text"].includes(browserAction.type)) {
          setError(null);
          return;
        }
        if (syncAddress) addressDirty.current = false;
        applyState(next, syncAddress);
        setError(null);
      } catch (caught) {
        setError(
          caught instanceof Error ? caught.message : t("browserOpenFailed"),
        );
      }
    },
    [applyState, client, sessionId, t],
  );

  const browserPoint = useCallback(
    (event: { clientX: number; clientY: number }) => {
      const bounds = viewport.current?.getBoundingClientRect();
      const current = stateRef.current;
      if (!bounds || !current || !bounds.width || !bounds.height) return null;
      return {
        x: Math.max(
          0,
          Math.min(
            current.width,
            ((event.clientX - bounds.left) / bounds.width) * current.width,
          ),
        ),
        y: Math.max(
          0,
          Math.min(
            current.height,
            ((event.clientY - bounds.top) / bounds.height) * current.height,
          ),
        ),
      };
    },
    [],
  );

  const flushPointerMove = useCallback(async () => {
    if (
      !pointerMoveEnabled.current ||
      pointerMoveSending.current ||
      !pointerMovePoint.current
    )
      return;
    const point = pointerMovePoint.current;
    pointerMovePoint.current = null;
    pointerMoveSending.current = true;
    try {
      await action({ type: "mouse", event: "move", ...point });
    } finally {
      pointerMoveSending.current = false;
      if (pointerMoveEnabled.current && pointerMovePoint.current)
        void flushPointerMove();
    }
  }, [action]);

  useEffect(() => {
    const element = viewport.current;
    if (!active || !browserStarted || !element) return;
    let disposed = false;
    let sending = false;
    let pending: {
      x: number;
      y: number;
      deltaX: number;
      deltaY: number;
    } | null = null;
    const flush = async () => {
      if (disposed || sending || !pending) return;
      const next = pending;
      pending = null;
      sending = true;
      try {
        await action({ type: "mouse", event: "wheel", ...next });
      } finally {
        sending = false;
        if (!disposed && pending) void flush();
      }
    };
    const wheel = (event: WheelEvent) => {
      const point = browserPoint(event);
      if (!point) return;
      event.preventDefault();
      const unit =
        event.deltaMode === 1
          ? 16
          : event.deltaMode === 2
            ? element.clientHeight
            : 1;
      pending = {
        ...point,
        deltaX: Math.max(
          -10_000,
          Math.min(10_000, (pending?.deltaX ?? 0) + event.deltaX * unit),
        ),
        deltaY: Math.max(
          -10_000,
          Math.min(10_000, (pending?.deltaY ?? 0) + event.deltaY * unit),
        ),
      };
      void flush();
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => {
      disposed = true;
      pending = null;
      element.removeEventListener("wheel", wheel);
    };
  }, [active, action, browserPoint, browserStarted]);

  return (
    <div className="browser-tool">
      <form className="browser-toolbar" onSubmit={navigate}>
        <button
          type="button"
          aria-label={t("browserBack")}
          title={t("browserBack")}
          disabled={!state?.canGoBack}
          onClick={() => void action({ type: "back" })}
        >
          <ArrowLeft aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label={t("browserForward")}
          title={t("browserForward")}
          disabled={!state?.canGoForward}
          onClick={() => void action({ type: "forward" })}
        >
          <ArrowRight aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label={t(state?.loading ? "stop" : "browserReload")}
          title={t(state?.loading ? "stop" : "browserReload")}
          disabled={!state}
          onClick={() =>
            void action({ type: state?.loading ? "stop" : "reload" }, true)
          }
        >
          {state?.loading ? (
            <X aria-hidden="true" />
          ) : (
            <RefreshCw aria-hidden="true" />
          )}
        </button>
        <input
          aria-label={t("browserAddress")}
          value={draft}
          placeholder="https://"
          onChange={(event) => {
            addressDirty.current = true;
            setDraft(event.currentTarget.value);
          }}
          onFocus={() => {
            addressEditing.current = true;
          }}
          onBlur={() => {
            addressEditing.current = false;
          }}
        />
        <button
          type="submit"
          aria-label={t("browserGo")}
          title={t("browserGo")}
          disabled={busy || !draft.trim()}
        >
          <ArrowRight aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label={t("openExternalBrowser")}
          title={t("openExternalBrowser")}
          disabled={!state?.url}
          onClick={() =>
            state?.url &&
            window.open(state.url, "_blank", "noopener,noreferrer")
          }
        >
          <ExternalLink aria-hidden="true" />
        </button>
      </form>
      {error && <p className="workbar-error">{error}</p>}
      <div
        ref={viewport}
        className="browser-viewport"
        tabIndex={state ? 0 : -1}
        role="application"
        aria-label={state?.title || t("browser")}
        aria-busy={state?.loading || undefined}
        onPaste={(event) => {
          if (!state) return;
          const text = event.clipboardData.getData("text/plain");
          if (!text) return;
          event.preventDefault();
          event.stopPropagation();
          if (text.length > WEB_BROWSER_TEXT_MAX_LENGTH) {
            setError(
              t("browserPasteTooLarge", { count: WEB_BROWSER_TEXT_MAX_LENGTH }),
            );
            return;
          }
          void action({ type: "text", text });
        }}
        onPointerDown={(event) => {
          const point = browserPoint(event);
          if (!point) return;
          event.currentTarget.focus();
          void action({
            type: "mouse",
            event: "down",
            button: "left",
            ...point,
          });
        }}
        onPointerUp={(event) => {
          const point = browserPoint(event);
          if (!point) return;
          void action({
            type: "mouse",
            event: "up",
            button: "left",
            ...point,
          });
        }}
        onPointerMove={(event) => {
          const point = browserPoint(event);
          if (!point) return;
          pointerMovePoint.current = point;
          void flushPointerMove();
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
          const modifiers = forwardedKeyModifiers(event);
          if (!state || modifiers === null || event.nativeEvent.isComposing)
            return;
          event.preventDefault();
          void action({
            type: "key",
            event: "down",
            key: event.key,
            code: event.code,
            modifiers,
            ...(event.key.length === 1 && !(modifiers & 7)
              ? { text: event.key }
              : {}),
          });
        }}
        onKeyUp={(event) => {
          event.stopPropagation();
          const modifiers = forwardedKeyModifiers(event);
          if (!state || modifiers === null || event.nativeEvent.isComposing)
            return;
          event.preventDefault();
          void action({
            type: "key",
            event: "up",
            key: event.key,
            code: event.code,
            modifiers,
          });
        }}
      >
        <img
          ref={frameImage}
          hidden={!frameReady}
          alt={state?.title || state?.url || t("browser")}
          draggable={false}
        />
        {!frameReady && (
          <div className="browser-empty">
            <Globe2 aria-hidden="true" />
            <h3>{t(busy ? "browserStarting" : "browserReady")}</h3>
            <p>{state?.url || t("workbarBrowserDescription")}</p>
          </div>
        )}
        {state?.loading && <span className="browser-loading-line" />}
      </div>
    </div>
  );
});
