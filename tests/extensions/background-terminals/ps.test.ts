import assert from "node:assert/strict";
import test from "node:test";
import type {
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import type { TerminalSnapshot } from "../../../extensions/background-terminals/src/domain.ts";
import type { TerminalReadModel } from "../../../extensions/background-terminals/src/manager.ts";
import { OutputBuffer } from "../../../extensions/background-terminals/src/output.ts";
import {
  buildOutputLines,
  createOutputLineCache,
  type OutputLayoutSource,
  sanitizeText,
} from "../../../extensions/background-terminals/src/ui/output-view.ts";
import {
  type DashboardSelection,
  OUTPUT_REFRESH_MS,
  reconcileDashboardSelection,
  TerminalDashboard,
  TerminalDetailView,
} from "../../../extensions/background-terminals/src/ui/ps.ts";

test("dashboard selection follows its terminal id and falls back by row", () => {
  const selection: DashboardSelection = { id: "bt-7", index: 6 };

  reconcileDashboardSelection(selection, [
    { id: "bt-new" },
    ...Array.from({ length: 8 }, (_, index) => ({ id: `bt-${index + 1}` })),
  ]);
  assert.deepEqual(selection, { id: "bt-7", index: 7 });

  reconcileDashboardSelection(selection, [
    ...Array.from({ length: 6 }, (_, index) => ({ id: `bt-${index + 1}` })),
    { id: "bt-8" },
    { id: "bt-9" },
  ]);
  assert.deepEqual(selection, { id: "bt-9", index: 7 });

  reconcileDashboardSelection(selection, [{ id: "bt-1" }, { id: "bt-2" }]);
  assert.deepEqual(selection, { id: "bt-2", index: 1 });

  reconcileDashboardSelection(selection, []);
  assert.deepEqual(selection, { id: undefined, index: 0 });
});

test("sanitizeText strips ANSI, tabs, and control characters", () => {
  assert.equal(sanitizeText("\u001b[31mred\u001b[0m"), "red");
  assert.equal(sanitizeText("\u001b[12345Cshifted"), "shifted");
  assert.equal(sanitizeText("\u001b]0;window title\u0007output"), "output");
  assert.equal(
    sanitizeText("\u001b]8;;https://example.com\u001b\\link\u001b]8;;\u001b\\"),
    "link",
  );
  assert.equal(sanitizeText("\u001b]0;title\u009coutput"), "output");
  assert.equal(sanitizeText("\u009d0;title\u0007output"), "output");
  assert.equal(sanitizeText("a\u0085b"), "ab");
  assert.equal(sanitizeText("a\tb"), "a  b");
  assert.equal(sanitizeText("a\u0007b\u0000c"), "abc");
});

test("output line cache reuses a version/width key and invalidates either dimension", () => {
  const cache = createOutputLineCache();
  const first = cache.get("first", 1, 80);
  const sameKey = cache.get("different text is intentionally ignored", 1, 80);
  assert.equal(sameKey, first);
  assert.deepEqual(sameKey, ["first"]);

  const newVersion = cache.get("second", 2, 80);
  assert.notEqual(newVersion, first);
  assert.deepEqual(newVersion, ["second"]);

  const newWidth = cache.get("x".repeat(25), 2, 10);
  assert.notEqual(newWidth, newVersion);
  assert.ok(newWidth.length > 1);
});

test("buildOutputLines wraps long lines and keeps only the final CR segment", () => {
  const lines = buildOutputLines("progress 1\rprogress 2\rdone\nnext", 80);
  assert.deepEqual(lines, ["done", "next"]);
  assert.deepEqual(buildOutputLines("progress 1\rprogress 2\r", 80), [
    "progress 2",
  ]);

  const wrapped = buildOutputLines("x".repeat(25), 10);
  assert.ok(wrapped.length > 1);
  assert.equal(wrapped.join(""), "x".repeat(25));
});

test("buildOutputLines drops one trailing empty line from a trailing newline", () => {
  assert.deepEqual(buildOutputLines("a\nb\n", 80), ["a", "b"]);
  assert.deepEqual(buildOutputLines("a\n\n", 80), ["a", ""]);
});

function linesOf(cache: ReturnType<typeof createOutputLineCache>) {
  return cache.slice(0, cache.length);
}

function trackingSource(
  buffer: OutputBuffer,
  reads: { text: number; slice: number },
) {
  const source: OutputLayoutSource = {
    get version() {
      return buffer.totalBytes;
    },
    get truncatedChars() {
      return buffer.truncatedChars;
    },
    get retainedChars() {
      return buffer.retainedChars;
    },
    slice(from, to) {
      const value = buffer.sliceRetained(from, to);
      reads.slice += value.length;
      return value;
    },
    text() {
      const value = buffer.view().text;
      reads.text += value.length;
      return value;
    },
  };
  return source;
}

test("incremental layout keeps CR progress, split ANSI, and trailing newlines", () => {
  const cache = createOutputLineCache();
  let text = "";
  const sync = () => {
    cache.sync(
      {
        version: Buffer.byteLength(text),
        truncatedChars: 0,
        retainedChars: text.length,
        slice: (from, to) => text.slice(from, to ?? text.length),
        text: () => text,
      },
      80,
    );
    return linesOf(cache);
  };

  text += "progress 1\r";
  assert.deepEqual(sync(), ["progress 1"]);
  text += "progress 2\r";
  assert.deepEqual(sync(), ["progress 2"]);
  text += "done\nnext";
  assert.deepEqual(sync(), ["done", "next"]);
  text += "\n";
  assert.deepEqual(sync(), ["done", "next"]);
  text += "\n";
  assert.deepEqual(sync(), ["done", "next", ""]);

  text += "\u001b[31m";
  assert.deepEqual(sync(), ["done", "next", ""]);
  text += "red\u001b[0m";
  // The blank line from the extra newline stays; the escape and the word are one line.
  assert.deepEqual(sync(), ["done", "next", "", "red"]);
  assert.deepEqual(linesOf(cache), buildOutputLines(text, 80));
});

test("incremental layout follows head eviction without rereading retained history", () => {
  const buffer = new OutputBuffer(14);
  const cache = createOutputLineCache();
  const reads = { text: 0, slice: 0 };
  const source = trackingSource(buffer, reads);

  buffer.push("aaaa\nbb");
  cache.sync(source, 80);
  assert.deepEqual(linesOf(cache), ["aaaa", "bb"]);
  assert.equal(reads.text, buffer.retainedChars);
  assert.equal(reads.slice, 0);

  reads.text = 0;
  reads.slice = 0;
  buffer.push("bb\ncccc\n");
  cache.sync(source, 80);
  // The first chunk is evicted whole, so the retained line starts at "bb".
  assert.deepEqual(linesOf(cache), ["bb", "cccc"]);
  assert.deepEqual(linesOf(cache), buildOutputLines(buffer.view().text, 80));
  // The old chunk is gone, so this frame reads only the surviving new chunk.
  assert.equal(reads.text, 0);
  assert.equal(reads.slice, "bb\ncccc\n".length);

  reads.text = 0;
  reads.slice = 0;
  cache.sync(source, 80);
  assert.equal(reads.text, 0);
  assert.equal(reads.slice, 0);
  assert.deepEqual(linesOf(cache), ["bb", "cccc"]);

  reads.text = 0;
  cache.sync(source, 10);
  assert.equal(reads.text, buffer.retainedChars);
  assert.deepEqual(linesOf(cache), buildOutputLines(buffer.view().text, 10));
});

test("sustained capped output stays aligned with a full layout and reads only the delta", () => {
  const cap = 64 * 1024;
  const row = "log output plain ascii 1234567890\n";
  const buffer = new OutputBuffer(cap);
  while (buffer.totalBytes < cap + row.length * 4) buffer.push(row);

  const cache = createOutputLineCache();
  const reads = { text: 0, slice: 0 };
  const source = trackingSource(buffer, reads);
  cache.sync(source, 100);
  assert.deepEqual(linesOf(cache), buildOutputLines(buffer.view().text, 100));
  assert.equal(reads.text, buffer.retainedChars);

  reads.text = 0;
  reads.slice = 0;
  for (let index = 0; index < 40; index++) {
    buffer.push(index % 5 === 0 ? `progress ${index}\rstep\n` : row);
    cache.sync(source, 100);
    assert.deepEqual(linesOf(cache), buildOutputLines(buffer.view().text, 100));
  }
  assert.equal(reads.text, 0);
  assert.ok(
    reads.slice < buffer.retainedChars,
    `delta reads ${reads.slice} chars from ${buffer.retainedChars} retained`,
  );

  buffer.push(`\u001b[32m${"é".repeat(30)}\u001b[0m\n`);
  cache.sync(source, 100);
  assert.equal(reads.text, 0);
  assert.deepEqual(linesOf(cache), buildOutputLines(buffer.view().text, 100));
});

function themeStub() {
  return {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as unknown as Theme;
}

function keyStub() {
  return {
    matches: () => false,
    getKeys: () => ["esc"],
  } as unknown as KeybindingsManager;
}

function snapshot(id: string, status: TerminalSnapshot["status"] = "running") {
  const output = {
    text: "",
    modelSafeText: "",
    totalBytes: 0,
    truncatedBytes: 0,
    truncatedChars: 0,
    retainedChars: 0,
    slice: () => "",
  };
  return {
    id,
    command: "echo hi",
    title: id,
    cwd: "/tmp",
    pid: 7,
    status,
    createdAt: 0,
    errorText: undefined as string | undefined,
    stdout: output,
    stderr: output,
  };
}

test("dashboard output bursts share one repaint and lifecycle changes do not", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const terminals = [snapshot("bt-1")];
  let listener = () => {};
  let unsubscribed = false;
  let renders = 0;
  const view = {
    list: () => terminals,
    get: (id: string) => terminals.find((snap) => snap.id === id),
    size: () => terminals.length,
    subscribe: (next: () => void) => {
      listener = next;
      return () => {
        unsubscribed = true;
        listener = () => {};
      };
    },
    subscribeTo: () => () => {},
    subscribeToChunks: () => () => {},
    requestKill: () => {},
    retainResult: () => {},
    releaseResult: () => {},
    setOnSettled: () => {},
  } satisfies TerminalReadModel;
  const dashboard = new TerminalDashboard(
    {
      requestRender: () => {
        renders++;
      },
      terminal: { rows: 24 },
    } as unknown as TUI,
    themeStub(),
    keyStub(),
    view,
    { index: 0 },
    () => {},
  );

  try {
    for (let index = 0; index < 100; index++) {
      const current = terminals[0];
      if (!current) break;
      current.stdout = {
        ...current.stdout,
        totalBytes: index + 1,
        text: "x".repeat(index + 1),
      };
      listener();
    }
    assert.equal(renders, 0);
    t.mock.timers.tick(OUTPUT_REFRESH_MS - 1);
    assert.equal(renders, 0);
    t.mock.timers.tick(1);
    assert.equal(renders, 1);

    listener();
    const running = terminals[0];
    if (!running) throw new Error("missing terminal");
    running.status = "failed";
    running.errorText = "boom";
    listener();
    assert.equal(renders, 2);
    t.mock.timers.tick(OUTPUT_REFRESH_MS);
    assert.equal(renders, 2);

    terminals.push(snapshot("bt-2"));
    listener();
    assert.equal(renders, 3);

    dashboard.dispose();
    assert.equal(unsubscribed, true);
    listener();
    t.mock.timers.tick(OUTPUT_REFRESH_MS * 4);
    assert.equal(renders, 3);
  } finally {
    dashboard.dispose();
    t.mock.timers.reset();
  }
});

test("detail view keeps the tail, stream switch, truncation note, and one coalesced repaint", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const stdout = new OutputBuffer(64 * 1024);
  const stderr = new OutputBuffer(64 * 1024);
  stdout.spillPath = "/tmp/full.log";
  const snap = {
    id: "bt-1",
    command: "echo hi",
    title: "demo",
    cwd: "/tmp",
    pid: 7,
    status: "running" as const,
    createdAt: 0,
    get stdout() {
      return stdout.view();
    },
    get stderr() {
      return stderr.view();
    },
  };
  let listener = () => {};
  let renders = 0;
  const view = {
    list: () => [snap],
    get: () => snap,
    size: () => 1,
    subscribe: () => () => {},
    subscribeTo: (_id: string, next: () => void) => {
      listener = next;
      return () => {
        listener = () => {};
      };
    },
    subscribeToChunks: () => () => {},
    requestKill: () => {},
    retainResult: () => {},
    releaseResult: () => {},
    setOnSettled: () => {},
  } satisfies TerminalReadModel;
  const detail = new TerminalDetailView(
    {
      requestRender: () => {
        renders++;
      },
      terminal: { rows: 30 },
    } as unknown as TUI,
    themeStub(),
    keyStub(),
    "bt-1",
    view,
    () => {},
  );

  try {
    stdout.push("HEADLINE\n");
    for (let index = 0; index < 40; index++) stdout.push(`row ${index}\n`);
    stdout.push("TAILMARK\n");
    for (let index = 0; index < 20; index++) {
      stdout.push(".");
      listener();
    }
    assert.equal(renders, 0);
    t.mock.timers.tick(OUTPUT_REFRESH_MS - 1);
    assert.equal(renders, 0);
    t.mock.timers.tick(1);
    assert.equal(renders, 1);

    const tail = detail.render(80);
    assert.equal(
      tail.some((line) => line.includes("TAILMARK")),
      true,
    );
    assert.equal(
      tail.some((line) => line.includes("HEADLINE")),
      false,
    );

    detail.handleInput("g");
    const top = detail.render(80);
    assert.equal(
      top.some((line) => line.includes("HEADLINE")),
      true,
    );
    assert.equal(
      top.some((line) => line.includes("TAILMARK")),
      false,
    );

    detail.handleInput("G");
    stderr.push("ERRMARK\n");
    detail.handleInput("t");
    const errors = detail.render(80);
    assert.equal(
      errors.some((line) => line.includes("ERRMARK")),
      true,
    );
    assert.equal(
      errors.some((line) => line.includes("TAILMARK")),
      false,
    );

    detail.handleInput("t");
    stdout.push(`${"q".repeat(80_000)}\n`);
    const truncated = detail.render(80);
    assert.equal(
      truncated.some((line) => line.includes("/tmp/full.log")),
      true,
    );
    assert.equal(
      truncated.some((line) => line.includes("dropped from view")),
      true,
    );

    const beforeDispose = renders;
    stdout.push("late\n");
    listener();
    detail.dispose();
    t.mock.timers.tick(OUTPUT_REFRESH_MS * 4);
    assert.equal(renders, beforeDispose);
  } finally {
    detail.dispose();
    t.mock.timers.reset();
  }
});
