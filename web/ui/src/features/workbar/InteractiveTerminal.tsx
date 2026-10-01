import { Dialog } from "@astryxdesign/core/Dialog";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import { RefreshCw, RotateCcw } from "lucide-react";
import {
  type KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import type { WebInteractiveTerminalEvent } from "../../../../protocol/types.ts";
import { WebClient } from "../../protocol/client.ts";

type TerminalStatus =
  | "connecting"
  | "reconnecting"
  | "restarting"
  | "ready"
  | "exited"
  | "error";

type TerminalConnection = {
  reconnect: () => void;
  suspend: () => void;
};

function terminalTheme() {
  return {
    background: "#101316",
    foreground: "#d7dde3",
    cursor: "#7db8ff",
    selectionBackground: "#365b8a",
    black: "#1d2227",
    red: "#ff7b72",
    green: "#56d364",
    yellow: "#e3b341",
    blue: "#79c0ff",
    magenta: "#d2a8ff",
    cyan: "#39c5cf",
    white: "#e6edf3",
    brightBlack: "#6e7681",
    brightRed: "#ffa198",
    brightGreen: "#7ee787",
    brightYellow: "#f2cc60",
    brightBlue: "#a5d6ff",
    brightMagenta: "#d2a8ff",
    brightCyan: "#56d4dd",
    brightWhite: "#ffffff",
  };
}

export function InteractiveTerminal({
  sessionId,
  cwd,
}: {
  sessionId: string;
  cwd: string;
}) {
  const { t } = useTranslation();
  const client = useMemo(() => new WebClient(), []);
  const container = useRef<HTMLDivElement>(null);
  const restartFocusIntent = useRef<{
    sessionId: string;
    cwd: string;
    generation: number;
  } | null>(null);
  const terminalId = useRef<string | null>(null);
  const [status, setStatus] = useState<TerminalStatus>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [generation, setGeneration] = useState(0);
  const connection = useRef<TerminalConnection | null>(null);
  const restartInFlight = useRef<TerminalConnection | null>(null);
  const [restartOpen, setRestartOpen] = useState(false);
  const [restartPending, setRestartPending] = useState(false);
  const [restartError, setRestartError] = useState<string | null>(null);

  useEffect(() => {
    const host = container.current;
    if (!host) return;
    let disposed = false;
    let exited = false;
    let connected = false;
    let opening = false;
    let offset: number | undefined;
    let inputStopped = false;
    let pendingInput = Promise.resolve<unknown>(undefined);
    let bufferedInput: { data: string } | null = null;
    let streamAbort = new AbortController();
    setStatus("connecting");
    setError(null);
    setExitCode(null);
    setRestartOpen(false);
    setRestartPending(false);
    setRestartError(null);

    const terminal = new XTerm({
      cursorBlink: true,
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      fontSize: 12,
      lineHeight: 1.25,
      scrollback: 8_000,
      screenReaderMode: true,
      disableStdin: true,
      theme: terminalTheme(),
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    const focusIntent = restartFocusIntent.current;
    restartFocusIntent.current = null;
    // Opening the tool is the focus intent. A delayed connection must not
    // steal focus back after the user has moved to another input or panel.
    if (
      !host.closest("[hidden], [inert]") &&
      (generation === 0 ||
        host
          .closest(".interactive-terminal")
          ?.contains(document.activeElement) ||
        (focusIntent?.sessionId === sessionId &&
          focusIntent.cwd === cwd &&
          focusIntent.generation === generation &&
          document.activeElement === document.body))
    )
      terminal.focus();
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true;
      const key = event.key.toLowerCase();
      if (key === "escape") event.stopPropagation();
      if ((event.ctrlKey || event.metaKey) && key === "v") return false;
      if (
        (event.ctrlKey || event.metaKey) &&
        key === "c" &&
        terminal.hasSelection()
      )
        return false;
      return true;
    });

    const isCurrent = (controller: AbortController) =>
      !disposed && streamAbort === controller && !controller.signal.aborted;
    const suspend = () => {
      connected = false;
      inputStopped = true;
      bufferedInput = null;
      terminal.options.disableStdin = true;
      streamAbort.abort();
    };
    const failInput = (reason: unknown) => {
      if (disposed) return;
      suspend();
      setError(reason instanceof Error ? reason.message : t("terminalError"));
      setStatus("error");
    };
    const enqueueInput = (request: () => Promise<unknown>) => {
      if (inputStopped || disposed) return;
      const controller = streamAbort;
      pendingInput = pendingInput
        .then(() => {
          if (isCurrent(controller) && !inputStopped && connected && !exited)
            return request();
        })
        .catch((reason) => {
          if (isCurrent(controller)) failInput(reason);
        });
    };
    const writeInput = (data: string) => {
      const id = terminalId.current;
      if (!id || !connected || exited || inputStopped) return;
      for (const chunk of data.match(/[\s\S]{1,32768}/gu) ?? []) {
        if (
          bufferedInput &&
          bufferedInput.data.length + chunk.length <= 65_536
        ) {
          bufferedInput.data += chunk;
          continue;
        }
        const next = { data: chunk };
        bufferedInput = next;
        enqueueInput(async () => {
          if (bufferedInput === next) bufferedInput = null;
          await client.writeInteractiveTerminal(sessionId, id, next.data);
        });
      }
    };
    const resize = (cols: number, rows: number) => {
      const id = terminalId.current;
      if (!id || !connected || exited || inputStopped) return;
      bufferedInput = null;
      enqueueInput(() =>
        client.resizeInteractiveTerminal(sessionId, id, cols, rows),
      );
    };
    const fitTerminal = () => {
      if (!host.offsetWidth || !host.offsetHeight) return;
      try {
        fit.fit();
      } catch {}
    };
    const applyEvent = (event: WebInteractiveTerminalEvent) => {
      if (disposed) return;
      if (event.type === "output") {
        if (event.reset) terminal.reset();
        else if (offset !== undefined && event.offset <= offset) return;
        terminal.write(event.data);
        offset = event.offset;
        return;
      }
      exited = true;
      connected = false;
      terminal.options.disableStdin = true;
      streamAbort.abort();
      setExitCode(event.type === "exit" ? event.exitCode : null);
      setStatus("exited");
    };
    const onData = terminal.onData(writeInput);
    const onResize = terminal.onResize(({ cols, rows }) => resize(cols, rows));
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(fitTerminal);
    observer?.observe(host);

    const start = async () => {
      if (disposed || opening || connected) return;
      opening = true;
      suspend();
      const controller = new AbortController();
      streamAbort = controller;
      // An interrupted input is never retried with the new connection.
      pendingInput = Promise.resolve();
      const id = terminalId.current;
      setStatus(id ? "reconnecting" : "connecting");
      setError(null);
      fitTerminal();
      try {
        const info = id
          ? await client.interactiveTerminal(sessionId, id, controller.signal)
          : await client.createInteractiveTerminal(
              sessionId,
              terminal.cols,
              terminal.rows,
              controller.signal,
            );
        if (!isCurrent(controller)) return;
        if (
          !info.id ||
          info.sessionId !== sessionId ||
          info.cwd !== cwd ||
          (id && info.id !== id)
        )
          throw new Error(t("inspectionChanged"));
        opening = false;
        terminalId.current = info.id;
        exited = info.exited;
        connected = !info.exited;
        inputStopped = info.exited;
        terminal.options.disableStdin = info.exited;
        setStatus(info.exited ? "exited" : "ready");
        setExitCode(info.exitCode);
        fitTerminal();
        if (!info.exited) resize(terminal.cols, terminal.rows);
        await client.streamInteractiveTerminal(
          sessionId,
          info.id,
          offset,
          controller.signal,
          (event) => {
            if (isCurrent(controller)) applyEvent(event);
          },
        );
        if (isCurrent(controller) && !exited)
          failInput(new Error(t("terminalDisconnected")));
      } catch (reason) {
        if (isCurrent(controller)) failInput(reason);
      } finally {
        if (streamAbort === controller) opening = false;
      }
    };
    const scope = {
      reconnect: () => {
        void start();
      },
      suspend,
    };
    connection.current = scope;
    void start();

    return () => {
      disposed = true;
      suspend();
      if (connection.current === scope) connection.current = null;
      if (restartInFlight.current === scope) restartInFlight.current = null;
      observer?.disconnect();
      onData.dispose();
      onResize.dispose();
      void pendingInput.catch(() => undefined);
      terminal.dispose();
      terminalId.current = null;
    };
  }, [client, cwd, generation, sessionId, t]);

  const restart = async (returnFocus: boolean) => {
    const scope = connection.current;
    if (!scope || restartInFlight.current) return;
    restartInFlight.current = scope;
    setRestartPending(true);
    setRestartError(null);
    setStatus("restarting");
    setError(null);
    scope.suspend();
    const id = terminalId.current;
    try {
      if (id) await client.closeInteractiveTerminal(sessionId, id);
      if (connection.current !== scope) return;
      terminalId.current = null;
      if (returnFocus)
        restartFocusIntent.current = {
          sessionId,
          cwd,
          generation: generation + 1,
        };
      setRestartOpen(false);
      setGeneration((value) => value + 1);
    } catch (reason) {
      if (connection.current === scope) {
        const message =
          reason instanceof Error ? reason.message : t("terminalError");
        setError(message);
        setRestartError(message);
        setStatus("error");
        restartInFlight.current = null;
        setRestartPending(false);
      }
    }
  };

  return (
    <section className="interactive-terminal" aria-label={t("terminal")}>
      <header className="interactive-terminal-status">
        <div>
          <span className={`terminal-status-dot ${status}`} />
          <span title={cwd}>{cwd}</span>
        </div>
        <div className="interactive-terminal-actions">
          {status === "error" && (
            <button
              type="button"
              aria-label={t("reconnectTerminal")}
              title={t("reconnectTerminal")}
              disabled={restartPending}
              onClick={() => connection.current?.reconnect()}
            >
              <RefreshCw aria-hidden="true" />
            </button>
          )}
          <button
            type="button"
            aria-label={t("restartTerminal")}
            title={t("restartTerminal")}
            disabled={
              restartPending ||
              status === "connecting" ||
              status === "reconnecting"
            }
            onClick={() => {
              setRestartError(null);
              setRestartOpen(true);
            }}
          >
            <RotateCcw aria-hidden="true" />
          </button>
        </div>
      </header>
      <div className="interactive-terminal-notice" aria-live="polite">
        {error ? (
          <span className="error">{error}</span>
        ) : status === "exited" ? (
          <span>
            {exitCode === null
              ? t("terminalExited")
              : t("terminalExitCode", { code: exitCode })}
          </span>
        ) : status === "connecting" ? (
          <span>{t("terminalConnecting")}</span>
        ) : status === "reconnecting" ? (
          <span>{t("terminalReconnecting")}</span>
        ) : status === "restarting" ? (
          <span>{t("terminalRestarting")}</span>
        ) : null}
      </div>
      <div className="interactive-terminal-viewport">
        <div ref={container} className="interactive-terminal-host" />
      </div>
      <Dialog
        key={`${sessionId}:${cwd}`}
        isOpen={restartOpen}
        purpose="form"
        width={430}
        aria-label={t("restartTerminalTitle")}
        onKeyDown={(event: KeyboardEvent<HTMLDialogElement>) => {
          // Keep native dialog dismissal ahead of the workbar's outer close.
          if (event.key === "Escape") event.stopPropagation();
        }}
        onOpenChange={(open: boolean) => {
          if (!open && !restartInFlight.current) setRestartOpen(false);
        }}
      >
        <form
          className="openpi-dialog"
          aria-busy={restartPending}
          onSubmit={(event) => {
            event.preventDefault();
            void restart(event.currentTarget.contains(document.activeElement));
          }}
        >
          <strong>{t("restartTerminalTitle")}</strong>
          <p>{t("restartTerminalDetail")}</p>
          {restartError && (
            <p className="terminal-restart-error" role="alert">
              {restartError}
            </p>
          )}
          <div className="dialog-actions">
            <button
              type="button"
              disabled={restartPending}
              onClick={() => {
                if (!restartInFlight.current) setRestartOpen(false);
              }}
            >
              {t("cancel")}
            </button>
            <button type="submit" className="danger" disabled={restartPending}>
              {t(restartPending ? "terminalRestarting" : "restartTerminal")}
            </button>
          </div>
        </form>
      </Dialog>
    </section>
  );
}
