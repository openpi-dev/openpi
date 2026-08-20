import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionContext,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { EditorComponent, EditorTheme, TUI } from "@earendil-works/pi-tui";

const CLAIM_CHANNEL = "openpi:editor-layers:claim";
const REGISTER_CHANNEL = "openpi:editor-layers:register";
const REMOVE_CHANNEL = "openpi:editor-layers:remove";

type EditorFactory = NonNullable<
  ReturnType<ExtensionContext["ui"]["getEditorComponent"]>
>;

export interface EditorLayer {
  readonly id: string;
  readonly order: number;
  readonly wrap: (
    base: EditorComponent,
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
  ) => EditorComponent;
}

interface EditorLayerRegistration {
  readonly ctx: ExtensionContext;
  readonly layer: EditorLayer;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readRegistration(value: unknown) {
  if (!isRecord(value) || !isRecord(value.layer)) return undefined;
  const { ctx, layer } = value;
  if (
    !isRecord(ctx) ||
    typeof layer.id !== "string" ||
    typeof layer.order !== "number" ||
    typeof layer.wrap !== "function"
  ) {
    return undefined;
  }
  return {
    ctx: ctx as unknown as ExtensionContext,
    layer: layer as unknown as EditorLayer,
  } satisfies EditorLayerRegistration;
}

function readLayerId(value: unknown) {
  if (!isRecord(value) || typeof value.id !== "string") return undefined;
  return value.id;
}

function composeEditorFactory(
  previous: EditorFactory | undefined,
  layers: readonly EditorLayer[],
) {
  return ((tui, theme, keybindings) => {
    let editor =
      previous?.(tui, theme, keybindings) ??
      new CustomEditor(tui, theme, keybindings);
    for (const layer of layers) {
      editor = layer.wrap(editor, tui, theme, keybindings);
    }
    return editor;
  }) satisfies EditorFactory;
}

/**
 * Each extension is evaluated in its own jiti module graph, so ordinary module
 * singletons are not shared. The first OpenPI editor contributor claims the
 * runtime EventBus and coordinates the rest through that host-owned boundary.
 */
function ensureCoordinator(pi: ExtensionAPI) {
  const claim = { claimed: false };
  pi.events.emit(CLAIM_CHANNEL, claim);
  if (claim.claimed) return;

  let ctx: ExtensionContext | undefined;
  let installTimer: ReturnType<typeof setTimeout> | undefined;
  const layers = new Map<string, EditorLayer>();

  const cancelInstall = () => {
    if (installTimer) clearTimeout(installTimer);
    installTimer = undefined;
  };

  const install = () => {
    installTimer = undefined;
    const current = ctx;
    if (!current || current.mode !== "tui" || layers.size === 0) return;
    const ordered = [...layers.values()].sort(
      (left, right) =>
        left.order - right.order || left.id.localeCompare(right.id),
    );
    current.ui.setEditorComponent(
      composeEditorFactory(current.ui.getEditorComponent(), ordered),
    );
  };

  const scheduleInstall = () => {
    if (installTimer) return;
    installTimer = setTimeout(install, 0);
  };

  pi.events.on(CLAIM_CHANNEL, (value) => {
    if (isRecord(value) && value.claimed === false) value.claimed = true;
  });
  pi.events.on(REGISTER_CHANNEL, (value) => {
    const registration = readRegistration(value);
    if (!registration || registration.ctx.mode !== "tui") return;
    if (ctx !== registration.ctx) {
      cancelInstall();
      layers.clear();
      ctx = registration.ctx;
    }
    layers.set(registration.layer.id, registration.layer);
    scheduleInstall();
  });
  pi.events.on(REMOVE_CHANNEL, (value) => {
    const id = readLayerId(value);
    if (!id) return;
    layers.delete(id);
    if (layers.size > 0) return;
    cancelInstall();
    ctx = undefined;
  });
}

export function registerEditorLayer(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  layer: EditorLayer,
) {
  if (ctx.mode !== "tui") return;
  ensureCoordinator(pi);
  pi.events.emit(REGISTER_CHANNEL, {
    ctx,
    layer,
  } satisfies EditorLayerRegistration);
}

export function removeEditorLayer(pi: ExtensionAPI, id: string) {
  pi.events.emit(REMOVE_CHANNEL, { id });
}
