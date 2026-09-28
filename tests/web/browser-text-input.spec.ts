// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { type ComponentProps, createElement, createRef } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BrowserTextInput } from "../../web/ui/src/features/workbar/BrowserTextInput.tsx";

type Props = ComponentProps<typeof BrowserTextInput>;

function inputTarget(owner = "page-a:field-a") {
  return {
    owner,
    kind: "textarea" as const,
    anchorRect: { x: 120, y: 80, width: 180, height: 24 },
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function setup(overrides: Partial<Props> = {}) {
  const inputRef = createRef<HTMLTextAreaElement>();
  const onText = vi.fn((_text: string, _owner: string) => {});
  const onEditingKey = vi.fn(
    (_key: "Backspace" | "Delete" | "Enter", _owner: string) => {},
  );
  const keyDown = vi.fn();
  const keyUp = vi.fn();
  const paste = vi.fn();
  let props: Props = {
    inputRef,
    target: inputTarget(),
    active: true,
    label: "Embedded page text input",
    width: 800,
    height: 600,
    onText,
    onEditingKey,
    ...overrides,
  };
  const element = () =>
    createElement(
      "div",
      {
        onKeyDown: keyDown,
        onKeyUp: keyUp,
        onPaste: paste,
      },
      createElement(BrowserTextInput, props),
    );
  const view = render(element());
  const input = screen.getByRole<HTMLTextAreaElement>("textbox", {
    name: props.label,
  });
  act(() => input.focus());
  return {
    input,
    onText,
    onEditingKey,
    keyDown,
    keyUp,
    paste,
    get currentInput() {
      if (!inputRef.current) throw new Error("Text input is not mounted");
      return inputRef.current;
    },
    update(patch: Partial<Props>) {
      props = { ...props, ...patch };
      view.rerender(element());
    },
    unmount: view.unmount,
  };
}

function beforeInput(
  input: HTMLTextAreaElement,
  inputType: string,
  data: string | null = null,
  isComposing = false,
) {
  const event = new InputEvent("beforeinput", {
    bubbles: true,
    cancelable: true,
    inputType,
    data,
    isComposing,
  });
  act(() => input.dispatchEvent(event));
  return event;
}

function updateValue(
  input: HTMLTextAreaElement,
  value: string,
  inputType = "insertText",
  isComposing = false,
) {
  fireEvent.input(input, {
    target: { value },
    inputType,
    data: value,
    isComposing,
  });
}

function compose(input: HTMLTextAreaElement, value: string) {
  fireEvent.compositionStart(input, { data: "" });
  fireEvent.compositionUpdate(input, { data: value });
  updateValue(input, value, "insertCompositionText", true);
}

function flush() {
  act(() => vi.runOnlyPendingTimers());
}

it.each(["before", "after"] as const)(
  "commits the final DOM text once when final input is %s compositionend",
  (order) => {
    const ui = setup();
    compose(ui.input, "ni");
    expect(ui.onText).not.toHaveBeenCalled();
    if (order === "before")
      updateValue(ui.input, "你好", "insertCompositionText", false);
    fireEvent.compositionEnd(ui.input, { data: "unreliable endpoint data" });
    if (order === "after") updateValue(ui.input, "你好", "insertText", false);
    expect(ui.onText).not.toHaveBeenCalled();
    flush();
    expect(ui.onText.mock.calls).toEqual([["你好", "page-a:field-a"]]);
    updateValue(ui.input, "你好", "insertText", false);
    fireEvent.compositionEnd(ui.input, { data: "你好" });
    flush();
    expect(ui.onText).toHaveBeenCalledOnce();
  },
);

it("accepts identical committed Chinese transactions separately by position", () => {
  const ui = setup();
  for (const value of ["哈", "哈哈"]) {
    compose(ui.input, value);
    fireEvent.compositionEnd(ui.input, { data: "哈" });
    flush();
  }
  expect(ui.onText.mock.calls).toEqual([
    ["哈", "page-a:field-a"],
    ["哈", "page-a:field-a"],
  ]);
});

it.each(["😀", "中文", "👨‍👩‍👧‍👦"])(
  "accepts repeated mobile or emoji insertion without keydown: %s",
  (text) => {
    const ui = setup();
    for (let index = 0; index < 2; index++) {
      const event = beforeInput(ui.input, "insertText", text);
      expect(event.defaultPrevented).toBe(false);
      expect(ui.input.value).toBe("");
      updateValue(ui.input, text);
    }
    expect(ui.onText.mock.calls).toEqual([
      [text, "page-a:field-a"],
      [text, "page-a:field-a"],
    ]);
    expect(ui.keyDown).not.toHaveBeenCalled();
    expect(ui.onEditingKey).not.toHaveBeenCalled();
  },
);

it.each([
  { key: "a", code: "KeyA", keyCode: 229 },
  { key: "Process", code: "KeyA" },
  { key: "Unidentified", code: "" },
  { key: "Dead", code: "Quote" },
  {
    key: "a",
    code: "KeyA",
    altKey: true,
    ctrlKey: true,
    modifierAltGraph: true,
  },
  { key: "å", code: "KeyA", altKey: true },
  { key: "a", code: "KeyA", isComposing: true },
])(
  "keeps native text key %j out of the remote key route without canceling IME",
  (key) => {
    const ui = setup();
    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      ...key,
    });
    fireEvent(ui.input, event);
    expect(event.defaultPrevented).toBe(false);
    expect(ui.keyDown).not.toHaveBeenCalled();
    expect(ui.onText).not.toHaveBeenCalled();
    beforeInput(ui.input, "insertText", "á");
    updateValue(ui.input, "á");
    expect(ui.onText.mock.calls).toEqual([["á", "page-a:field-a"]]);
    fireEvent.keyDown(ui.input, { key: "Enter", code: "Enter" });
    expect(ui.keyDown).toHaveBeenCalledOnce();
  },
);

