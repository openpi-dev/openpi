import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { createContext, runInContext } from "node:vm";
import {
  EmbeddedBrowserInputTargetError,
  EmbeddedBrowserManager,
} from "../../web/host/embedded-browser.ts";
import type { WebEmbeddedBrowserState } from "../../web/protocol/types.ts";

class FixtureNode {
  readonly localName: string;
  type = "text";
  readOnly = false;
  disabled = false;
  isConnected = true;
  isContentEditable = false;
  parentElement: FixtureNode | null = null;
  shadowRoot: { activeElement: FixtureNode | null } | null = null;
  contentDocument: FixtureDocument | null = null;
  clientLeft = 0;
  clientTop = 0;
  offsetWidth = 0;
  offsetHeight = 0;
  rect = { left: 20, top: 30, width: 180, height: 40 };

  constructor(localName: string) {
    this.localName = localName;
  }

  get value() {
    return assert.fail("the native input probe must not read field values");
  }

  getBoundingClientRect() {
    return this.rect;
  }
}

class FixtureDocument {
  activeElement: FixtureNode | null;
  defaultView = {
    getComputedStyle: () => ({ transform: "none" }),
    addEventListener: (
      type: string,
      listener: (event: { type: string }) => void,
    ) => this.addEventListener(type, listener),
  };
  private readonly listeners = new Map<
    string,
    Set<(event: { type: string }) => void>
  >();

  constructor(active: FixtureNode | null) {
    this.activeElement = active;
  }

  addEventListener(type: string, listener: (event: { type: string }) => void) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  emit(type: string) {
    for (const listener of this.listeners.get(type) ?? []) listener({ type });
  }

  focus(node: FixtureNode | null) {
    this.activeElement = null;
    this.emit("focusout");
    this.activeElement = node;
    this.emit("focusin");
  }
}

function browserFixture(root = new FixtureNode("input")) {
  const document = new FixtureDocument(root);
  const listeners = new Map<
    string,
    Set<(params: Record<string, unknown>) => void>
  >();
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const contexts = new Map<number, ReturnType<typeof createContext>>();
  let nextContext = 0;
  let inputHook: (() => void) | undefined;
  let probeHook: (() => void) | undefined;
  let probeOverride: { value: unknown } | { error: true } | undefined;
  let closed = false;
  const emit = (method: string, params: Record<string, unknown> = {}) => {
    for (const listener of listeners.get(method) ?? []) listener(params);
  };
  const cdp = {
    on(method: string, listener: (params: Record<string, unknown>) => void) {
      const set = listeners.get(method) ?? new Set();
      set.add(listener);
      listeners.set(method, set);
      return () => set.delete(listener);
    },
    close() {
      closed = true;
    },
    async send(
      method: string,
      params: Record<string, unknown> = {},
    ): Promise<Record<string, unknown>> {
      calls.push({ method, params });
      if (method === "Page.getFrameTree")
        return { frameTree: { frame: { id: "fixture-main-frame" } } };
      if (method === "Page.createIsolatedWorld") {
        const id = ++nextContext;
        contexts.set(id, createContext({ document }));
        return { executionContextId: id };
      }
      if (method === "Runtime.addBinding") {
        const id = Number(params.executionContextId);
        const context = contexts.get(id);
        assert.ok(context);
        context[String(params.name)] = (payload: string) =>
          emit("Runtime.bindingCalled", {
            name: params.name,
            executionContextId: id,
            payload,
          });
      }
      if (method === "Runtime.evaluate") {
        if (params.expression === "location.href")
          return { result: { value: "http://fixture.invalid/" } };
        if (params.expression === "document.title")
          return { result: { value: "Input fixture" } };
        const context = contexts.get(Number(params.contextId));
        assert.ok(
          context,
          "the focus projection must run in an isolated context",
        );
        if (
          String(params.expression).endsWith("InputProbe()") &&
          probeOverride
        ) {
          if ("error" in probeOverride) throw new Error("fixture context lost");
          return { result: { value: probeOverride.value } };
        }
        const value = runInContext(String(params.expression), context);
        if (String(params.expression).endsWith("InputProbe()")) probeHook?.();
        return { result: { value } };
      }
      if (method === "Page.getNavigationHistory")
        return { currentIndex: 0, entries: [] };
      if (
        [
          "Input.dispatchKeyEvent",
          "Input.dispatchMouseEvent",
          "Input.insertText",
        ].includes(method)
      )
        inputHook?.();
      return {};
    },
  };
  const manager = new EmbeddedBrowserManager();
  const native: {
    sessionId: string;
    process: { exitCode: number; signalCode: null };
    closed: Promise<void>;
    profile: string;
    cdp: typeof cdp;
    width: number;
    height: number;
    deviceScaleFactor: number;
    url: string;
    title: string;
    loading: boolean;
    canGoBack: boolean;
    canGoForward: boolean;
    frameListeners: Set<() => void>;
    stopListening: () => void;
    inputTarget?: WebEmbeddedBrowserState["inputTarget"];
  } = {
    sessionId: "fixture",
    process: { exitCode: 0, signalCode: null },
    closed: Promise.resolve(),
    profile: join(tmpdir(), `openpi-browser-input-absent-${randomUUID()}`),
    cdp,
    width: 800,
    height: 600,
    deviceScaleFactor: 1,
    url: "http://fixture.invalid/",
    title: "Input fixture",
    loading: false,
    canGoBack: false,
    canGoForward: false,
    frameListeners: new Set(),
    stopListening() {},
  };
  Object.assign(manager, { session: native });
  return {
    manager,
    native,
    document,
    root,
    calls,
    emit,
    listeners,
    setInputHook: (hook: () => void) => {
      inputHook = hook;
    },
    setProbeHook: (hook: () => void) => {
      probeHook = hook;
    },
    setProbeOverride: (value: typeof probeOverride) => {
      probeOverride = value;
    },
    isClosed: () => closed,
  };
}

