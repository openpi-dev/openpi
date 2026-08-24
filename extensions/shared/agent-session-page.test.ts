import assert from "node:assert/strict";
import test from "node:test";
import type {
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
import {
  AgentSessionPage,
  type AgentSessionPageState,
} from "./agent-session-page.ts";

initTheme("dark", false);

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
} as Theme;

const keybindings = {
  matches(data: string, binding: string) {
    return data === binding.replace("tui.editor.cursor", "").toLowerCase();
  },
  getKeys(binding: string) {
    return [binding.split(".").at(-1)?.toLowerCase() ?? binding];
  },
} as unknown as KeybindingsManager;

function tui(rows: number) {
  return { terminal: { rows }, requestRender() {} } as unknown as TUI;
}

function state(): AgentSessionPageState {
  return {
    id: "child-1",
    title: "child session",
    status: "running",
    metadata: ["model", "12%/100k"],
    document: {
      items: [
        { kind: "user", text: "Inspect the page" },
        { kind: "assistant", parts: [{ type: "text", text: "## Result" }] },
      ],
    },
  };
}

test("Direct and Workflow children use one read-only full-terminal page", () => {
  const direct = new AgentSessionPage(tui(18), theme, keybindings, {
    getState: state,
    close() {},
  });
  const workflow = new AgentSessionPage(tui(18), theme, keybindings, {
    getState: state,
    close() {},
  });

  const directLines = direct.render(60);
  const workflowLines = workflow.render(60);
  for (const lines of [directLines, workflowLines]) {
    assert.equal(lines.length, 18);
    assert.ok(lines.every((line) => visibleWidth(line) <= 60));
    assert.match(lines.join("\n"), /Inspect the page/);
    assert.match(lines.join("\n"), /Result/);
    assert.doesNotMatch(lines.join("\n"), /╭|╮|Transcript/);
  }
});

test("a read-only Workflow child returns left without stealing a parent session", () => {
  let closed = 0;
  const page = new AgentSessionPage(tui(18), theme, keybindings, {
    getState: state,
    close: () => {
      closed += 1;
    },
  });

  page.handleInput("left");
  assert.equal(closed, 1);
});