it.each(["Enter", "Escape"])(
  "keeps candidate %s down and up local during composition",
  (key) => {
    const ui = setup();
    compose(ui.input, "候选");
    const down = new KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
      isComposing: true,
    });
    const up = new KeyboardEvent("keyup", {
      key,
      bubbles: true,
      cancelable: true,
      isComposing: true,
    });
    fireEvent(ui.input, down);
    fireEvent(ui.input, up);
    expect(ui.keyDown).not.toHaveBeenCalled();
    expect(ui.keyUp).not.toHaveBeenCalled();
    expect(down.defaultPrevented).toBe(false);
    expect(up.defaultPrevented).toBe(false);
    expect(ui.onEditingKey).not.toHaveBeenCalled();
    expect(ui.onText).not.toHaveBeenCalled();
  },
);

it("keeps Safari 229 candidate Enter local after compositionend but accepts the next normal Enter", () => {
  const ui = setup();
  compose(ui.input, "好");
  fireEvent.compositionEnd(ui.input, { data: "好" });
  fireEvent.keyDown(ui.input, {
    key: "Enter",
    code: "Enter",
    keyCode: 229,
    isComposing: false,
  });
  fireEvent.keyUp(ui.input, {
    key: "Enter",
    code: "Enter",
    isComposing: false,
  });
  expect(ui.keyDown).not.toHaveBeenCalled();
  expect(ui.keyUp).not.toHaveBeenCalled();
  flush();
  expect(ui.onText.mock.calls).toEqual([["好", "page-a:field-a"]]);
  fireEvent.keyDown(ui.input, { key: "Enter", code: "Enter" });
  fireEvent.keyUp(ui.input, { key: "Enter", code: "Enter" });
  expect(ui.keyDown).toHaveBeenCalledOnce();
  expect(ui.keyUp).toHaveBeenCalledOnce();
});

it("flushes an ended transaction before the next ordinary physical Enter", () => {
  const ui = setup();
  const order: string[] = [];
  ui.onText.mockImplementation(() => order.push("text"));
  ui.keyDown.mockImplementation(() => order.push("key"));
  compose(ui.input, "完成");
  fireEvent.compositionEnd(ui.input, { data: "完成" });
  fireEvent.keyDown(ui.input, { key: "Enter", code: "Enter" });
  expect(order).toEqual(["text", "key"]);
  flush();
  expect(ui.onText).toHaveBeenCalledOnce();
});

it("does not let a missing candidate keyup swallow a new normal same-code keyup", () => {
  const ui = setup();
  compose(ui.input, "好");
  fireEvent.keyDown(ui.input, { key: "Enter", code: "Enter", keyCode: 229 });
  fireEvent.compositionEnd(ui.input, { data: "好" });
  flush();
  fireEvent.keyDown(ui.input, { key: "Enter", code: "Enter" });
  fireEvent.keyUp(ui.input, { key: "Enter", code: "Enter" });
  expect(ui.keyDown).toHaveBeenCalledOnce();
  expect(ui.keyUp).toHaveBeenCalledOnce();
});