test("native focus projection is isolated, bounded and does not read field values", async () => {
  const fixture = browserFixture();
  const state = await fixture.manager.state("fixture");
  assert.equal(state?.inputTarget?.kind, "input");
  assert.match(state.inputTarget.owner, /^[\da-f-]{36}:\d+:\d+$/u);
  assert.deepEqual(state.inputTarget.anchorRect, {
    x: 20,
    y: 30,
    width: 180,
    height: 40,
  });
  assert.deepEqual(Object.keys(state.inputTarget).sort(), [
    "anchorRect",
    "kind",
    "owner",
  ]);
  assert.deepEqual(
    fixture.calls.find((call) => call.method === "Page.createIsolatedWorld")
      ?.params,
    {
      frameId: "fixture-main-frame",
      worldName: "openpi-browser-input",
      grantUniveralAccess: false,
    },
  );
  assert.ok(
    fixture.calls.filter(
      (call) => call.method === "Runtime.evaluate" && call.params.contextId,
    ).length >= 2,
  );
  await fixture.manager.dispose();
});

test("native focus distinguishes noneditable controls from unsupported shadow hosts", async () => {
  const fixture = browserFixture();
  for (const node of [
    new FixtureNode("button"),
    Object.assign(new FixtureNode("input"), { readOnly: true }),
    Object.assign(new FixtureNode("textarea"), { disabled: true }),
    Object.assign(new FixtureNode("input"), { type: "checkbox" }),
  ]) {
    fixture.document.focus(node);
    assert.equal((await fixture.manager.state("fixture"))?.inputTarget, null);
  }
  for (const node of [
    new FixtureNode("custom-closed-editor"),
    new FixtureNode("div"),
    new FixtureNode("iframe"),
  ]) {
    fixture.document.focus(node);
    assert.equal(
      "inputTarget" in ((await fixture.manager.state("fixture")) ?? {}),
      false,
    );
  }
  await fixture.manager.dispose();
});

test("a focused password input has no native text proxy receipt", async () => {
  const root = Object.assign(new FixtureNode("input"), { type: "password" });
  const fixture = browserFixture(root);
  const state = await fixture.manager.state("fixture");
  assert.equal("inputTarget" in (state ?? {}), false);
  await fixture.manager.dispose();
});

