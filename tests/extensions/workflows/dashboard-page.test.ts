import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  type ExtensionContext,
  type ExtensionUIContext,
  InteractiveMode,
  initTheme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  compositeTuiLine,
  TuiMainScreen,
  TuiAltScreen,
} from "@earendil-works/pi-tui";
import { dashboardPageRows } from "../../../extensions/workflows/dashboard-page.ts";

const agentDir = mkdtempSync(join(tmpdir(), "openpi-dashboard-page-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const { showWorkflowDashboard, WorkflowDashboard } = await import(
  "../../../extensions/workflows/dashboard.ts"
);
test.after(() => rmSync(agentDir, { recursive: true, force: true }));

const images = [
  "\x1b_Ga=T,f=100,i=42,r=3;AAAA\x1b\\",
  "\x1b]1337;File=inline=1;width=10;height=3:AAAA\x07",
];

for (const mode of ["regular", "fullscreen"] as const) {
  for (const image of images) {
    test(`native ${mode} dashboard preserves navigation and restores the editor`, async () => {
      initTheme("dark", false);
      // Pin the cause in the real Pi public compositor, rather than a mock that
      // assumes text erases terminal graphics.
      assert.equal(compositeTuiLine(image, "Dashboard", 0, 80, 80), image);
      const writes: string[] = [];
      const dimensions = { columns: 80, rows: 18 };
      const terminal = {
        get columns() {
          return dimensions.columns;
        },
        get rows() {
          return dimensions.rows;
        },
        kittyProtocolActive: false,
        start() {},
        stop() {},
        async drainInput() {},
        write: (data: string) => writes.push(data),
        moveBy() {},
        hideCursor() {},
        showCursor() {},
        clearLine() {},
        clearFromCursor() {},
        clearScreen() {},
        setTitle() {},
        setProgress() {},
        setProgramStatus() {},
      };
      const tui =
        mode === "regular"
          ? new TuiMainScreen(terminal)
          : new TuiAltScreen(terminal);
      const frame = () => {
        if (tui instanceof TuiMainScreen) {
          const state = tui.captureRenderState();
          return state.previousLines.slice(state.previousViewportTop);
        }
        const screen: unknown = Reflect.get(tui, "previousScreen");
        assert.ok(Array.isArray(screen));
        return screen as string[];
      };
      let overlayPage: unknown;
      const nativeOverlay = tui.showOverlay.bind(tui);
      tui.showOverlay = (page, options) => {
        overlayPage = page;
        return nativeOverlay(page, options);
      };
      const chat = {
        render: () => [image, "", "", image, "", ""],
        invalidate() {},
      };
      let draft = "keep my unsent input";
      const editor = {
        render: () => [draft],
        invalidate() {},
        getText: () => draft,
        setText: (text: string) => {
          draft = text;
        },
      };
      const editorContainer = new Container();
      editorContainer.addChild(editor);
      let footerRows = 2;
      const footer = {
        render: () => Array(footerRows).fill("host footer"),
        invalidate() {},
      };
      tui.addChild(chat);
      tui.addChild(editorContainer);
      tui.addChild(footer);
      if (tui instanceof TuiAltScreen) {
        // Test the locked SDK host layout; production code uses only public seams.
        const { createChatViewport } = await import(
          new URL(
            "./modes/interactive/chat-viewport.js",
            import.meta.resolve("@earendil-works/pi-coding-agent"),
          ).href
        );
        const viewport = createChatViewport({
          document: chat,
          pendingMessages: new Container(),
          status: new Container(),
          widgetsAbove: new Container(),
          editor: editorContainer,
          widgetsBelow: new Container(),
          footer,
        });
        tui.setLayoutRoot(viewport.root);
      }
      tui.start();
      try {
        tui.renderNow();
        const before = frame();
        assert.ok(before.some((line) => line.includes(image)));
        const host = {
          ui: tui,
          editor,
          editorContainer,
          keybindings: {
            matches: (data: string, action: string) =>
              data === "\x1b" && action === "tui.select.cancel",
            getKeys: () => [],
          },
          disposeActiveSelector() {},
        };
        // Execute the installed SDK's actual custom-editor mount/restore path.
        const nativeCustom = Reflect.get(
          InteractiveMode.prototype,
          "showExtensionCustom",
        );
        assert.equal(typeof nativeCustom, "function");
        const custom: ExtensionUIContext["custom"] = (factory, options) =>
          nativeCustom.call(host, factory, options);
        const ctx = {
          ui: { custom, getToolsExpanded: () => false },
          sessionManager: {
            getSessionId: () => "fixture",
            getEntries: () => [],
          },
        } as unknown as ExtensionContext;
        for (const [columns, rows, trailing] of [
          [80, 18, 2],
          [44, 14, 3],
          [100, 24, 1],
          [80, 4, 2],
          [80, 5, 2],
        ]) {
          dimensions.columns = columns;
          dimensions.rows = rows;
          footerRows = trailing;
          const pending = showWorkflowDashboard(ctx, () => new Map());
          await Promise.resolve();
          const mounted = editorContainer.children[0];
          const page =
            mode === "regular" && mounted instanceof Container
              ? mounted.children[0]
              : overlayPage;
          assert.ok(page instanceof WorkflowDashboard);
          assert.equal(tui.hasOverlay(), mode === "fullscreen");
          if (mode === "regular")
            assert.equal(
              dashboardPageRows(tui, page, columns),
              rows - trailing,
            );
          for (let refresh = 0; refresh < 2; refresh++) {
            tui.renderNow();
            const visible = frame();
            if (mode === "regular")
              assert.ok(visible.some((line) => line.includes("Workflows")));
            assert.ok(visible.some((line) => line.includes("close")));
            // Fullscreen keeps its existing overlay path; the Pi image compositor
            // limitation remains tracked, rather than a false no-image assertion.
            if (mode === "regular")
              assert.equal(
                visible.some((line) => line.includes(image)),
                false,
              );
          }
          page.handleInput("\x1b");
          await pending;
          tui.renderNow();
          assert.deepEqual(editorContainer.children, [editor]);
          assert.equal(draft, "keep my unsent input");
          assert.equal(tui.hasOverlay(), false);
          assert.equal(tui.getClearOnShrink(), false);
          if (rows >= 10)
            assert.ok(frame().some((line) => line.includes(image)));
          if (tui instanceof TuiMainScreen)
            assert.ok(
              tui
                .captureRenderState()
                .previousLines.some((line) => line.includes(image)),
            );
        }
        assert.ok(writes.length > 0);
      } finally {
        tui.stop();
      }
    });
  }
}
