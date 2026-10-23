import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import imagePaste from "../../../extensions/image-paste/index.ts";
import subagents from "../../../extensions/subagents/index.ts";
import suggestions from "../../../extensions/suggestions/index.ts";
import workflows from "../../../extensions/workflows/index.ts";
import {
  registerEditorLayer,
  removeEditorLayer,
  type EditorLayer,
} from "../../../extensions/shared/editor-layers.ts";

type EditorFactory = NonNullable<
  ReturnType<ExtensionContext["ui"]["getEditorComponent"]>
>;

function createEventBus() {
  const handlers = new Map<string, Set<(data: unknown) => void>>();
  return {
    emit(channel: string, data: unknown) {
      for (const handler of handlers.get(channel) ?? []) handler(data);
    },
    on(channel: string, handler: (data: unknown) => void) {
      const listeners = handlers.get(channel) ?? new Set();
      listeners.add(handler);
      handlers.set(channel, listeners);
      return () => listeners.delete(handler);
    },
  };
}

function editorLifecycleHarness() {
  const lifecycle = new Map<
    string,
    Array<(event: unknown, ctx: ExtensionContext) => unknown>
  >();
  const events = createEventBus();
  let editorFactory: EditorFactory | undefined;
  let editorWrites = 0;

  const load = (factory: ExtensionFactory) => {
    let activeTools: string[] = [];
    const api = {
      events,
      on(event: string, handler: unknown) {
        lifecycle.set(event, [
          ...(lifecycle.get(event) ?? []),
          handler as (event: unknown, ctx: ExtensionContext) => unknown,
        ]);
      },
      registerTool(tool: { name: string }) {
        activeTools = [
          ...activeTools.filter((name) => name !== tool.name),
          tool.name,
        ];
      },
      getActiveTools: () => [...activeTools],
      setActiveTools(names: string[]) {
        activeTools = [...names];
      },
      getAllTools: () => [],
      registerCommand() {},
      registerMessageRenderer() {},
      registerEntryRenderer() {},
      registerMarkdownTransformer() {},
      getThinkingLevel: () => "off",
      sendMessage() {},
      appendEntry() {},
    } as unknown as ExtensionAPI;
    factory(api);
  };

  load(subagents);
  load(suggestions);
  load(workflows);
  load(imagePaste);

  const ctx = {
    cwd: process.cwd(),
    mode: "tui",
    hasUI: true,
    isIdle: () => true,
    isProjectTrusted: () => false,
    sessionManager: {
      getLeafId: () => "leaf",
      getBranch: () => [],
      getSessionId: () => "session",
      getEntries: () => [],
    },
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      getEditorComponent: () => editorFactory,
      setEditorComponent(factory: EditorFactory | undefined) {
        editorFactory = factory;
        editorWrites += 1;
      },
      setStatus() {},
      setWidget() {},
      notify() {},
    },
  } as unknown as ExtensionContext;

  const emit = async (event: string) => {
    for (const handler of lifecycle.get(event) ?? []) {
      await handler({ type: event }, ctx);
    }
  };

  return {
    emit,
    editorFactory: () => editorFactory,
    editorWrites: () => editorWrites,
  };
}

test("one session binds all OpenPI editor layers with one UI write", async () => {
  const first = editorLifecycleHarness();
  await first.emit("session_start");
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(first.editorWrites(), 1);
  assert.equal(typeof first.editorFactory(), "function");

  await first.emit("session_shutdown");

  const resumed = editorLifecycleHarness();
  await resumed.emit("session_start");
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(resumed.editorWrites(), 1);
  assert.equal(typeof resumed.editorFactory(), "function");
  assert.notEqual(resumed.editorFactory(), first.editorFactory());
});

test("re-registering a layer for one TUI context does not stack prior wrappers", async () => {
  const events = createEventBus();
  let editorFactory: EditorFactory | undefined = (() => ({
    layers: [],
  })) as unknown as EditorFactory;
  const api = { events, on() {} } as unknown as ExtensionAPI;
  const ctx = {
    mode: "tui",
    ui: {
      getEditorComponent: () => editorFactory,
      setEditorComponent(factory: EditorFactory | undefined) {
        editorFactory = factory;
      },
    },
  } as unknown as ExtensionContext;

  const layer = {
    id: "test-layer",
    order: 1,
    wrap: (base: { layers: string[] }) => ({
      ...base,
      layers: [...base.layers, "test-layer"],
    }),
  } as unknown as EditorLayer;

  registerEditorLayer(api, ctx, layer);
  await new Promise((resolve) => setTimeout(resolve, 10));
  registerEditorLayer(api, ctx, layer);
  await new Promise((resolve) => setTimeout(resolve, 10));

  const editor = editorFactory!(
    {} as never,
    {} as never,
    {} as never,
  ) as unknown as { layers: string[] };
  assert.deepEqual(editor, {
    layers: ["test-layer"],
  });
});