test("a focused text field becoming a password rejects its old owner while ownerless native input remains compatible", async () => {
  const fixture = browserFixture();
  const owner = (await fixture.manager.state("fixture"))?.inputTarget?.owner;
  assert.ok(owner);
  fixture.root.type = "password";
  for (const action of [
    { type: "text", text: "old draft", owner },
    { type: "key", event: "down", key: "Backspace", owner },
    { type: "key", event: "up", key: "Backspace", owner },
  ] as const)
    await assert.rejects(
      fixture.manager.action("fixture", action),
      EmbeddedBrowserInputTargetError,
    );
  assert.equal(
    fixture.calls.some(
      (call) =>
        call.method === "Input.insertText" ||
        call.method === "Input.dispatchKeyEvent",
    ),
    false,
  );
  await fixture.manager.action("fixture", {
    type: "text",
    text: "legacy paste",
  });
  await fixture.manager.action("fixture", {
    type: "key",
    event: "down",
    key: "a",
    text: "a",
  });
  assert.deepEqual(
    fixture.calls
      .filter(
        (call) =>
          call.method === "Input.insertText" ||
          call.method === "Input.dispatchKeyEvent",
      )
      .map((call) => call.params.text),
    ["legacy paste", "a"],
  );
  assert.equal(
    "inputTarget" in ((await fixture.manager.state("fixture")) ?? {}),
    false,
  );
  await fixture.manager.dispose();
});

test("native probe follows open shadow and same-origin iframe focus without reading values", async () => {
  const shadow = new FixtureNode("custom-editor");
  shadow.shadowRoot = { activeElement: new FixtureNode("textarea") };
  const fixture = browserFixture(shadow);
  assert.equal(
    (await fixture.manager.state("fixture"))?.inputTarget?.kind,
    "textarea",
  );
  const frame = new FixtureNode("iframe");
  frame.rect = { left: 100, top: 80, width: 400, height: 300 };
  frame.contentDocument = new FixtureDocument(new FixtureNode("input"));
  fixture.document.focus(frame);
  assert.deepEqual(
    (await fixture.manager.state("fixture"))?.inputTarget?.anchorRect,
    { x: 120, y: 110, width: 180, height: 40 },
  );
  const editor = new FixtureNode("div");
  editor.isContentEditable = true;
  const child = new FixtureNode("span");
  child.isContentEditable = true;
  child.parentElement = editor;
  frame.contentDocument.focus(child);
  assert.equal(
    (await fixture.manager.state("fixture"))?.inputTarget?.kind,
    "contenteditable",
  );
  await fixture.manager.dispose();
});

test("stale text owner is rejected at actual native focus without refocusing or native composition", async () => {
  const fixture = browserFixture();
  const target = (await fixture.manager.state("fixture"))?.inputTarget;
  assert.ok(target);
  fixture.document.focus(new FixtureNode("textarea"));
  await assert.rejects(
    fixture.manager.action("fixture", {
      type: "text",
      text: "private draft",
      owner: target.owner,
    }),
    EmbeddedBrowserInputTargetError,
  );
  assert.equal(
    fixture.calls.some((call) =>
      ["Input.insertText", "Input.imeSetComposition", "DOM.focus"].includes(
        call.method,
      ),
    ),
    false,
  );
  await fixture.manager.dispose();
});

test("focus A to B to A before the queued probe cannot reuse the old receipt", async () => {
  const fixture = browserFixture();
  const old = (await fixture.manager.state("fixture"))?.inputTarget;
  assert.ok(old);
  fixture.document.focus(new FixtureNode("textarea"));
  fixture.document.focus(fixture.root);
  await setImmediate();
  assert.ok(fixture.native.inputTarget);
  assert.notEqual(fixture.native.inputTarget.owner, old.owner);
  await assert.rejects(
    fixture.manager.action("fixture", {
      type: "text",
      text: "old composition",
      owner: old.owner,
    }),
    EmbeddedBrowserInputTargetError,
  );
  await fixture.manager.dispose();
});

