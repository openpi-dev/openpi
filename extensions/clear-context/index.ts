import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";

function installClearContextShortcut(ctx: ExtensionContext) {
  if (ctx.mode !== "tui") return () => {};

  return ctx.ui.onTerminalInput((data) => {
    if (!matchesKey(data, Key.ctrl("c"))) return;
    if (ctx.ui.getEditorText().trim().length > 0) return;

    // Route through Pi's built-in /new command so session replacement keeps
    // Pi's persistence, cleanup, and transcript lifecycle as the source of truth.
    ctx.ui.setEditorText("/new");
    return { data: "\r" };
  });
}

export default function clearContext(pi: ExtensionAPI) {
  let removeShortcut = () => {};

  pi.on("session_start", (_event, ctx) => {
    removeShortcut();
    removeShortcut = installClearContextShortcut(ctx);
  });

  pi.on("session_shutdown", () => {
    removeShortcut();
    removeShortcut = () => {};
  });
}

export { installClearContextShortcut };
