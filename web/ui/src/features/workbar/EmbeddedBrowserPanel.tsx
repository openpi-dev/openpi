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
  const candidate = /^https?:\/\//iu.test(value.trim())
    ? value.trim()
    : `https://${value.trim()}`;
  try {
    const url = new URL(candidate);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

export function EmbeddedBrowserPanel({
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
  const frameUrl = useRef<string | null>(null);
  const stateRef = useRef<WebEmbeddedBrowserState | null>(null);
  const addressEditing = useRef(false);
  const addressDirty = useRef(false);
  const pointerMoveTimer = useRef(0);
  const pointerMovePoint = useRef<{ x: number; y: number } | null>(null);
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
  const [frame, setFrame] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const browserStarted = state !== null;

  useEffect(
    () => () => {
      abort.current?.abort();
      window.clearTimeout(pointerMoveTimer.current);
      if (frameUrl.current) URL.revokeObjectURL(frameUrl.current);
    },
    [],
  );

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
    let ticks = 0;
    const refresh = async () => {
      try {
        const image = await client.browserFrame(sessionId, controller.signal);
        if (controller.signal.aborted || !image) return;
        const nextUrl = URL.createObjectURL(image);
        const previous = frameUrl.current;
        frameUrl.current = nextUrl;
        setFrame(nextUrl);
        if (previous) URL.revokeObjectURL(previous);
        ticks++;
        if (ticks % 4 === 0) {
          const next = await client.browserState(sessionId, controller.signal);
          if (!controller.signal.aborted) applyState(next);
        }
      } catch (caught) {
        if (!controller.signal.aborted)
          setError(
            caught instanceof Error ? caught.message : t("browserOpenFailed"),
          );
      } finally {
        if (!controller.signal.aborted) timer = window.setTimeout(refresh, 120);
      }
    };
    void refresh();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
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
          .browserAction(sessionId, { type: "resize", width, height })
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

  const action = async (
    browserAction: Parameters<WebClient["browserAction"]>[1],
    syncAddress = false,
  ) => {
    try {
      const next = await client.browserAction(sessionId, browserAction);
      if (syncAddress) addressDirty.current = false;
      applyState(next, syncAddress);
      setError(null);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : t("browserOpenFailed"),
      );
    }
  };

  const browserPoint = (event: { clientX: number; clientY: number }) => {
    const bounds = viewport.current?.getBoundingClientRect();
    const current = stateRef.current;
    if (!bounds || !current) return null;
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
  };

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
          if (pointerMoveTimer.current) return;
          pointerMoveTimer.current = window.setTimeout(() => {
            pointerMoveTimer.current = 0;
            const latest = pointerMovePoint.current;
            if (latest)
              void action({ type: "mouse", event: "move", ...latest });
          }, 60);
        }}
        onWheel={(event) => {
          const point = browserPoint(event);
          if (!point) return;
          event.preventDefault();
          void action({
            type: "mouse",
            event: "wheel",
            deltaX: event.deltaX,
            deltaY: event.deltaY,
            ...point,
          });
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (!state || event.metaKey || event.ctrlKey || event.altKey) return;
          event.preventDefault();
          void action({
            type: "key",
            event: "down",
            key: event.key,
            code: event.code,
            modifiers: event.shiftKey ? 8 : 0,
            ...(event.key.length === 1 ? { text: event.key } : {}),
          });
        }}
        onKeyUp={(event) => {
          event.stopPropagation();
          if (!state || event.metaKey || event.ctrlKey || event.altKey) return;
          event.preventDefault();
          void action({
            type: "key",
            event: "up",
            key: event.key,
            code: event.code,
            modifiers: event.shiftKey ? 8 : 0,
          });
        }}
      >
        {frame ? (
          <img
            src={frame}
            alt={state?.title || state?.url || t("browser")}
            draggable={false}
          />
        ) : (
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
}