test("input receipts refresh after mouse release and Tab but ordinary input stays on the cached hot path", async () => {
  const fixture = browserFixture();
  await fixture.manager.state("fixture");
  fixture.calls.length = 0;
  await fixture.manager.action("fixture", {
    type: "mouse",
    event: "move",
    x: 1,
    y: 1,
  });
  await fixture.manager.action("fixture", {
    type: "key",
    event: "down",
    key: "a",
    text: "a",
  });
  assert.equal(
    fixture.calls.some((call) => call.method === "Runtime.evaluate"),
    false,
  );
  fixture.setInputHook(() =>
    fixture.document.focus(new FixtureNode("textarea")),
  );
  assert.equal(
    (
      await fixture.manager.action("fixture", {
        type: "mouse",
        event: "up",
        x: 1,
        y: 1,
      })
    )?.inputTarget?.kind,
    "textarea",
  );
  fixture.setInputHook(() => fixture.document.focus(new FixtureNode("input")));
  assert.equal(
    (
      await fixture.manager.action("fixture", {
        type: "key",
        event: "down",
        key: "Tab",
      })
    )?.inputTarget?.kind,
    "input",
  );
  await fixture.manager.dispose();
});

test("native text supports owner admission and the existing ownerless compatibility path", async () => {
  const fixture = browserFixture();
  const owner = (await fixture.manager.state("fixture"))?.inputTarget?.owner;
  assert.ok(owner);
  await fixture.manager.action("fixture", {
    type: "text",
    text: "committed 中文",
    owner,
  });
  fixture.document.focus(new FixtureNode("button"));
  await fixture.manager.action("fixture", {
    type: "text",
    text: "legacy paste",
  });
  assert.deepEqual(
    fixture.calls
      .filter((call) => call.method === "Input.insertText")
      .map((call) => call.params),
    [{ text: "committed 中文" }, { text: "legacy paste" }],
  );
  await fixture.manager.dispose();
});

test("physical text followed by rapid owned Unicode commits survives same-field selection wakes during native probes", async () => {
  const fixture = browserFixture();
  const owner = (await fixture.manager.state("fixture"))?.inputTarget?.owner;
  assert.ok(owner);
  let pendingSelection = false;
  fixture.setInputHook(() => {
    pendingSelection = true;
  });
  fixture.setProbeHook(() => {
    if (!pendingSelection) return;
    pendingSelection = false;
    fixture.document.emit("selectionchange");
  });
  await fixture.manager.action("fixture", {
    type: "key",
    event: "down",
    key: "你",
    text: "你",
  });
  for (const text of ["好", "🙂"]) {
    const receipt = await fixture.manager.action("fixture", {
      type: "text",
      text,
      owner,
    });
    assert.equal(receipt?.inputTarget?.owner, owner);
  }
  assert.deepEqual(
    fixture.calls
      .filter(
        (call) =>
          call.method === "Input.dispatchKeyEvent" ||
          call.method === "Input.insertText",
      )
      .map((call) => call.params.text),
    ["你", "好", "🙂"],
  );
  await fixture.manager.dispose();
});

test("a focus departure and return during a native probe still rejects the previous owner without replaying input", async () => {
  const fixture = browserFixture();
  const owner = (await fixture.manager.state("fixture"))?.inputTarget?.owner;
  assert.ok(owner);
  let pendingFocus = true;
  fixture.setProbeHook(() => {
    if (!pendingFocus) return;
    pendingFocus = false;
    fixture.document.focus(new FixtureNode("textarea"));
    fixture.document.focus(fixture.root);
  });
  await assert.rejects(
    fixture.manager.action("fixture", {
      type: "text",
      text: "old composition",
      owner,
    }),
    EmbeddedBrowserInputTargetError,
  );
  assert.equal(
    fixture.calls.some((call) => call.method === "Input.insertText"),
    false,
  );
  await fixture.manager.dispose();
});

test("native admission remains bounded when both focus probes receive selection wakes", async () => {
  const fixture = browserFixture();
  const owner = (await fixture.manager.state("fixture"))?.inputTarget?.owner;
  assert.ok(owner);
  let invalidations = 2;
  fixture.setProbeHook(() => {
    if (invalidations === 0) return;
    invalidations--;
    fixture.document.emit("selectionchange");
  });
  await assert.rejects(
    fixture.manager.action("fixture", {
      type: "text",
      text: "not replayed",
      owner,
    }),
    EmbeddedBrowserInputTargetError,
  );
  assert.equal(invalidations, 0);
  assert.equal(
    fixture.calls.some((call) => call.method === "Input.insertText"),
    false,
  );
  await fixture.manager.dispose();
});