it("leaves an already-forwarded modifier keyup available for parent release during composition", () => {
  const ui = setup();
  fireEvent.keyDown(ui.input, {
    key: "Control",
    code: "ControlLeft",
    ctrlKey: true,
  });
  compose(ui.input, "候选");
  fireEvent.keyUp(ui.input, {
    key: "Control",
    code: "ControlLeft",
    isComposing: true,
  });
  expect(ui.keyDown).toHaveBeenCalledOnce();
  expect(ui.keyUp).toHaveBeenCalledOnce();
  expect(ui.onText).not.toHaveBeenCalled();
});

it.each([
  ["deleteContentBackward", "Backspace"],
  ["deleteContentForward", "Delete"],
  ["insertLineBreak", "Enter"],
  ["insertParagraph", "Enter"],
] as const)(
  "forwards native beforeinput %s as one editing key",
  (inputType, key) => {
    const ui = setup();
    const event = beforeInput(ui.input, inputType);
    expect(event.defaultPrevented).toBe(true);
    expect(ui.onEditingKey.mock.calls).toEqual([[key, "page-a:field-a"]]);
    updateValue(ui.input, "", inputType);
    expect(ui.onEditingKey).toHaveBeenCalledOnce();
    expect(ui.onText).not.toHaveBeenCalled();
  },
);

it("does not interpret composing native editing events as remote deletion or submission", () => {
  const ui = setup();
  compose(ui.input, "候选");
  for (const type of [
    "deleteContentBackward",
    "deleteContentForward",
    "insertLineBreak",
  ]) {
    expect(beforeInput(ui.input, type, null, true).defaultPrevented).toBe(
      false,
    );
  }
  expect(ui.onEditingKey).not.toHaveBeenCalled();
  expect(ui.onText).not.toHaveBeenCalled();
});

it("flushes ended text before a mobile paragraph event without physical keydown", () => {
  const ui = setup();
  const order: string[] = [];
  ui.onText.mockImplementation(() => order.push("text"));
  ui.onEditingKey.mockImplementation(() => order.push("editing key"));
  compose(ui.input, "已确认");
  fireEvent.compositionEnd(ui.input, { data: "已确认" });
  const event = beforeInput(ui.input, "insertParagraph");
  expect(event.defaultPrevented).toBe(true);
  expect(order).toEqual(["text", "editing key"]);
  expect(ui.onEditingKey.mock.calls).toEqual([["Enter", "page-a:field-a"]]);
  expect(ui.keyDown).not.toHaveBeenCalled();
  flush();
  expect(ui.onText.mock.calls).toEqual([["已确认", "page-a:field-a"]]);
});

it("commits an already-ended same-owner transaction on normal blur before its finalizer", () => {
  const ui = setup();
  compose(ui.input, "已结束");
  fireEvent.compositionEnd(ui.input, { data: "已结束" });
  act(() => ui.input.blur());
  flush();
  expect(ui.onText.mock.calls).toEqual([["已结束", "page-a:field-a"]]);
  expect(ui.input.value).toBe("");
  updateValue(ui.input, "已结束");
  expect(ui.onText).toHaveBeenCalledOnce();
});

it("discards unfinished composition on blur, including late end and input", () => {
  const ui = setup();
  compose(ui.input, "未确认");
  act(() => ui.input.blur());
  fireEvent.compositionEnd(ui.input, { data: "未确认" });
  updateValue(ui.input, "未确认");
  flush();
  expect(ui.onText).not.toHaveBeenCalled();
});

it.each(["inactive", "replacement", "noneditable", "unmount"] as const)(
  "discards ended pending composition after %s before delayed events run",
  (change) => {
    const ui = setup();
    compose(ui.input, "旧输入");
    fireEvent.compositionEnd(ui.input, { data: "旧输入" });
    if (change === "inactive") ui.update({ active: false });
    if (change === "replacement")
      ui.update({ target: inputTarget("page-b:field-b") });
    if (change === "noneditable") ui.update({ target: null });
    if (change === "unmount") ui.unmount();
    updateValue(ui.input, "旧输入");
    fireEvent.compositionEnd(ui.input, { data: "旧输入" });
    flush();
    expect(ui.onText).not.toHaveBeenCalled();
    expect(ui.onEditingKey).not.toHaveBeenCalled();
  },
);