function ownershipHarness() {
  const lifecycle = new Map<
    string,
    (event: unknown, ctx: ExtensionContext) => void
  >();
  const api = {
    events: createEventBus(),
    on(
      event: string,
      handler: (event: unknown, ctx: ExtensionContext) => void,
    ) {
      lifecycle.set(event, handler);
    },
  } as unknown as ExtensionAPI;
  const ui = (name: string) => {
    let baseCalls = 0;
    let factory = (() => {
      baseCalls += 1;
      return { layers: [name] };
    }) as unknown as EditorFactory;
    return {
      baseCalls: () => baseCalls,
      getEditorComponent: () => factory,
      setEditorComponent(next: EditorFactory | undefined) {
        factory = next!;
      },
    };
  };
  const context = (owner: ReturnType<typeof ui>) =>
    ({ mode: "tui", ui: owner }) as unknown as ExtensionContext;
  const layer = (id: string, order = 1) =>
    ({
      id,
      order,
      wrap: (base: { layers: string[] }) => ({ layers: [...base.layers, id] }),
    }) as unknown as EditorLayer;
  const rendered = (owner: ReturnType<typeof ui>) =>
    owner.getEditorComponent()(
      {} as never,
      {} as never,
      {} as never,
    ) as unknown as { layers: string[] };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
  return {
    api,
    ui,
    context,
    layer,
    rendered,
    settle,
    shutdown: (owner: ReturnType<typeof ui>) =>
      lifecycle.get("session_shutdown")?.(
        { type: "session_shutdown" },
        context(owner),
      ),
  };
}

test("fresh native contexts do not reread a stale prior context", async () => {
  const h = ownershipHarness();
  const ui = h.ui("native");
  let stale = false;
  const ctx = {
    get mode() {
      assert.equal(stale, false, "captured context is stale");
      return "tui";
    },
    get ui() {
      assert.equal(stale, false, "captured context is stale");
      return ui;
    },
  } as unknown as ExtensionContext;
  registerEditorLayer(h.api, ctx, h.layer("one"));
  await h.settle();
  stale = true;
  assert.doesNotThrow(() =>
    registerEditorLayer(h.api, h.context(ui), h.layer("two", 2)),
  );
  await h.settle();
  assert.deepEqual(h.rendered(ui).layers, ["native", "one", "two"]);
});

test("session shutdown cancels an editor projection queued before replacement", async () => {
  const h = ownershipHarness();
  const ui = h.ui("native");
  const base = ui.getEditorComponent();
  registerEditorLayer(h.api, h.context(ui), h.layer("old"));
  h.shutdown(ui);
  await h.settle();
  assert.equal(ui.getEditorComponent(), base);
  registerEditorLayer(h.api, h.context(ui), h.layer("new"));
  await h.settle();
  assert.deepEqual(h.rendered(ui).layers, ["native", "new"]);
});

test("session shutdown restores the base before a new native UI wrapper registers", async () => {
  const h = ownershipHarness();
  const ui = h.ui("native");
  const base = ui.getEditorComponent();
  registerEditorLayer(h.api, h.context(ui), h.layer("old"));
  await h.settle();
  h.shutdown(ui);
  assert.equal(ui.getEditorComponent(), base);
  const nextUi = { ...ui };
  registerEditorLayer(h.api, h.context(nextUi), h.layer("new"));
  await h.settle();
  assert.deepEqual(h.rendered(nextUi).layers, ["native", "new"]);
});

test("session shutdown preserves a foreign editor and ignores another UI owner", async () => {
  const h = ownershipHarness();
  const ui = h.ui("native");
  registerEditorLayer(h.api, h.context(ui), h.layer("old"));
  await h.settle();
  h.shutdown(h.ui("unrelated"));
  assert.deepEqual(h.rendered(ui).layers, ["native", "old"]);
  const replacement = h.ui("foreign").getEditorComponent();
  ui.setEditorComponent(replacement);
  h.shutdown(ui);
  assert.equal(ui.getEditorComponent(), replacement);
  const nextUi = { ...ui };
  registerEditorLayer(h.api, h.context(nextUi), h.layer("new"));
  await h.settle();
  assert.deepEqual(h.rendered(nextUi).layers, ["foreign", "new"]);
});

test("fresh contexts sharing one UI retain distinct layers and replace matching IDs", async () => {
  const h = ownershipHarness();
  const ui = h.ui("native");
  registerEditorLayer(h.api, h.context(ui), h.layer("two", 2));
  await h.settle();
  registerEditorLayer(h.api, h.context(ui), h.layer("one"));
  await h.settle();
  registerEditorLayer(h.api, h.context(ui), h.layer("one"));
  await h.settle();
  assert.deepEqual(h.rendered(ui).layers, ["native", "one", "two"]);
  assert.equal(ui.baseCalls(), 1);
});

