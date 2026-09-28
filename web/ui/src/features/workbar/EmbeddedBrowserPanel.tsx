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
import { BrowserTextInput } from "./BrowserTextInput.tsx";

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
  const textInput = useRef<HTMLTextAreaElement>(null);
  const frameImage = useRef<HTMLImageElement>(null);
  const frameUrl = useRef<string | null>(null);
  const stateRef = useRef<WebEmbeddedBrowserState | null>(null);
  const addressEditing = useRef(false);
  const addressDirty = useRef(false);
  const addressRevision = useRef(0);
  const inputRevision = useRef(0);
  const navigationRevision = useRef(0);
  const focusRevision = useRef(0);
  const ownsInputFocus = useRef(false);
  const forwardedKeys = useRef(
    new Map<
      string,
      {
        key: string;
        code: string;
        modifiers: number;
      }
    >(),
  );
  const pointerMovePoint = useRef<{
    x: number;
    y: number;
    button?: "left" | "middle" | "right";
    buttons: number;
  } | null>(null);
  const pressedPointer = useRef<{
    id: number;
    button: "left" | "middle" | "right";
    point: { x: number; y: number };
  } | null>(null);
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
  const [addressError, setAddressError] = useState<string | null>(null);
  const [inputError, setInputError] = useState<string | null>(null);
  const [frameError, setFrameError] = useState<string | null>(null);
  const [focusReceipt, setFocusReceipt] = useState<number | null>(null);
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
        if (controller.signal.aborted || stateRef.current) return;
        applyState(next);
      })
      .catch((caught) => {
        if (
          controller.signal.aborted ||
          stateRef.current ||
          (caught instanceof WebApiError && caught.status === 404)
        )
          return;
        setFrameError(
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
          setFrameError(null);
          if (previous) URL.revokeObjectURL(previous);
        }
      } catch (caught) {
        if (!controller.signal.aborted)
          setFrameError(
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
          setFrameError(
            caught instanceof Error ? caught.message : t("browserOpenFailed"),
          );
      } finally {
        if (!controller.signal.aborted)
          reconnect = window.setTimeout(connect, 1_000);
      }
    };
    const refreshState = async () => {
      const submittedRevision = navigationRevision.current;
      const submittedFocus = focusRevision.current;
      try {
        const next = await client.browserState(sessionId, controller.signal);
        if (
          !controller.signal.aborted &&
          submittedRevision === navigationRevision.current &&
          submittedFocus === focusRevision.current
        )
          applyState(next);
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
    const controller = new AbortController();
    let revision = 0;
    let timer = 0;
    const observer = new ResizeObserver(() => {
      if (controller.signal.aborted) return;
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
        const submittedNavigation = navigationRevision.current;
        const submittedFocus = focusRevision.current;
        const submittedRevision = ++revision;
        void client
          .browserAction(
            sessionId,
            {
              type: "resize",
              width,
              height,
              deviceScaleFactor: Math.max(
                1,
                Math.min(2, window.devicePixelRatio || 1),
              ),
            },
            controller.signal,
          )
          .then((next) => {
            if (
              !controller.signal.aborted &&
              submittedNavigation === navigationRevision.current &&
              submittedRevision === revision
            )
              applyState(
                submittedFocus === focusRevision.current
                  ? next
                  : {
                      ...next,
                      inputTarget: stateRef.current?.inputTarget,
                    },
              );
          })
          .catch(() => undefined);
      }, 160);
    });
    observer.observe(element);
    return () => {
      controller.abort();
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
      setAddressError(t("invalidBrowserAddress"));
      return;
    }
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    const submittedRevision = addressRevision.current;
    const navigation = ++navigationRevision.current;
    focusRevision.current++;
    textInput.current?.blur();
    setBusy(true);
    setDraft(next);
    setAddressError(null);
    inputRevision.current++;
    setInputError(null);
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
      if (
        !controller.signal.aborted &&
        navigation === navigationRevision.current
      ) {
        navigationRevision.current++;
        const syncAddress = submittedRevision === addressRevision.current;
        if (syncAddress) addressDirty.current = false;
        applyState(opened, syncAddress);
      }
    } catch (caught) {
      if (
        !controller.signal.aborted &&
        navigation === navigationRevision.current &&
        submittedRevision === addressRevision.current
      ) {
        setAddressError(
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
      const input = ["mouse", "key", "text"].includes(browserAction.type);
      const ownedInput =
        (browserAction.type === "text" || browserAction.type === "key") &&
        browserAction.owner !== undefined;
      const focusAction =
        (browserAction.type === "mouse" && browserAction.event === "up") ||
        (browserAction.type === "key" &&
          browserAction.event === "down" &&
          browserAction.key === "Tab");
      const submittedFocus = focusAction
        ? ++focusRevision.current
        : focusRevision.current;
      const submittedNavigation = navigationRevision.current;
      const passive =
        (browserAction.type === "mouse" &&
          ["move", "up"].includes(browserAction.event)) ||
        (browserAction.type === "key" && browserAction.event === "up");
      const submittedAddress = addressRevision.current;
      const submittedRevision = input
        ? passive
          ? inputRevision.current
          : ++inputRevision.current
        : ++navigationRevision.current;
      if (!input) {
        focusRevision.current++;
        textInput.current?.blur();
        inputRevision.current++;
        setInputError(null);
      }
      try {
        const next = await client.browserAction(sessionId, browserAction);
        if (input) {
          if (
            focusAction &&
            pointerMoveEnabled.current &&
            submittedFocus === focusRevision.current &&
            submittedNavigation === navigationRevision.current &&
            stateRef.current
          ) {
            if (browserAction.type === "key") setInputError(null);
            const updated = {
              ...stateRef.current,
              inputTarget: next.inputTarget,
            };
            stateRef.current = updated;
            setState(updated);
            setFocusReceipt(submittedFocus);
          }
          return next;
        }
        if (submittedRevision !== navigationRevision.current) return;
        navigationRevision.current++;
        const syncDraft =
          syncAddress && submittedAddress === addressRevision.current;
        if (syncDraft) addressDirty.current = false;
        applyState(next, syncDraft);
        if (submittedAddress === addressRevision.current) setAddressError(null);
      } catch (caught) {
        if (
          ownedInput
            ? pointerMoveEnabled.current &&
              submittedFocus === focusRevision.current &&
              submittedNavigation === navigationRevision.current
            : submittedRevision ===
              (input ? inputRevision.current : navigationRevision.current)
        ) {
          const message =
            caught instanceof WebApiError &&
            caught.code === "BROWSER_INPUT_TARGET_CHANGED"
              ? t("browserInputTargetChanged")
              : caught instanceof Error
                ? caught.message
                : t("browserOpenFailed");
          if (input)
            setInputError((previous) =>
              passive ? (previous ?? message) : message,
            );
          else if (submittedAddress === addressRevision.current)
            setAddressError(message);
        }
      }
    },
    [applyState, client, sessionId, t],
  );

  const releaseKeys = useCallback(() => {
    for (const key of forwardedKeys.current.values())
      void action({ type: "key", event: "up", ...key });
    forwardedKeys.current.clear();
  }, [action]);

  useEffect(() => {
    if (!active) {
      focusRevision.current++;
      textInput.current?.blur();
      releaseKeys();
    }
    return releaseKeys;
  }, [active, releaseKeys]);

  useEffect(() => {
    if (
      !active ||
      !state?.inputTarget ||
      focusReceipt !== focusRevision.current
    )
      return;
    if (
      document.activeElement === viewport.current ||
      document.activeElement === textInput.current ||
      (ownsInputFocus.current && document.activeElement === document.body)
    )
      textInput.current?.focus({ preventScroll: true });
  }, [active, focusReceipt, state?.inputTarget]);

  const submitText = (text: string, owner?: string) => {
    if (!active || !stateRef.current) return;
    if (text.length > WEB_BROWSER_TEXT_MAX_LENGTH) {
      inputRevision.current++;
      setInputError(
        t("browserInputTooLarge", { count: WEB_BROWSER_TEXT_MAX_LENGTH }),
      );
      return;
    }
    void action({ type: "text", text, ...(owner ? { owner } : {}) });
  };

  const browserPoint = useCallback(
    (event: { clientX: number; clientY: number }) => {
      const bounds = viewport.current?.getBoundingClientRect();
      const current = stateRef.current;
      if (!bounds || !current || !bounds.width || !bounds.height) return null;
      return {
        x: Math.max(
          0,
          Math.min(
            current.width - 1,
            ((event.clientX - bounds.left) / bounds.width) * current.width,
          ),
        ),
        y: Math.max(
          0,
          Math.min(
            current.height - 1,
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

  const releasePointer = useCallback(
    (point?: { x: number; y: number }) => {
      const pressed = pressedPointer.current;
      if (!pressed) return;
      pressedPointer.current = null;
      // A queued drag position must never reassert pressed buttons after release.
      pointerMovePoint.current = null;
      if (viewport.current?.hasPointerCapture?.(pressed.id))
        viewport.current.releasePointerCapture(pressed.id);
      void action({
        type: "mouse",
        event: "up",
        button: pressed.button,
        buttons: 0,
        ...(point ?? pressed.point),
      });
    },
    [action],
  );

  useEffect(() => {
    if (!active) releasePointer();
    return () => releasePointer();
  }, [active, releasePointer]);

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
            addressRevision.current++;
            addressDirty.current = true;
            setAddressError(null);
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
      <div className="browser-feedback">
        {addressError && (
          <p className="workbar-error" role="alert">
            {addressError}
          </p>
        )}
        {inputError && (
          <p className="workbar-error" role="alert">
            {inputError}
          </p>
        )}
        {frameError && (
          <p className="workbar-error" role="status">
            {frameError}
          </p>
        )}
      </div>
      <div
        ref={viewport}
        className="browser-viewport"
        tabIndex={state ? 0 : -1}
        role="application"
        aria-label={state?.title || t("browser")}
        aria-busy={state?.loading || undefined}
        onFocus={(event) => {
          ownsInputFocus.current = true;
          if (
            event.target === event.currentTarget &&
            !pressedPointer.current &&
            stateRef.current?.inputTarget
          )
            textInput.current?.focus({ preventScroll: true });
        }}
        onPaste={(event) => {
          if (!active || !state) return;
          const text = event.clipboardData.getData("text/plain");
          if (!text) return;
          event.preventDefault();
          event.stopPropagation();
          if (text.length > WEB_BROWSER_TEXT_MAX_LENGTH) {
            inputRevision.current++;
            setInputError(
              t("browserPasteTooLarge", { count: WEB_BROWSER_TEXT_MAX_LENGTH }),
            );
            return;
          }
          setInputError(null);
          submitText(text, stateRef.current?.inputTarget?.owner);
        }}
        onPointerDown={(event) => {
          if (!active) return;
          const point = browserPoint(event);
          const button =
            event.button === 0
              ? "left"
              : event.button === 1
                ? "middle"
                : event.button === 2
                  ? "right"
                  : undefined;
          if (!point || !button || pressedPointer.current) return;
          event.preventDefault();
          focusRevision.current++;
          setInputError(null);
          pressedPointer.current = { id: event.pointerId, button, point };
          event.currentTarget.focus();
          event.currentTarget.setPointerCapture?.(event.pointerId);
          void action({
            type: "mouse",
            event: "down",
            button,
            buttons: event.buttons & 7,
            ...point,
          });
        }}
        onPointerUp={(event) => {
          if (pressedPointer.current?.id === event.pointerId)
            releasePointer(browserPoint(event) ?? undefined);
        }}
        onPointerCancel={(event) => {
          if (pressedPointer.current?.id === event.pointerId) releasePointer();
        }}
        onLostPointerCapture={(event) => {
          if (pressedPointer.current?.id === event.pointerId) releasePointer();
        }}
        onBlur={(event) => {
          if (
            event.relatedTarget instanceof Node &&
            event.currentTarget.contains(event.relatedTarget)
          )
            return;
          ownsInputFocus.current = false;
          focusRevision.current++;
          releasePointer();
          releaseKeys();
        }}
        onContextMenu={(event) => {
          if (state) event.preventDefault();
        }}
        onPointerMove={(event) => {
          const point = browserPoint(event);
          if (!point) return;
          const pressed = pressedPointer.current;
          if (pressed && pressed.id !== event.pointerId) return;
          if (pressed) pressed.point = point;
          pointerMovePoint.current = {
            ...point,
            buttons: pressed ? event.buttons & 7 : 0,
            ...(pressed ? { button: pressed.button } : {}),
          };
          void flushPointerMove();
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
          const modifiers = forwardedKeyModifiers(event);
          if (
            !active ||
            !state ||
            modifiers === null ||
            event.nativeEvent.isComposing ||
            event.nativeEvent.keyCode === 229 ||
            event.key === "Process" ||
            event.key === "Dead" ||
            event.key === "Unidentified"
          )
            return;
          event.preventDefault();
          forwardedKeys.current.set(event.code || event.key, {
            key: event.key,
            code: event.code,
            modifiers,
          });
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
          const identifier = event.code || event.key;
          const key = forwardedKeys.current.get(identifier);
          if (!key || !active || !state) return;
          forwardedKeys.current.delete(identifier);
          event.preventDefault();
          void action({
            type: "key",
            event: "up",
            ...key,
          });
        }}
      >
        <BrowserTextInput
          inputRef={textInput}
          target={state?.inputTarget}
          active={active}
          label={state?.title || t("browser")}
          width={state?.width || 1}
          height={state?.height || 1}
          onText={submitText}
          onEditingKey={(key, owner) => {
            void action({
              type: "key",
              event: "down",
              key,
              code: key,
              owner,
            }).then(() =>
              action({ type: "key", event: "up", key, code: key, owner }),
            );
          }}
        />
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