it("replaces the owner DOM input so old native beforeinput cannot submit to the new field", () => {
  const ui = setup();
  const old = ui.input;
  compose(old, "旧输入");
  fireEvent.compositionEnd(old, { data: "旧输入" });
  ui.update({ target: inputTarget("page-b:field-b") });
  const fresh = ui.currentInput;
  expect(fresh.value).toBe("");
  beforeInput(old, "insertText", "旧输入");
  updateValue(old, "旧输入");
  fireEvent.compositionEnd(old, { data: "旧输入" });
  flush();
  expect(ui.onText).not.toHaveBeenCalled();
  expect(old.isConnected).toBe(false);
  expect(fresh).not.toBe(old);
  expect(fresh.value).toBe("");
  act(() => fresh.focus());
  beforeInput(fresh, "insertText", "新输入");
  updateValue(fresh, "新输入");
  expect(ui.onText.mock.calls).toEqual([["新输入", "page-b:field-b"]]);
});

it("preserves composing DOM text when only the same owner's anchor changes", () => {
  const ui = setup();
  compose(ui.input, "候选");
  const target = inputTarget();
  ui.update({
    target: { ...target, anchorRect: { ...target.anchorRect, x: 200, y: 180 } },
  });
  expect(ui.currentInput).toBe(ui.input);
  expect(document.activeElement).toBe(ui.input);
  expect(ui.input.value).toBe("候选");
  fireEvent.compositionEnd(ui.input, { data: "候选" });
  flush();
  expect(ui.onText.mock.calls).toEqual([["候选", "page-a:field-a"]]);
});

it("cancels unfinished composition before passing paste to the parent without an input echo", () => {
  const ui = setup();
  compose(ui.input, "候选");
  fireEvent.paste(ui.input, {
    clipboardData: { getData: () => "pasted text" },
  });
  expect(ui.paste).toHaveBeenCalledOnce();
  fireEvent.compositionEnd(ui.input, { data: "候选" });
  updateValue(ui.input, "pasted text", "insertFromPaste");
  flush();
  expect(ui.onText).not.toHaveBeenCalled();
});

it("preserves an already-ended transaction before paste starts a separate native input", () => {
  const ui = setup();
  const order: string[] = [];
  ui.onText.mockImplementation(() => order.push("text"));
  ui.paste.mockImplementation(() => order.push("paste"));
  compose(ui.input, "已确认");
  fireEvent.compositionEnd(ui.input, { data: "已确认" });
  fireEvent.paste(ui.input, {
    clipboardData: { getData: () => "pasted text" },
  });
  flush();
  expect(ui.onText.mock.calls).toEqual([["已确认", "page-a:field-a"]]);
  expect(order).toEqual(["text", "paste"]);
});

it("leaves native ASCII down and up to the parent instead of creating a second text route", () => {
  const ui = setup();
  ui.keyDown.mockImplementation((event) => event.preventDefault());
  const event = new KeyboardEvent("keydown", {
    key: "a",
    code: "KeyA",
    bubbles: true,
    cancelable: true,
  });
  fireEvent(ui.input, event);
  fireEvent.keyUp(ui.input, { key: "a", code: "KeyA" });
  expect(ui.keyDown).toHaveBeenCalledOnce();
  expect(ui.keyUp).toHaveBeenCalledOnce();
  expect(event.defaultPrevented).toBe(true);
  expect(ui.input.value).toBe("");
  expect(ui.onText).not.toHaveBeenCalled();
  expect(ui.onEditingKey).not.toHaveBeenCalled();
});

it("sends a finished transaction before a new composition replaces its pending finalizer", () => {
  const ui = setup();
  compose(ui.input, "第一段");
  fireEvent.compositionEnd(ui.input, { data: "第一段" });
  fireEvent.compositionStart(ui.input, { data: "" });
  expect(ui.onText.mock.calls).toEqual([["第一段", "page-a:field-a"]]);
  updateValue(ui.input, "第一段第二段", "insertCompositionText", true);
  act(() => ui.input.blur());
  flush();
  expect(ui.onText).toHaveBeenCalledOnce();
});
