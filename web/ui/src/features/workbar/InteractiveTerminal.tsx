import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import { RefreshCw } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { WebInteractiveTerminalEvent } from "../../../../protocol/types.ts";
import { WebClient } from "../../protocol/client.ts";

type TerminalStatus = "connecting" | "ready" | "exited" | "error";

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
  const terminalId = useRef<string | null>(null);
  const [status, setStatus] = useState<TerminalStatus>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [generation, setGeneration] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: cwd changes and generation increments intentionally recreate the PTY connection.
  useEffect(() => {
    const host = container.current;
    if (!host) return;
    let disposed = false;
    let exited = false;
    let connected = false;
    let offset: number | undefined;
    let inputStopped = false;
    let pendingInput = Promise.resolve<unknown>(undefined);
    let bufferedInput: { data: string } | null = null;
    const streamAbort = new AbortController();
    setStatus("connecting");
    setError(null);
    setExitCode(null);

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
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true;
      const key = event.key.toLowerCase();
      if ((event.ctrlKey || event.metaKey) && key === "v") return false;
      if (
        (event.ctrlKey || event.metaKey) &&
        key === "c" &&
        terminal.hasSelection()
      )
        return false;
      return true;
    });

    const failInput = (reason: unknown) => {
      if (disposed) return;
      inputStopped = true;
      terminal.options.disableStdin = true;
      setError(reason instanceof Error ? reason.message : t("terminalError"));
      setStatus("error");
    };
    const enqueueInput = (request: () => Promise<unknown>) => {
      if (inputStopped || disposed) return;
      pendingInput = pendingInput
        .then(() => {
          if (!disposed && !inputStopped && connected && !exited)
            return request();
        })
        .catch(failInput);
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
      fitTerminal();
      const info = await client.createInteractiveTerminal(
        sessionId,
        terminal.cols,
        terminal.rows,
        streamAbort.signal,
      );
      if (disposed) return;
      terminalId.current = info.id;
      connected = !info.exited;
      terminal.options.disableStdin = info.exited;
      setStatus(info.exited ? "exited" : "ready");
      setExitCode(info.exitCode);
      fitTerminal();
      if (!info.exited) {
        resize(terminal.cols, terminal.rows);
        terminal.focus();
      }
      await client.streamInteractiveTerminal(
        sessionId,
        info.id,
        offset,
        streamAbort.signal,
        applyEvent,
      );
      if (!disposed && !exited) {
        connected = false;
        terminal.options.disableStdin = true;
        setError(t("terminalDisconnected"));
        setStatus("error");
      }
    };
    void start().catch((reason) => {
      if (
        disposed ||
        streamAbort.signal.aborted ||
        (reason instanceof DOMException && reason.name === "AbortError")
      )
        return;
      connected = false;
      terminal.options.disableStdin = true;
      setError(reason instanceof Error ? reason.message : t("terminalError"));
      setStatus("error");
    });

    return () => {
      disposed = true;
      connected = false;
      inputStopped = true;
      bufferedInput = null;
      streamAbort.abort();
      observer?.disconnect();
      onData.dispose();
      onResize.dispose();
      void pendingInput.catch(() => undefined);
      terminal.dispose();
      terminalId.current = null;
    };
  }, [client, cwd, generation, sessionId, t]);

  const restart = async () => {
    const id = terminalId.current;
    terminalId.current = null;
    if (id)
      await client
        .closeInteractiveTerminal(sessionId, id)
        .catch(() => undefined);
    setGeneration((value) => value + 1);
  };

  return (
    <section className="interactive-terminal" aria-label={t("terminal")}>
      <header className="interactive-terminal-status">
        <div>
          <span className={`terminal-status-dot ${status}`} />
          <span title={cwd}>{cwd}</span>
        </div>
        <button
          type="button"
          aria-label={t("restartTerminal")}
          title={t("restartTerminal")}
          onClick={() => void restart()}
        >
          <RefreshCw aria-hidden="true" />
        </button>
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
        ) : null}
      </div>
      <div className="interactive-terminal-viewport">
        <div ref={container} className="interactive-terminal-host" />
      </div>
    </section>
  );
}
