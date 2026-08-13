/**
 * session-liveness: a screen-level "still running" strip.
 *
 * pi's built-in Working loader only shows while the MAIN agent streams; when
 * it settles behind detached subagents or workflows the screen goes still and
 * nothing says the session is alive. This extension renders a flowing
 * gradient strip above the editor while ANY work is in flight (merged via
 * shared/session-liveness), and hides it once everything settles.
 *
 * DDD: pure state in shared/session-liveness.ts; this file is the UI wiring.
 */

import type {
  ExtensionAPI,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { requestWidgetRepaint } from "../shared/ui-screen.ts";
import {
  subscribeSessionLiveness,
  type SessionLiveness,
} from "../shared/session-liveness.ts";
import { buildGradientBarFrames } from "../shared/gradient-bar.ts";

const WIDGET_KEY = "session-liveness";

export default function sessionLiveness(pi: ExtensionAPI) {
  let last: SessionLiveness = {
    active: false,
    detail: "",
    runningSubagents: 0,
    runningWorkflows: 0,
  };
  let installed = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const frames = buildGradientBarFrames(10);

  const hide = (ui: ExtensionUIContext) => {
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
    ui.setWidget(WIDGET_KEY, undefined);
    installed = false;
  };

  const install = (ui: ExtensionUIContext) => {
    if (installed) return;
    installed = true;
    ui.setWidget(
      WIDGET_KEY,
      (
        tui: { requestRender(): void },
        theme: {
          fg(color: string, text: string): string;
          bold(text: string): string;
        },
      ) => {
        timer = setInterval(() => requestWidgetRepaint(tui), 120);
        timer.unref?.();
        return {
          render(width: number, now = Date.now()) {
            const state = last;
            if (!state.active) return [];
            const frame = frames[Math.floor(now / 120) % frames.length] ?? "";
            const detail = state.detail ? ` · ${state.detail}` : "";
            const line = `${theme.fg("accent", theme.bold("▶"))} ${frame}${theme.fg("dim", ` 会话运行中${detail}`)}`;
            return [line.slice(0, width)];
          },
          invalidate() {},
          dispose() {
            if (timer) clearInterval(timer);
          },
        };
      },
    );
  };

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui" || !ctx.hasUI) return;
    subscribeSessionLiveness((state) => {
      last = state;
      if (state.active) install(ctx.ui);
      else hide(ctx.ui);
    });
  });

  pi.on("session_shutdown", (_event, ctx) => {
    hide(ctx.ui);
  });
}
