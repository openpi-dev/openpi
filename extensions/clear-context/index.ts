import {
  type ExtensionAPI,
  type ExtensionContext,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, type EditorComponent } from "@earendil-works/pi-tui";
import {
  BelowEditorNavigationEditor,
  BelowEditorStripState,
} from "../shared/below-editor-navigation.ts";
import {
  registerEditorLayer,
  removeEditorLayer,
} from "../shared/editor-layers.ts";

export function shouldClearContext(
  data: string,
  editorText: string,
  isIdle: boolean,
) {
  return isIdle && editorText.length === 0 && matchesKey(data, Key.ctrl("c"));
}

export class ClearContextEditor extends BelowEditorNavigationEditor {
  private readonly isIdle: () => boolean;

  constructor(
    base: EditorComponent,
    keybindings: KeybindingsManager,
    isIdle: () => boolean,
  ) {
    super(
      base,
      keybindings,
      new BelowEditorStripState(),
      () => false,
      () => undefined,
      () => undefined,
    );
    this.isIdle = isIdle;
  }

  override handleInput(data: string) {
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

function installClearContextShortcut(pi: ExtensionAPI, ctx: ExtensionContext) {
  if (ctx.mode !== "tui") return () => {};

  registerEditorLayer(pi, ctx, {
    id: "clear-context",
    order: 100,
    wrap: (base, _tui, _theme, keybindings) =>
      new ClearContextEditor(base, keybindings, () => ctx.isIdle()),
  });

  return () => removeEditorLayer(pi, "clear-context");
}

export default function clearContext(pi: ExtensionAPI) {
  let removeShortcut = () => {};

  pi.on("session_start", (_event, ctx) => {
    removeShortcut();
    removeShortcut = installClearContextShortcut(pi, ctx);
  });

  pi.on("session_shutdown", () => {
    removeShortcut();
    removeShortcut = () => {};
  });
}

export { installClearContextShortcut };
