import assert from "node:assert/strict";
import test from "node:test";
import {
  applyWindowsTerminalCompatibility,
  shouldClearShrunkRows,
} from "../../../extensions/windows-terminal-compat/index.ts";

test("enables shrink cleanup for the Windows regular renderer", () => {
  assert.equal(shouldClearShrunkRows("win32", "regular"), true);

  let enabled: boolean | undefined;
  applyWindowsTerminalCompatibility(
    {
      mode: "regular",
      getClearOnShrink() {
        return false;
      },
      setClearOnShrink(value) {
        enabled = value;
      },
    },
    "win32",
  );

  assert.equal(enabled, true);
});

test("does not change non-Windows or fullscreen rendering", () => {
  assert.equal(shouldClearShrunkRows("linux", "regular"), false);
  assert.equal(shouldClearShrunkRows("win32", "fullscreen"), false);

  let calls = 0;
  const tui = {
    mode: "fullscreen" as const,
    getClearOnShrink() {
      return false;
    },
    setClearOnShrink() {
      calls += 1;
    },
  };

  applyWindowsTerminalCompatibility(tui, "win32");
  applyWindowsTerminalCompatibility({ ...tui, mode: "regular" }, "linux");

  assert.equal(calls, 0);
});

test("supports an explicit environment opt-out", () => {
  assert.equal(shouldClearShrunkRows("win32", "regular", false), false);

  let calls = 0;
  applyWindowsTerminalCompatibility(
    {
      mode: "regular",
      getClearOnShrink() {
        return false;
      },
      setClearOnShrink() {
        calls += 1;
      },
    },
    "win32",
    false,
  );

  assert.equal(calls, 0);
});

test("preserves an explicit native false renderer setting", () => {
  let calls = 0;
  applyWindowsTerminalCompatibility(
    {
      mode: "regular",
      getClearOnShrink() {
        return false;
      },
      setClearOnShrink() {
        calls += 1;
      },
    },
    "win32",
    false,
  );
  assert.equal(calls, 0);
});

test("reapplies compatibility after renderer replacement", () => {
  let listener: ((data: string) => unknown) | undefined;
  const remove = (value: (data: string) => unknown) => {
    listener = value;
    return () => {
      listener = undefined;
    };
  };
  let oldClearOnShrink = false;
  const oldRenderer = {
    mode: "fullscreen" as const,
    getClearOnShrink: () => oldClearOnShrink,
    setClearOnShrink: (value: boolean) => {
      oldClearOnShrink = value;
    },
  };
  let newClearOnShrink = false;
  const newRenderer = {
    mode: "regular" as const,
    getClearOnShrink: () => newClearOnShrink,
    setClearOnShrink: (value: boolean) => {
      newClearOnShrink = value;
    },
  };
  let current: {
    mode: "regular" | "fullscreen";
    getClearOnShrink: () => boolean;
    setClearOnShrink: (value: boolean) => void;
  } = oldRenderer;
  const unsubscribe = remove(() => {
    applyWindowsTerminalCompatibility(current, "win32");
  });
  listener?.("input");
  assert.equal(oldClearOnShrink, false);
  current = newRenderer;
  listener?.("input");
  assert.equal(newClearOnShrink, true);
  unsubscribe();
  assert.equal(listener, undefined);
});