test("owned editing key pairs admit the current field and reject stale delete commands before dispatch", async () => {
  const fixture = browserFixture();
  const owner = (await fixture.manager.state("fixture"))?.inputTarget?.owner;
  assert.ok(owner);
  for (const key of ["Backspace", "Delete", "Enter"]) {
    for (const event of ["down", "up"] as const)
      await fixture.manager.action("fixture", {
        type: "key",
        event,
        key,
        owner,
      });
  }
  assert.deepEqual(
    fixture.calls
      .filter((call) => call.method === "Input.dispatchKeyEvent")
      .map((call) => [call.params.type, call.params.key]),
    [
      ["keyDown", "Backspace"],
      ["keyUp", "Backspace"],
      ["keyDown", "Delete"],
      ["keyUp", "Delete"],
      ["keyDown", "Enter"],
      ["keyUp", "Enter"],
    ],
  );
  fixture.calls.length = 0;
  fixture.document.focus(new FixtureNode("textarea"));
  for (const key of ["Backspace", "Delete", "Enter"]) {
    for (const event of ["down", "up"] as const)
      await assert.rejects(
        fixture.manager.action("fixture", { type: "key", event, key, owner }),
        EmbeddedBrowserInputTargetError,
      );
  }
  assert.equal(
    fixture.calls.some((call) => call.method === "Input.dispatchKeyEvent"),
    false,
  );
  await fixture.manager.action("fixture", {
    type: "key",
    event: "down",
    key: "Backspace",
  });
  assert.equal(
    fixture.calls.filter((call) => call.method === "Input.dispatchKeyEvent")
      .length,
    1,
  );
  await fixture.manager.dispose();
});

test("an owned key release cannot be dispatched after navigation or context replacement changes its target", async () => {
  for (const event of [
    "Page.frameNavigated",
    "Runtime.executionContextsCleared",
  ]) {
    const fixture = browserFixture();
    const owner = (await fixture.manager.state("fixture"))?.inputTarget?.owner;
    assert.ok(owner);
    await fixture.manager.action("fixture", {
      type: "key",
      event: "down",
      key: "Enter",
      owner,
    });
    fixture.emit(event, {
      frame: { id: "fixture-main-frame", url: "http://fixture.invalid/" },
    });
    await assert.rejects(
      fixture.manager.action("fixture", {
        type: "key",
        event: "up",
        key: "Enter",
        owner,
      }),
      EmbeddedBrowserInputTargetError,
    );
    assert.equal(
      fixture.calls.filter((call) => call.method === "Input.dispatchKeyEvent")
        .length,
      1,
    );
    await fixture.manager.dispose();
  }
});

test("navigation and context replacement invalidate receipts even at the same URL", async () => {
  const fixture = browserFixture();
  const initial = (await fixture.manager.state("fixture"))?.inputTarget?.owner;
  assert.ok(initial);
  fixture.emit("Page.frameNavigated", {
    frame: { id: "fixture-main-frame", url: "http://fixture.invalid/" },
  });
  await setImmediate();
  assert.ok(fixture.native.inputTarget);
  assert.notEqual(fixture.native.inputTarget.owner, initial);
  const next = fixture.native.inputTarget.owner;
  fixture.emit("Runtime.executionContextsCleared");
  await setImmediate();
  assert.ok(fixture.native.inputTarget);
  assert.notEqual(fixture.native.inputTarget.owner, next);
  await assert.rejects(
    fixture.manager.action("fixture", {
      type: "text",
      text: "late",
      owner: initial,
    }),
    EmbeddedBrowserInputTargetError,
  );
  await fixture.manager.dispose();
});

