// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { copyText } from "../../web/ui/src/lib/clipboard.ts";

const originalExec = Object.getOwnPropertyDescriptor(document, "execCommand");
afterEach(() => {
  if (originalExec)
    Object.defineProperty(document, "execCommand", originalExec);
  else Reflect.deleteProperty(document, "execCommand");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

it("copies original Markdown with the native API without moving focus", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  const input = document.createElement("input");
  document.body.append(input);
  input.focus();
  expect(await copyText("**original**")).toBe(true);
  expect(writeText).toHaveBeenCalledWith("**original**");
  expect(document.activeElement).toBe(input);
  expect(document.querySelector("textarea")).toBeNull();
});

it.each(["missing", "rejected"])(
  "falls back after %s API and restores composer selection",
  async (mode) => {
    vi.stubGlobal(
      "navigator",
      mode === "missing"
        ? {}
        : {
            clipboard: {
              writeText: vi.fn().mockRejectedValue(new Error("denied")),
            },
          },
    );
    const input = document.createElement("input");
    input.value = "draft message";
    document.body.append(input);
    input.focus();
    input.setSelectionRange(1, 5, "backward");
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: vi.fn(() => {
        expect(document.activeElement).toBeInstanceOf(HTMLTextAreaElement);
        expect((document.activeElement as HTMLTextAreaElement).value).toBe(
          "**original**",
        );
        return true;
      }),
    });
    expect(await copyText("**original**")).toBe(true);
    expect(document.activeElement).toBe(input);
    expect([
      input.selectionStart,
      input.selectionEnd,
      input.selectionDirection,
    ]).toEqual([1, 5, "backward"]);
    expect(document.querySelector("textarea")).toBeNull();
  },
);

it.each([false, "throw"])(
  "reports fallback failure %s and removes temporary content",
  async (outcome) => {
    vi.stubGlobal("navigator", {});
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: () => {
        if (outcome === "throw") throw new Error("blocked");
        return false;
      },
    });
    expect(await copyText("private message")).toBe(false);
    expect(document.body.textContent).toBe("");
    expect(document.querySelector("textarea")).toBeNull();
  },
);

it("restores the current document selection after native rejection", async () => {
  let rejectCopy: (reason: Error) => void = () => undefined;
  vi.stubGlobal("navigator", {
    clipboard: {
      writeText: () =>
        new Promise<void>((_, reject) => {
          rejectCopy = reject;
        }),
    },
  });
  const pending = copyText("copy this");
  const paragraph = document.createElement("p");
  paragraph.textContent = "selected text";
  document.body.append(paragraph);
  const range = document.createRange();
  range.selectNodeContents(paragraph);
  window.getSelection()?.removeAllRanges();
  window.getSelection()?.addRange(range);
  Object.defineProperty(document, "execCommand", {
    configurable: true,
    value: () => true,
  });
  rejectCopy(new Error("denied"));
  expect(await pending).toBe(true);
  expect(window.getSelection()?.toString()).toBe("selected text");
});
