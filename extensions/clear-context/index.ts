import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionContext,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  type EditorTheme,
  type TUI,
} from "@earendil-works/pi-tui";

export function shouldClearContext(
  data: string,
  editorText: string,
  isIdle: boolean,
) {
  return isIdle && editorText.length === 0 && matchesKey(data, Key.ctrl("c"));
}

class ClearContextEditor extends CustomEditor {
  private readonly isIdle: () => boolean;

  constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
    isIdle: () => boolean,
  ) {
    super(tui, theme, keybindings);
    this.isIdle = isIdle;
  }

  handleInput(data: string) {
    if (shouldClearContext(data, this.getText(), this.isIdle())) {
      // Route through Pi's built-in /new command so session replacement keeps
      // Pi's persistence, cleanup, and transcript lifecycle as the source of truth.
      this.setText("/new");
      this.onSubmit?.("/new");
      return;
    }

    super.handleInput(data);
  }
}

function installClearContextShortcut(ctx: ExtensionContext) {
  if (ctx.mode !== "tui") return () => {};

  const previousEditor = ctx.ui.getEditorComponent();
  ctx.ui.setEditorComponent(
    (tui, theme, keybindings) =>
      new ClearContextEditor(tui, theme, keybindings, () => ctx.isIdle()),
  );

  return () => ctx.ui.setEditorComponent(previousEditor);
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