test("a same-origin child document leaving and returning cannot reuse its old focus receipt", async () => {
  const frame = new FixtureNode("iframe");
  frame.contentDocument = new FixtureDocument(new FixtureNode("input"));
  const fixture = browserFixture(frame);
  const old = (await fixture.manager.state("fixture"))?.inputTarget;
  assert.ok(old);
  frame.contentDocument.emit("pagehide");
  frame.contentDocument.emit("pageshow");
  await setImmediate();
  assert.ok(fixture.native.inputTarget);
  assert.notEqual(fixture.native.inputTarget.owner, old.owner);
  await assert.rejects(
    fixture.manager.action("fixture", {
      type: "text",
      text: "old document composition",
      owner: old.owner,
    }),
    EmbeddedBrowserInputTargetError,
  );
  await fixture.manager.dispose();
});

test("a focus probe arriving after its context was cleared cannot restore the old receipt", async () => {
  const fixture = browserFixture();
  const old = (await fixture.manager.state("fixture"))?.inputTarget;
  assert.ok(old);
  const send = fixture.native.cdp.send;
  let release!: () => void;
  let start!: () => void;
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });
  let pause = true;
  fixture.native.cdp.send = async (method, params = {}) => {
    const result = await send(method, params);
    if (
      pause &&
      method === "Runtime.evaluate" &&
      String(params.expression).endsWith("InputProbe()")
    ) {
      pause = false;
      start();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }
    return result;
  };
  const pending = fixture.manager.state("fixture");
  await started;
  fixture.emit("Runtime.executionContextsCleared");
  release();
  assert.equal((await pending)?.inputTarget, undefined);
  await setImmediate();
  assert.ok(fixture.native.inputTarget);
  assert.notEqual(fixture.native.inputTarget.owner, old.owner);
  await fixture.manager.dispose();
});

test("binding wakeups never trust their target payload or a different execution context", async () => {
  const fixture = browserFixture();
  const currentTarget = () => fixture.native.inputTarget;
  const target = (await fixture.manager.state("fixture"))?.inputTarget;
  assert.ok(target);
  fixture.emit("Runtime.bindingCalled", {
    name: "__openpiBrowserInputWake",
    executionContextId: -1,
    payload: JSON.stringify({ owner: "forged" }),
  });
  assert.equal(fixture.native.inputTarget?.owner, target.owner);
  fixture.emit("Runtime.bindingCalled", {
    name: "__openpiBrowserInputWake",
    executionContextId: 1,
    payload: JSON.stringify({ owner: "forged", value: "secret" }),
  });
  assert.equal(fixture.native.inputTarget, undefined);
  await setImmediate();
  assert.equal(currentTarget()?.owner, target.owner);
  await fixture.manager.dispose();
});

test("unknown, malformed and failed native probes cannot admit an old owner", async () => {
  const fixture = browserFixture();
  const owner = (await fixture.manager.state("fixture"))?.inputTarget?.owner;
  assert.ok(owner);
  for (const value of [
    undefined,
    {
      owner: "1:0",
      kind: "input",
      anchorRect: { x: Infinity, y: 0, width: 10, height: 10 },
    },
    {
      owner: "page-controlled",
      kind: "input",
      anchorRect: { x: 0, y: 0, width: 10, height: 10 },
    },
  ]) {
    fixture.setProbeOverride({ value });
    await assert.rejects(
      fixture.manager.action("fixture", { type: "text", text: "late", owner }),
      EmbeddedBrowserInputTargetError,
    );
    assert.equal(fixture.native.inputTarget, undefined);
  }
  fixture.setProbeOverride({ error: true });
  assert.equal(
    (await fixture.manager.state("fixture"))?.inputTarget,
    undefined,
  );
  assert.equal(
    fixture.calls.some((call) => call.method === "Input.insertText"),
    false,
  );
  await fixture.manager.dispose();
});

test("native disposal removes focus listeners and no later wake restarts the disposed browser", async () => {
  const fixture = browserFixture();
  await fixture.manager.state("fixture");
  await fixture.manager.dispose();
  assert.equal(fixture.isClosed(), true);
  assert.equal(fixture.native.inputTarget, undefined);
  assert.equal(
    [...fixture.listeners.values()].some((listeners) => listeners.size > 0),
    false,
  );
  const calls = fixture.calls.length;
  fixture.document.focus(new FixtureNode("textarea"));
  await setImmediate();
  assert.equal(fixture.calls.length, calls);
  assert.equal(await fixture.manager.state("fixture"), undefined);
});
