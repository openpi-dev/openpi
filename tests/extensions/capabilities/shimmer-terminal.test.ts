import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
  KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { EditorComponent, EditorTheme, TUI } from "@earendil-works/pi-tui";
import { createCapabilitiesExtension } from "../../../extensions/capabilities/index.ts";
import type { EditorLayer } from "../../../extensions/shared/editor-layers.ts";

for (const [supported, colorMode] of [
  [false, "truecolor"],
  [true, "256color"],
  [true, "truecolor"],
] as const) {
  test(`shimmer timer follows terminal support ${supported} and ${colorMode}`, (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const intervals = t.mock.method(globalThis, "setInterval");
    const handlers = new Map<
      string,
      (event: unknown, ctx: ExtensionContext) => void
    >();
    let layer: EditorLayer | undefined;
    const pi = {
      events: {
        on() {
          return () => {};
        },
        emit(channel: string, value: unknown) {
          if (channel === "openpi:editor-layers:claim")
            (value as { claimed: boolean }).claimed = true;
          if (channel === "openpi:editor-layers:register")
            layer = (value as { layer: EditorLayer }).layer;
        },
      },
      on(
        name: string,
        handler: (event: unknown, ctx: ExtensionContext) => void,
      ) {
        handlers.set(name, handler);
      },
      registerTool() {},
      getAllTools: () => [],
      getActiveTools: () => [],
      setActiveTools() {},
    } as unknown as ExtensionAPI;
    createCapabilitiesExtension({
      loadConfig: () => ({ capabilities: { discovery: "explicit" } }),
      supportsDynamicShimmer: () => supported,
    })(pi);
    const ctx = {
      mode: "tui",
      ui: { theme: { name: "dark", getColorMode: () => colorMode } },
    } as unknown as ExtensionContext;
    handlers.get("session_start")!({}, ctx);
    assert.ok(layer);
    let text = "";
    const base: EditorComponent = {
      render: () => [text],
      invalidate() {},
      handleInput() {},
      getText: () => text,
      setText(value) {
        text = value;
      },
    };
    let renders = 0;
    const editor = layer.wrap(
      base,
      {
        requestRender() {
          renders++;
        },
      } as unknown as TUI,
      {} as EditorTheme,
      {} as KeybindingsManager,
    );
    editor.render(80);
    assert.equal(intervals.mock.callCount(), 0);
    text = "用 subagent 调查项目";
    const first = editor.render(80);
    editor.render(80);
    const animated = supported && colorMode === "truecolor";
    assert.equal(intervals.mock.callCount(), animated ? 1 : 0);
    t.mock.timers.tick(240);
    assert.equal(renders, animated ? 2 : 0);
    const second = editor.render(80);
    if (animated) assert.notDeepEqual(first, second);
    else assert.deepEqual(first, second);
    text = "";
    editor.render(80);
    t.mock.timers.tick(240);
    assert.equal(renders, animated ? 2 : 0);
    text = "用 workflow 调查项目";
    editor.render(80);
    handlers.get("session_shutdown")!({}, ctx);
    t.mock.timers.tick(240);
    assert.equal(renders, animated ? 2 : 0);
  });
}