test("removing all layers and registering again preserves the original base", async () => {
  const h = ownershipHarness();
  const ui = h.ui("native");
  const base = ui.getEditorComponent();
  registerEditorLayer(h.api, h.context(ui), h.layer("one"));
  await h.settle();
  removeEditorLayer(h.api, "one");
  assert.equal(ui.getEditorComponent(), base);
  registerEditorLayer(h.api, h.context(ui), h.layer("one"));
  await h.settle();
  assert.deepEqual(h.rendered(ui).layers, ["native", "one"]);
});

test("switching and revisiting UIs retains their own base without stale layers", async () => {
  const h = ownershipHarness();
  const first = h.ui("first");
  const second = h.ui("second");
  registerEditorLayer(h.api, h.context(first), h.layer("old"));
  await h.settle();
  registerEditorLayer(h.api, h.context(second), h.layer("new"));
  await h.settle();
  assert.deepEqual(h.rendered(second).layers, ["second", "new"]);
  registerEditorLayer(h.api, h.context(first), h.layer("returned"));
  await h.settle();
  assert.deepEqual(h.rendered(first).layers, ["first", "returned"]);
});

test("native factory replacement becomes the base on the next registration", async () => {
  const h = ownershipHarness();
  const ui = h.ui("native");
  registerEditorLayer(h.api, h.context(ui), h.layer("one"));
  await h.settle();
  ui.setEditorComponent(h.ui("replacement").getEditorComponent());
  registerEditorLayer(h.api, h.context(ui), h.layer("two", 2));
  await h.settle();
  assert.deepEqual(h.rendered(ui).layers, ["replacement", "one", "two"]);
});

test("queued installation and removal do not overwrite a foreign editor owner", async () => {
  const h = ownershipHarness();
  const ui = h.ui("native");
  const replacement = h.ui("replacement").getEditorComponent();
  registerEditorLayer(h.api, h.context(ui), h.layer("one"));
  ui.setEditorComponent(replacement);
  await h.settle();
  assert.equal(ui.getEditorComponent(), replacement);
  removeEditorLayer(h.api, "one");
  assert.equal(ui.getEditorComponent(), replacement);
});

test("queued UI switches and last removal cancel stale installation", async () => {
  const h = ownershipHarness();
  const first = h.ui("first");
  const second = h.ui("second");
  const base = first.getEditorComponent();
  registerEditorLayer(h.api, h.context(first), h.layer("old"));
  registerEditorLayer(h.api, h.context(second), h.layer("new"));
  removeEditorLayer(h.api, "new");
  await h.settle();
  assert.equal(first.getEditorComponent(), base);
  assert.deepEqual(h.rendered(second).layers, ["second"]);
});

test("removing one layer reprojects remaining layers without stacking", async () => {
  const h = ownershipHarness();
  const ui = h.ui("native");
  registerEditorLayer(h.api, h.context(ui), h.layer("one"));
  registerEditorLayer(h.api, h.context(ui), h.layer("two", 2));
  await h.settle();
  removeEditorLayer(h.api, "one");
  await h.settle();
  assert.deepEqual(h.rendered(ui).layers, ["native", "two"]);
});

test("last removal preserves an external replacement of an installed projection", async () => {
  const h = ownershipHarness();
  const ui = h.ui("native");
  registerEditorLayer(h.api, h.context(ui), h.layer("one"));
  await h.settle();
  const replacement = h.ui("replacement").getEditorComponent();
  ui.setEditorComponent(replacement);
  removeEditorLayer(h.api, "one");
  assert.equal(ui.getEditorComponent(), replacement);
  registerEditorLayer(h.api, h.context(ui), h.layer("one"));
  await h.settle();
  assert.deepEqual(h.rendered(ui).layers, ["replacement", "one"]);
});

test("a native default-editor reset after removal remains the next base", async () => {
  const h = ownershipHarness();
  const ui = h.ui("native");
  registerEditorLayer(h.api, h.context(ui), h.layer("one"));
  await h.settle();
  removeEditorLayer(h.api, "one");
  ui.setEditorComponent(undefined);
  registerEditorLayer(h.api, h.context(ui), h.layer("one"));
  await h.settle();
  removeEditorLayer(h.api, "one");
  assert.equal(ui.getEditorComponent(), undefined);
});

test("contexts without a UI do not acquire editor ownership", async () => {
  const h = ownershipHarness();
  const ctx = { mode: "tui" } as unknown as ExtensionContext;
  assert.doesNotThrow(() => registerEditorLayer(h.api, ctx, h.layer("one")));
  assert.doesNotThrow(() => removeEditorLayer(h.api, "one"));
  await h.settle();
});

test("last removal before installation preserves a native default reset", async () => {
  const h = ownershipHarness();
  const ui = h.ui("native");
  registerEditorLayer(h.api, h.context(ui), h.layer("one"));
  ui.setEditorComponent(undefined);
  removeEditorLayer(h.api, "one");
  assert.equal(ui.getEditorComponent(), undefined);
  await h.settle();
  assert.equal(ui.getEditorComponent(), undefined);
});
