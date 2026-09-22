import { describe, expect, it } from "vitest";
import {
  activateWorkbarTool,
  closeWorkbarTool,
  initialWorkbarTabs,
  openWorkbarTool,
} from "../../web/ui/src/features/workbar/workbar-tabs.ts";

describe("workbar tabs", () => {
  it("keeps opened tools mounted while activation changes", () => {
    const terminal = initialWorkbarTabs("terminal");
    const browser = openWorkbarTool(terminal, "browser");
    const returned = activateWorkbarTool(browser, "terminal");

    expect(returned.tabs).toEqual(["terminal", "browser"]);
    expect(returned.active).toBe("terminal");
    expect(returned.launcherOpen).toBe(false);
  });

  it("returns to the most recently active remaining tab", () => {
    let state = initialWorkbarTabs("terminal");
    state = openWorkbarTool(state, "browser");
    state = openWorkbarTool(state, "files");
    state = activateWorkbarTool(state, "terminal");

    expect(closeWorkbarTool(state, "terminal").active).toBe("files");
  });

  it("shows the launcher only after the final tab closes", () => {
    const closed = closeWorkbarTool(
      initialWorkbarTabs("side-conversation"),
      "side-conversation",
    );

    expect(closed.tabs).toEqual([]);
    expect(closed.active).toBeNull();
    expect(closed.launcherOpen).toBe(true);
  });

  it("keeps the launcher open while closing its previously active tab", () => {
    let state = initialWorkbarTabs("terminal");
    state = openWorkbarTool(state, "browser");
    state = openWorkbarTool(state, "launcher");

    const closed = closeWorkbarTool(state, "browser");

    expect(closed.active).toBe("terminal");
    expect(closed.launcherOpen).toBe(true);
  });
});
