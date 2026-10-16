// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { createElement } from "react";
import { I18nextProvider } from "react-i18next";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import type {
  WebSessionSummary,
  WebSnapshot,
} from "../../web/protocol/types.ts";
import { SessionSidebar } from "../../web/ui/src/features/sessions/SessionSidebar.tsx";
import { i18n } from "../../web/ui/src/i18n.ts";
import {
  type ArchivedSessionPage,
  WebApiError,
  WebClient,
} from "../../web/ui/src/protocol/client.ts";
import { createWebStore } from "../../web/ui/src/store/web-store.ts";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
beforeEach(() => {
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  vi.spyOn(WebClient.prototype, "sessionOpenTargets").mockResolvedValue({
    targets: [],
  });
});
beforeAll(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.open = true;
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.open = false;
    },
  });
});
afterAll(() => {
  Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
  Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
});

function session(
  path: string,
  cwd: string,
  name: string,
  archived = false,
): WebSessionSummary {
  return {
    id: path,
    path,
    cwd,
    name,
    archived,
    source: "web-session",
    origin: "web",
    controller: "none",
    readOnly: false,
    modified: "2026-09-18T10:00:00Z",
    created: "2026-09-18T10:00:00Z",
    messageCount: 1,
    firstMessage: "hello",
    readRevision: `revision:${path}`,
  };
}

function snapshot(sessions: WebSessionSummary[]): WebSnapshot {
  return {
    protocolVersion: 1,
    generatedAt: "2026-09-18T10:00:00Z",
    cursor: 1,
    preferences: { theme: "system", projectsInRecents: false },
    workspaces: [
      { path: "/repos/long-example", name: "Shared", current: true },
      { path: "/other/shared", name: "Shared", current: false },
    ],
    sessions,
    models: [],
    runtime: { status: "idle", capabilities: {} },
    truncation: {
      bytes: 0,
      maxBytes: 4 * 1024 * 1024,
      sessionsOmitted: 0,
      workspacesOmitted: 0,
      modelsOmitted: 0,
      truncated: false,
    },
  };
}

function mount(
  data: WebSnapshot,
  overrides: Partial<Parameters<typeof SessionSidebar>[0]> = {},
) {
  if (!vi.isMockFunction(WebClient.prototype.listArchivedSessions))
    vi.spyOn(WebClient.prototype, "listArchivedSessions").mockImplementation(
      async ({ query = "" } = {}) =>
        archivePage(
          data.sessions.filter(
            (item) =>
              item.archived &&
              `${item.name} ${item.cwd} ${item.id}`
                .toLowerCase()
                .includes(query.toLowerCase()),
          ),
        ),
    );
  const actions = createWebStore().getState().actions;
  const props = {
    snapshot: data,
    selectedPath: null,
    selectedWorkspace: null,
    collapsed: new Set<string>(),
    query: "",
    searchOpen: false,
    mobileOpen: false,
    settingsDisabled: false,
    onOpenSettings: vi.fn(),
    actions,
    ...overrides,
  };
  const view = render(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(SessionSidebar, props),
    ),
  );
  return {
    actions,
    unmount: view.unmount,
    rerender(next: Partial<typeof props>) {
      Object.assign(props, next);
      view.rerender(
        createElement(
          I18nextProvider,
          { i18n },
          createElement(SessionSidebar, props),
        ),
      );
    },
  };
}

function archivePage(
  sessions: ArchivedSessionPage["sessions"],
  nextCursor?: string,
): ArchivedSessionPage {
  return {
    sessions,
    ...(nextCursor ? { nextCursor } : {}),
    truncation: {
      truncated: Boolean(nextCursor),
      matchesOmitted: nextCursor ? 1 : 0,
      recordsUnscanned: 0,
      maxPageSize: 50,
      maxScanned: 5_000,
    },
  };
}

function catalog(projectCount: number, firstProjectChats: number) {
  const workspaces = Array.from({ length: projectCount }, (_, index) => ({
    path: `/project-${index + 1}`,
    name: `Project ${index + 1}`,
    current: false,
  }));
  const data = snapshot(
    workspaces.flatMap((project, projectIndex) =>
      Array.from(
        { length: projectIndex === 0 ? firstProjectChats : 1 },
        (_, index) =>
          session(
            `${project.path}/${index}.jsonl`,
            project.path,
            `Chat ${projectIndex + 1}-${index + 1}`,
          ),
      ),
    ),
  );
  data.workspaces = workspaces;
  data.preferences = { theme: "system" };
  return data;
}

function dragPointer(element: Element, type: string, y = 0) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    clientY: { value: y },
    dataTransfer: {
      value: { setData: vi.fn(), effectAllowed: "move", dropEffect: "move" },
    },
  });
  fireEvent(element, event);
}

it("reorders projects when dropped over their child conversations using the full group midpoint", async () => {
  const { actions } = mount(catalog(3, 1));
  const order = vi.spyOn(actions, "setWorkspaceOrder").mockResolvedValue();
  const source = screen.getByRole("region", { name: "Project 1" });
  const destination = screen.getByRole("region", { name: "Project 2" });
  vi.spyOn(destination, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 100, 300, 300),
  );
  dragPointer(source.querySelector(".workspace-button")!, "dragstart");
  const child = within(destination).getByText("Chat 2-1");
  dragPointer(child, "dragover", 320);
  expect(destination.classList.contains("is-pin-drop-after")).toBe(true);
  dragPointer(child, "drop", 320);
  await waitFor(() =>
    expect(order).toHaveBeenCalledWith("/project-1", "/project-3"),
  );
  expect(destination.classList.contains("is-pin-drop-after")).toBe(false);
});

it("offers an empty pin drop area during a project drag and suppresses the trailing pointer click", async () => {
  const { actions } = mount(catalog(2, 1));
  const pin = vi.spyOn(actions, "setSidebarPin").mockResolvedValue();
  const toggle = vi
    .spyOn(actions, "toggleWorkspace")
    .mockImplementation(() => {});
  const source = screen.getByRole("region", { name: "Project 1" });
  expect(
    screen.queryByRole("region", { name: i18n.t("pinnedConversations") }),
  ).toBeNull();
  dragPointer(source.querySelector(".workspace-button")!, "dragstart");
  const pinned = await screen.findByRole("region", {
    name: i18n.t("pinnedConversations"),
  });
  expect(within(pinned).getByText(i18n.t("sidebarDropPin"))).toBeTruthy();
  dragPointer(pinned, "dragover");
  dragPointer(pinned, "drop");
  // Longer than the old 250ms suppression window. A trailing click still must
  // not toggle the workspace after a slow post-drop render.
  await new Promise((resolve) => setTimeout(resolve, 300));
  await waitFor(() =>
    expect(pin).toHaveBeenCalledWith(
      { kind: "workspace", path: "/project-1" },
      true,
      null,
    ),
  );
  const label = within(source).getByRole("button", { name: "Project 1" });
  fireEvent.click(label, { detail: 1 });
  expect(toggle).not.toHaveBeenCalled();
  fireEvent.click(label, { detail: 0 });
  expect(toggle).toHaveBeenCalledWith("/project-1");
  expect(toggle).toHaveBeenCalledTimes(1);
  fireEvent.pointerDown(label);
  fireEvent.click(label, { detail: 1 });
  expect(toggle).toHaveBeenCalledTimes(2);
});

it("cancels project dragging with Escape without reviving a delayed frame or persisting a later drop", async () => {
  const { actions } = mount(catalog(2, 1));
  let frame: FrameRequestCallback | undefined;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frame = callback;
    return 1;
  });
  const order = vi.spyOn(actions, "setWorkspaceOrder").mockResolvedValue();
  const source = screen.getByRole("region", { name: "Project 1" });
  const destination = screen.getByRole("region", { name: "Project 2" });
  dragPointer(source.querySelector(".workspace-button")!, "dragstart");
  dragPointer(destination, "dragover");
  fireEvent.keyDown(window, { key: "Escape" });
  expect(frame).toBeDefined();
  await act(async () => frame!(0));
  expect(destination.classList.contains("is-pin-drop-target")).toBe(false);
  expect(
    screen.queryByRole("region", { name: i18n.t("sidebarDropProjectLast") }),
  ).toBeNull();
  dragPointer(destination, "drop");
  expect(order).not.toHaveBeenCalled();
});

it("moves a pinned project to the ordinary project tail in one atomic order action", async () => {
  const data = catalog(2, 1);
  data.workspaces[0].pinOrder = 0;
  const { actions } = mount(data);
  const order = vi.spyOn(actions, "setWorkspaceOrder").mockResolvedValue();
  const pin = vi.spyOn(actions, "setSidebarPin").mockResolvedValue();
  const source = screen.getByRole("region", { name: "Project 1" });
  dragPointer(source.querySelector(".workspace-button")!, "dragstart");
  const tail = await screen.findByRole("region", {
    name: i18n.t("sidebarDropProjectLast"),
  });
  dragPointer(tail, "dragover");
  dragPointer(tail, "drop");
  await waitFor(() => expect(order).toHaveBeenCalledWith("/project-1", null));
  expect(pin).not.toHaveBeenCalled();
});

it("shows project conversations in Recent by default while excluding individually pinned and pinned-project duplicates", () => {
  const project = session("/normal/chat.jsonl", "/normal", "Project chat");
  const pinned = {
    ...session("/normal/pin.jsonl", "/normal", "Pinned chat"),
    pinOrder: 0,
  };
  const pinnedProject = session(
    "/pinned/chat.jsonl",
    "/pinned",
    "Pinned project chat",
  );
  const loose = {
    ...session("/loose/chat.jsonl", "/loose", "Loose chat"),
    ungrouped: true,
  };
  const data = snapshot([project, pinned, pinnedProject, loose]);
  data.preferences = { theme: "system" };
  data.workspaces = [
    { path: "/normal", name: "Normal project", current: false },
    { path: "/pinned", name: "Pinned project", current: false, pinOrder: 1 },
  ];
  const view = mount(data);
  const recent = screen.getByRole("region", { name: i18n.t("sidebarRecent") });
  expect(
    screen.getAllByRole("button", { name: `Project chat · ${project.path}` }),
  ).toHaveLength(2);
  expect(
    within(screen.getByRole("region", { name: "Normal project" })).getByText(
      "Project chat",
    ),
  ).toBeTruthy();
  expect(within(recent).getByText("Project chat")).toBeTruthy();
  expect(within(recent).getByText("Loose chat")).toBeTruthy();
  expect(within(recent).queryByText("Pinned chat")).toBeNull();
  expect(within(recent).queryByText("Pinned project chat")).toBeNull();
  expect(
    screen.getAllByRole("button", { name: `Pinned chat · ${pinned.path}` }),
  ).toHaveLength(1);
  expect(
    screen.getAllByRole("button", {
      name: `Pinned project chat · ${pinnedProject.path}`,
    }),
  ).toHaveLength(1);
  view.rerender({
    snapshot: {
      ...data,
      preferences: { ...data.preferences, projectsInRecents: false },
    },
  });
  expect(
    screen.getAllByRole("button", { name: `Project chat · ${project.path}` }),
  ).toHaveLength(1);
  expect(within(recent).queryByText("Project chat")).toBeNull();
  expect(within(recent).getByText("Loose chat")).toBeTruthy();
});

it("initially shows five projects, five chats per project and ten Recent chats, then reveals each list independently", () => {
  mount(catalog(7, 7));
  expect(screen.getAllByRole("region", { name: /^Project \d+$/ })).toHaveLength(
    5,
  );
  expect(screen.queryByRole("region", { name: "Project 6" })).toBeNull();
  const project = screen.getByRole("region", { name: "Project 1" });
  const recent = screen.getByRole("region", { name: i18n.t("sidebarRecent") });
  expect(
    within(project).getAllByRole("button", { name: /^Chat \d/ }),
  ).toHaveLength(5);
  expect(
    within(recent).getAllByRole("button", { name: /^Chat \d/ }),
  ).toHaveLength(10);
  fireEvent.click(
    within(project).getByRole("button", { name: i18n.t("sidebarShowMore") }),
  );
  expect(
    within(project).getAllByRole("button", { name: /^Chat \d/ }),
  ).toHaveLength(7);
  expect(
    within(recent).getAllByRole("button", { name: /^Chat \d/ }),
  ).toHaveLength(10);
  fireEvent.click(
    within(project).getByRole("button", { name: i18n.t("sidebarShowLess") }),
  );
  expect(
    within(project).getAllByRole("button", { name: /^Chat \d/ }),
  ).toHaveLength(5);
  const projectsMore = document.querySelector<HTMLButtonElement>(
    ".workspace-tree > .sidebar-show-more",
  );
  if (!projectsMore) throw new Error("Project disclosure is missing");
  fireEvent.click(projectsMore);
  expect(screen.getAllByRole("region", { name: /^Project \d+$/ })).toHaveLength(
    7,
  );
  fireEvent.click(
    within(recent).getByRole("button", { name: i18n.t("sidebarShowMore") }),
  );
  expect(
    within(recent).getAllByRole("button", { name: /^Chat \d/ }),
  ).toHaveLength(13);
  expect(
    within(recent).queryByRole("button", { name: i18n.t("sidebarShowMore") }),
  ).toBeNull();
});

it("shows a single overflow item without requiring Show more for projects, project chats or Recent", () => {
  mount(catalog(6, 6));
  expect(screen.getAllByRole("region", { name: /^Project \d+$/ })).toHaveLength(
    6,
  );
  expect(
    within(screen.getByRole("region", { name: "Project 1" })).getAllByRole(
      "button",
      { name: /^Chat \d/ },
    ),
  ).toHaveLength(6);
  expect(
    within(
      screen.getByRole("region", { name: i18n.t("sidebarRecent") }),
    ).getAllByRole("button", { name: /^Chat \d/ }),
  ).toHaveLength(11);
  expect(
    screen.queryByRole("button", { name: i18n.t("sidebarShowMore") }),
  ).toBeNull();
});

it("keeps the exact current conversation and its project visible beyond each list limit without expanding other rows", () => {
  const data = catalog(8, 8);
  const selected = data.sessions.at(-1)!;
  data.selectedSession = {
    id: selected.id,
    path: selected.path,
    cwd: selected.cwd,
    entries: [],
    bytes: 0,
    truncation: {
      maxBytes: 4 * 1024 * 1024,
      entriesOmitted: 0,
      messagesTruncated: 0,
      messagePartsOmitted: 0,
      truncated: false,
    },
  };
  const view = mount(data, { selectedPath: selected.path });
  expect(screen.getAllByRole("region", { name: /^Project \d+$/ })).toHaveLength(
    6,
  );
  expect(screen.getByRole("region", { name: "Project 8" })).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Project 6" })).toBeNull();
  const recent = screen.getByRole("region", { name: i18n.t("sidebarRecent") });
  expect(
    within(recent).getAllByRole("button", { name: /^Chat \d/ }),
  ).toHaveLength(11);
  expect(
    within(recent)
      .getByRole("button", { name: `${selected.name} · ${selected.path}` })
      .getAttribute("aria-current"),
  ).toBe("page");
  expect(within(recent).queryByText("Chat 4-1")).toBeNull();
  expect(
    within(recent).getByRole("button", { name: i18n.t("sidebarShowMore") }),
  ).toBeTruthy();

  const projectChat = data.sessions[7]!;
  const selectedSession = {
    ...data.selectedSession,
    id: projectChat.id,
    path: projectChat.path,
    cwd: projectChat.cwd,
  };
  view.rerender({
    snapshot: { ...data, selectedSession },
    selectedPath: projectChat.path,
  });
  const project = screen.getByRole("region", { name: "Project 1" });
  expect(
    within(project).getAllByRole("button", { name: /^Chat \d/ }),
  ).toHaveLength(6);
  expect(
    within(project)
      .getByRole("button", {
        name: `${projectChat.name} · ${projectChat.path}`,
      })
      .getAttribute("aria-current"),
  ).toBe("page");
  expect(within(project).queryByText("Chat 1-6")).toBeNull();
  expect(
    within(project).getByRole("button", { name: i18n.t("sidebarShowMore") }),
  ).toBeTruthy();
  view.rerender({
    snapshot: {
      ...data,
      selectedSession: { ...selectedSession, id: "another-native-session" },
    },
  });
  expect(within(project).queryByText("Chat 1-8")).toBeNull();
  expect(
    within(project).getAllByRole("button", { name: /^Chat \d/ }),
  ).toHaveLength(5);
});

it("keeps a selected worktree chat in its original project and highlights that folder without reordering projects", () => {
  const data = catalog(2, 1);
  const selected = data.sessions[1]!;
  selected.workspacePath = selected.cwd;
  selected.cwd = "/worktrees/fork/app";
  selected.worktree = {
    path: "/worktrees/fork",
    baseSha: "a".repeat(40),
    sourceRoot: "/project-2",
  };
  data.preferences.projectsInRecents = false;
  data.selectedSession = {
    id: selected.id,
    path: selected.path,
    cwd: selected.cwd,
    entries: [],
    bytes: 0,
    truncation: {
      maxBytes: 1_000_000,
      entriesOmitted: 0,
      messagesTruncated: 0,
      messagePartsOmitted: 0,
      truncated: false,
    },
  };
  mount(data, { selectedPath: selected.path, selectedWorkspace: selected.cwd });
  const projects = screen.getAllByRole("region", { name: /^Project \d$/ });
  expect(projects.map((project) => project.getAttribute("aria-label"))).toEqual(
    ["Project 1", "Project 2"],
  );
  const current = within(projects[1]!).getByRole("button", {
    name: "Project 2",
  });
  expect(current.getAttribute("aria-current")).toBe("location");
  expect(current.getAttribute("aria-expanded")).toBe("true");
  const chat = within(projects[1]!).getByRole("button", {
    name: `${selected.name} · ${selected.path}`,
  });
  expect(chat.getAttribute("aria-current")).toBe("page");
  expect(chat.querySelector(".sidebar-worktree-icon")).toBeNull();
  expect(within(projects[0]!).queryByText(selected.name!)).toBeNull();
  expect(
    screen.queryByRole("region", { name: "/worktrees/fork/app" }),
  ).toBeNull();
});

it("replaces the sidebar list with activity and returns without changing the confirmed conversation", () => {
  const current = session("/current", "/repos/long-example", "Current reader");
  const unread = {
    ...session("/done", "/other/shared", "Finished work"),
    unread: true,
    execution: {
      status: "idle" as const,
      lastTurn: {
        commandId: "done",
        finishedAt: 1,
        outcome: "completed" as const,
      },
    },
  };
  const data = snapshot([current, unread]);
  data.selectedSession = {
    id: current.id,
    path: current.path,
    cwd: current.cwd,
  } as WebSnapshot["selectedSession"];
  const { actions } = mount(data, { selectedPath: current.path });
  const select = vi.spyOn(actions, "selectSession").mockResolvedValue();
  const bell = screen.getByRole("button", {
    name: i18n.t("sidebarViewActivity"),
  });
  expect(bell.querySelector(".sidebar-unread-dot")).toBeTruthy();
  fireEvent.click(bell);
  const activity = screen.getByRole("region", {
    name: i18n.t("sidebarActivity"),
  });
  expect(within(activity).getByText("Finished work")).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: `Current reader · ${current.path}` }),
  ).toBeNull();
  expect(
    screen.queryByRole("region", { name: i18n.t("sidebarRecent") }),
  ).toBeNull();
  expect(select).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("sidebarViewChats") }),
  );
  expect(
    screen.queryByRole("region", { name: i18n.t("sidebarActivity") }),
  ).toBeNull();
  expect(
    screen
      .getByRole("button", { name: `Current reader · ${current.path}` })
      .getAttribute("aria-current"),
  ).toBe("page");
  expect(select).not.toHaveBeenCalled();
});

it("retains a newly read Priority row until cleared and merges Priority into dated activity without changing session metadata", async () => {
  const finishedAt = Date.now();
  const entries = ["Opened result", "Still unread"].map((name, index) => ({
    ...session(`/activity-${index}`, "/repos/long-example", name),
    unread: true,
    execution: {
      status: "idle" as const,
      lastTurn: { commandId: name, finishedAt, outcome: "completed" as const },
    },
  }));
  const data = snapshot(entries);
  const view = mount(data);
  const read = vi.spyOn(view.actions, "setSessionRead").mockResolvedValue();
  const archive = vi.spyOn(view.actions, "archiveSession").mockResolvedValue();
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("sidebarViewActivity") }),
  );
  const activity = screen.getByRole("region", {
    name: i18n.t("sidebarActivity"),
  });
  const confirmed = {
    ...data,
    sessions: [{ ...entries[0]!, unread: false }, entries[1]!],
  };
  view.rerender({ snapshot: confirmed });
  expect(
    within(activity)
      .getByRole("region", { name: i18n.t("sidebarPriority") })
      .querySelector(".session-title")?.textContent,
  ).toBe("Opened result");
  expect(
    within(activity).getByRole("region", { name: i18n.t("sidebarPriority") })
      .textContent,
  ).toContain("Opened result");
  fireEvent.click(
    within(activity).getByRole("button", { name: i18n.t("sidebarClearRead") }),
  );
  const priority = within(activity).getByRole("region", {
    name: i18n.t("sidebarPriority"),
  });
  expect(within(priority).queryByText("Opened result")).toBeNull();
  expect(within(priority).getByText("Still unread")).toBeTruthy();
  const dated = within(activity).getByRole("region", {
    name: i18n.t("sidebarToday"),
  });
  expect(within(dated).getByText("Opened result")).toBeTruthy();
  fireEvent.click(
    within(activity).getByRole("button", {
      name: i18n.t("sidebarActivityOptions"),
    }),
  );
  fireEvent.click(
    await screen.findByRole("menuitem", { name: i18n.t("sidebarPriority") }),
  );
  expect(
    within(activity).queryByRole("region", { name: i18n.t("sidebarPriority") }),
  ).toBeNull();
  expect(within(dated).getByText("Still unread")).toBeTruthy();
  fireEvent.click(
    within(activity).getByRole("button", {
      name: i18n.t("sidebarActivityOptions"),
    }),
  );
  const markRead = await screen.findByRole("menuitem", {
    name: i18n.t("sidebarMarkAllRead"),
  });
  expect(markRead.getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(markRead);
  fireEvent.keyDown(markRead, { key: "Escape" });
  expect(
    confirmed.sessions.map((entry) => ({
      path: entry.path,
      unread: entry.unread,
    })),
  ).toEqual([
    { path: "/activity-0", unread: false },
    { path: "/activity-1", unread: true },
  ]);
  expect(read).not.toHaveBeenCalled();
  expect(archive).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("sidebarViewChats") }),
  );
  expect(
    screen.getByText("Opened result", { selector: ".session-title" }),
  ).toBeTruthy();
  expect(
    screen.getByText("Still unread", { selector: ".session-title" }),
  ).toBeTruthy();
});

it("keeps Priority order after reading and appends existing arrivals but prepends new conversations", () => {
  const at = Date.now();
  const entries: WebSessionSummary[] = [
    {
      ...session("/active", "/repos/long-example", "Active"),
      execution: { status: "running" as const },
    },
    { ...session("/unread", "/repos/long-example", "Unread"), unread: true },
    {
      ...session("/waiting", "/repos/long-example", "Waiting"),
      execution: { status: "running" as const, waitingForInput: true },
    },
    session("/existing", "/repos/long-example", "Existing"),
  ].map((entry, index) => ({
    ...entry,
    modified: new Date(at - index * 1000).toISOString(),
  }));
  const data = snapshot(entries);
  const view = mount(data);
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("sidebarViewActivity") }),
  );
  const priority = screen.getByRole("region", {
    name: i18n.t("sidebarPriority"),
  });
  const titles = () =>
    [...priority.querySelectorAll(".session-title")].map(
      (node) => node.textContent,
    );
  expect(titles()).toEqual(["Waiting", "Unread", "Active"]);
  const updated = entries.map((entry) => ({
    ...entry,
    unread: entry.path === "/existing",
  }));
  view.rerender({ snapshot: { ...data, sessions: updated } });
  expect(titles()).toEqual(["Waiting", "Unread", "Active", "Existing"]);
  const created = {
    ...session("/new", "/repos/long-example", "New"),
    created: new Date(at + 1000).toISOString(),
    unread: true,
  };
  view.rerender({ snapshot: { ...data, sessions: [...updated, created] } });
  expect(titles()).toEqual(["New", "Waiting", "Unread", "Active", "Existing"]);
});

it("shows an expanded project's empty state only when the loaded catalog is complete", () => {
  const data = snapshot([]);
  data.workspaces = [{ path: "/empty", name: "Empty", current: false }];
  const view = mount(data);
  const project = screen.getByRole("region", { name: "Empty" });
  expect(project.querySelector(".workspace-empty")?.textContent).toBe(
    i18n.t("noConversations"),
  );
  view.rerender({ collapsed: new Set(["/empty"]) });
  expect(project.querySelector(".workspace-empty")).toBeNull();
  view.rerender({
    collapsed: new Set(),
    snapshot: {
      ...data,
      truncation: { ...data.truncation, sessionsOmitted: 1, truncated: true },
    },
  });
  expect(project.querySelector(".workspace-empty")).toBeNull();
});

it("keeps an earlier unread failure visible and dates its activity by that result after a later cancellation", async () => {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  yesterday.setHours(12, 0, 0, 0);
  const entry: WebSessionSummary = {
    ...session("/earlier-failure", "/repos/long-example", "Earlier failure"),
    unread: true,
    firstUnread: {
      type: "turn",
      commandId: "failed-turn",
      finishedAt: yesterday.getTime(),
      outcome: "failed",
      resultEntryId: "failed-result",
    },
    execution: {
      status: "idle",
      lastTurn: {
        commandId: "later-cancelled-turn",
        finishedAt: Date.now(),
        outcome: "cancelled",
      },
    },
  };
  mount(snapshot([entry]));
  expect(
    screen
      .getByRole("button", { name: /^Earlier failure ·/ })
      .querySelector(".session-state-attention"),
  ).toBeTruthy();
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("sidebarViewActivity") }),
  );
  const activity = screen.getByRole("region", {
    name: i18n.t("sidebarActivity"),
  });
  fireEvent.click(
    within(activity).getByRole("button", {
      name: i18n.t("sidebarActivityOptions"),
    }),
  );
  fireEvent.click(
    await screen.findByRole("menuitem", { name: i18n.t("sidebarPriority") }),
  );
  const dated = within(activity).getByRole("region", {
    name: i18n.t("sidebarYesterday"),
  });
  expect(
    within(dated)
      .getByRole("button", { name: /^Earlier failure ·/ })
      .querySelector(".session-state-attention"),
  ).toBeTruthy();
  expect(
    within(activity).queryByRole("region", { name: i18n.t("sidebarToday") }),
  ).toBeNull();
});

it("includes seven local calendar dates from midnight and retains older unread or running activity", () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-12T15:30:00"));
  try {
    const dates = [
      "2026-10-12",
      "2026-10-11",
      "2026-10-10",
      "2026-10-09",
      "2026-10-08",
      "2026-10-07",
      "2026-10-06",
    ];
    const entries = dates.map((date) => ({
      ...session(`/read-${date}`, "/repos/long-example", `Read ${date}`),
      unread: false,
      execution: {
        status: "idle" as const,
        lastTurn: {
          commandId: date,
          finishedAt: new Date(`${date}T00:00:00`).getTime(),
          outcome: "completed" as const,
        },
      },
    }));
    const previousDay = {
      ...session("/previous-day", "/repos/long-example", "Before midnight"),
      unread: false,
      execution: {
        status: "idle" as const,
        lastTurn: {
          commandId: "previous-day",
          finishedAt: new Date("2026-10-05T23:59:59.999").getTime(),
          outcome: "failed" as const,
        },
      },
    };
    const oldUnread = {
      ...session("/old-unread", "/repos/long-example", "Old unread"),
      unread: true,
      execution: {
        status: "idle" as const,
        lastTurn: {
          commandId: "old-unread",
          finishedAt: new Date("2026-10-01T12:00:00").getTime(),
          outcome: "completed" as const,
        },
      },
    };
    const oldRunning = {
      ...session("/old-running", "/repos/long-example", "Old running"),
      unread: false,
      execution: { status: "running" as const },
    };
    const { actions } = mount(
      snapshot([...entries, previousDay, oldUnread, oldRunning]),
    );
    const read = vi.spyOn(actions, "setSessionRead").mockResolvedValue();
    fireEvent.click(
      screen.getByRole("button", { name: i18n.t("sidebarViewActivity") }),
    );
    const activity = screen.getByRole("region", {
      name: i18n.t("sidebarActivity"),
    });
    for (const date of dates)
      expect(within(activity).getByText(`Read ${date}`)).toBeTruthy();
    expect(within(activity).queryByText("Before midnight")).toBeNull();
    const priority = within(activity).getByRole("region", {
      name: i18n.t("sidebarPriority"),
    });
    expect(within(priority).getByText("Old unread")).toBeTruthy();
    expect(within(priority).getByText("Old running")).toBeTruthy();
    expect(read).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

it("loads the next activity rows when the scroll tail becomes visible and keeps them when a new unread receipt arrives", () => {
  let onIntersection:
    | ((entries: { isIntersecting: boolean }[]) => void)
    | undefined;
  const observe = vi.fn();
  const disconnect = vi.fn();
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: typeof onIntersection) {
        onIntersection = callback;
      }
      observe = observe;
      disconnect = disconnect;
    },
  );
  const now = Date.now();
  const entries = Array.from({ length: 12 }, (_, index) => ({
    ...session(
      `/record-${index}`,
      "/repos/long-example",
      `Record ${index + 1}`,
    ),
    unread: false,
    execution: {
      status: "idle" as const,
      lastTurn: {
        commandId: `turn-${index}`,
        finishedAt: now - (index + 1) * 1000,
        outcome: "completed" as const,
      },
    },
  }));
  const expired = {
    ...entries[0]!,
    id: "expired",
    path: "/expired",
    name: "Expired read result",
    execution: {
      status: "idle" as const,
      lastTurn: {
        commandId: "expired",
        finishedAt: now - 8 * 86400000,
        outcome: "completed" as const,
      },
    },
  };
  const data = snapshot([...entries, expired]);
  const view = mount(data);
  const read = vi.spyOn(view.actions, "setSessionRead").mockResolvedValue();
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("sidebarViewActivity") }),
  );
  const activity = screen.getByRole("region", {
    name: i18n.t("sidebarActivity"),
  });
  expect(
    within(activity).getAllByRole("button", { name: /^Record \d+ ·/ }),
  ).toHaveLength(10);
  expect(within(activity).queryByText("Expired read result")).toBeNull();
  const tail = within(activity).getByRole("status", {
    name: i18n.t("loading"),
  });
  expect(observe).toHaveBeenCalledWith(tail);
  act(() => onIntersection?.([{ isIntersecting: false }]));
  expect(
    within(activity).getAllByRole("button", { name: /^Record \d+ ·/ }),
  ).toHaveLength(10);
  act(() => onIntersection?.([{ isIntersecting: true }]));
  expect(
    within(activity).getAllByRole("button", { name: /^Record \d+ ·/ }),
  ).toHaveLength(12);
  const incoming = {
    ...entries[0]!,
    id: "incoming",
    path: "/incoming",
    name: "Incoming",
    unread: true,
    execution: {
      status: "idle" as const,
      lastTurn: {
        commandId: "new-turn",
        finishedAt: now,
        outcome: "completed" as const,
      },
    },
  };
  view.rerender({
    snapshot: { ...data, sessions: [incoming, ...data.sessions] },
  });
  expect(
    within(activity).getAllByRole("button", { name: /^Record \d+ ·/ }),
  ).toHaveLength(12);
  expect(
    within(
      within(activity).getByRole("region", { name: i18n.t("sidebarPriority") }),
    ).getByText("Incoming"),
  ).toBeTruthy();
  expect(
    within(activity).queryByRole("status", { name: i18n.t("loading") }),
  ).toBeNull();
  expect(disconnect).toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
});

it("groups pins once, sorts, collapses, and submits identity-bound manual moves", async () => {
  const a = {
    ...session("/a.jsonl", "/repos/long-example", "Older pin"),
    pinOrder: 0,
  };
  const b = {
    ...session("/b.jsonl", "/other/shared", "Newer pin"),
    pinOrder: 2,
    modified: "2026-09-29T10:00:00Z",
  };
  const ordinary = session("/c.jsonl", "/repos/long-example", "Ordinary");
  const data = snapshot([b, ordinary, a]);
  data.workspaces[0] = {
    ...data.workspaces[0]!,
    name: "Pinned project",
    pinOrder: 1,
  };
  const actions = createWebStore().getState().actions;
  const pin = vi.spyOn(actions, "setSessionPin").mockResolvedValue();
  const movePin = vi.spyOn(actions, "setSidebarPin").mockResolvedValue();
  const refresh = vi.spyOn(actions, "refreshSnapshot").mockResolvedValue(true);
  const save = vi
    .spyOn(WebClient.prototype, "savePreferences")
    .mockRejectedValueOnce(new Error("offline"));
  const view = mount(data, { actions });
  const section = screen.getByRole("region", { name: "Pinned" });
  expect(
    within(section)
      .getAllByText(/^(Older pin|Pinned project|Newer pin)$/)
      .map((node) => node.textContent),
  ).toEqual(["Older pin", "Pinned project", "Newer pin"]);
  expect(
    screen.getAllByRole("button", { name: `Older pin · ${a.path}` }),
  ).toHaveLength(1);
  fireEvent.click(within(section).getByRole("button", { name: "Pinned" }));
  expect(within(section).queryByText("Older pin")).toBeNull();
  fireEvent.click(within(section).getByRole("button", { name: "Pinned" }));
  fireEvent.click(
    within(section).getAllByRole("button", {
      name: "Conversation options",
    })[2]!,
  );
  fireEvent.click(await screen.findByRole("menuitem", { name: "Move up" }));
  await waitFor(() =>
    expect(movePin).toHaveBeenCalledWith(
      { kind: "session", path: b.path, id: b.id },
      true,
      { kind: "workspace", path: ordinary.cwd },
    ),
  );
  fireEvent.click(
    within(section).getByRole("button", { name: "Workspace options" }),
  );
  fireEvent.click(await screen.findByRole("menuitem", { name: "Move up" }));
  await waitFor(() =>
    expect(movePin).toHaveBeenLastCalledWith(
      { kind: "workspace", path: ordinary.cwd },
      true,
      { kind: "session", path: a.path, id: a.id },
    ),
  );
  fireEvent.click(
    within(section).getByRole("button", { name: "Pinned options" }),
  );
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "Recently updated" }),
  );
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toBe(
      i18n.t("sidebarSaveFailed"),
    ),
  );
  expect(save).toHaveBeenCalledWith({ pinnedSort: "updated" });
  expect(refresh).not.toHaveBeenCalled();
  view.rerender({
    snapshot: {
      ...data,
      preferences: { ...data.preferences, pinnedSort: "updated" },
    },
  });
  expect(
    within(section)
      .getAllByText(/^(Older pin|Pinned project|Newer pin)$/)
      .map((node) => node.textContent),
  ).toEqual(["Newer pin", "Older pin", "Pinned project"]);
  fireEvent.click(
    within(section).getAllByRole("button", {
      name: "Unpin conversation",
    })[0]!,
  );
  await waitFor(() =>
    expect(pin).toHaveBeenLastCalledWith(b.path, b.id, false, undefined),
  );
  view.rerender({ query: "Older" });
  expect(within(section).queryByText("Newer pin")).toBeNull();
  expect(within(section).getByText("Older pin")).toBeTruthy();
  expect(screen.queryByText(i18n.t("noMatching"))).toBeNull();
});

it("shows per-Session running and queue facts without borrowing global runtime state", () => {
  const running = session(
    "/repos/long-example/one.jsonl",
    "/repos/long-example",
    "Working",
  );
  running.execution = { status: "running", pendingFollowUps: 2 };
  const unknown = session(
    "/repos/long-example/copy.jsonl",
    "/repos/long-example",
    "Unloaded",
  );
  unknown.id = running.id;
  const queued = session(
    "/other/shared/three.jsonl",
    "/other/shared",
    "Waiting",
  );
  queued.execution = { status: "idle", pendingFollowUps: 120 };
  const data = snapshot([running, unknown, queued]);
  data.runtime.status = "running";
  mount(data);

  const workingButton = screen.getByRole("button", {
    name: `Working · ${running.path} · Running · 2 messages queued`,
  });
  expect(workingButton.querySelector(".session-state-running")).toBeTruthy();
  expect(workingButton.querySelector(".session-queue")?.textContent).toBe("2");
  expect(
    screen
      .getByRole("button", { name: `Unloaded · ${unknown.path}` })
      .querySelector(".session-status"),
  ).toBeNull();
  const waitingButton = screen.getByRole("button", {
    name: `Waiting · ${queued.path} · 120 messages queued`,
  });
  expect(waitingButton.querySelector(".session-queue")?.textContent).toBe(
    "99+",
  );
  expect(waitingButton.querySelector(".session-state-running")).toBeNull();
});

it("shows only running, unread completion and attention; stopped and unknown remain quiet", () => {
  const entries: WebSessionSummary[] = (
    ["completed", "failed", "cancelled", "uncertain"] as const
  ).map((outcome) => ({
    ...session(`/${outcome}`, "/repos/long-example", outcome),
    unread: outcome === "completed" || outcome === "failed",
    execution: {
      status: "idle" as const,
      lastTurn: { commandId: outcome, finishedAt: 1, outcome },
    },
  }));
  entries.push({
    ...session("/live", "/repos/long-example", "Live"),
    execution: { status: "running", waitingForInput: true },
  });
  const view = mount(snapshot(entries));
  expect(document.querySelector(".session-state-completed")).toBeTruthy();
  expect(document.querySelectorAll(".session-state-attention")).toHaveLength(2);
  for (const outcome of ["failed", "cancelled", "uncertain", "waiting"])
    expect(document.querySelector(`.session-state-${outcome}`)).toBeNull();
  view.rerender({ connected: false });
  expect(document.querySelectorAll(".session-state-attention")).toHaveLength(1);
  expect(document.querySelector(".session-state-disconnected")).toBeNull();
  expect(document.querySelector(".session-state-running")).toBeNull();
});

it("acknowledges the exact loaded revision and waits for backend read state while a new background receipt remains unread", async () => {
  const completed = session(
    "/completion-receipt",
    "/repos/long-example",
    "Done",
  );
  completed.unread = true;
  completed.execution = {
    status: "unknown",
    lastTurn: {
      commandId: "first",
      finishedAt: 1,
      outcome: "completed",
      resultEntryId: "first-result",
    },
  };
  const data = snapshot([completed]);
  data.selectedSession = {
    id: completed.id,
    path: completed.path,
    cwd: completed.cwd,
    entries: [],
    bytes: 0,
    truncation: {
      maxBytes: 4 * 1024 * 1024,
      entriesOmitted: 0,
      messagesTruncated: 0,
      messagePartsOmitted: 0,
      truncated: false,
    },
  };
  const actions = createWebStore().getState().actions;
  const read = vi.spyOn(actions, "setSessionRead").mockResolvedValue();
  const focus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
  const view = mount(data, {
    actions,
    selectedPath: completed.path,
    connected: true,
    sessionViewVisible: false,
  });
  expect(document.querySelector(".session-state-completed")).toBeTruthy();
  expect(read).not.toHaveBeenCalled();
  view.rerender({ sessionViewVisible: true, selectedPath: "/not-loaded" });
  expect(read).not.toHaveBeenCalled();
  view.rerender({ selectedPath: completed.path });
  expect(read).not.toHaveBeenCalled();
  fireEvent(window, new Event("focus"));
  expect(read).not.toHaveBeenCalled();
  focus.mockReturnValue(true);
  fireEvent(window, new Event("focus"));
  await waitFor(() =>
    expect(read).toHaveBeenCalledExactlyOnceWith(
      completed.path,
      completed.id,
      true,
      completed.readRevision,
    ),
  );
  // A successful write request does not replace the server's reading projection.
  expect(document.querySelector(".session-state-completed")).toBeTruthy();
  view.rerender({
    snapshot: {
      ...data,
      sessions: [
        { ...completed, unread: false, readRevision: "confirmed-read" },
      ],
    },
  });
  expect(document.querySelector(".session-state-completed")).toBeNull();
  const newer = {
    ...completed,
    readRevision: "second-completion",
    execution: {
      ...completed.execution,
      lastTurn: {
        commandId: "second",
        finishedAt: 2,
        outcome: "completed" as const,
        resultEntryId: "second-result",
      },
    },
  };
  view.rerender({
    snapshot: { ...data, sessions: [newer] },
    sessionViewVisible: false,
  });
  expect(document.querySelector(".session-state-completed")).toBeTruthy();
  expect(read).toHaveBeenCalledOnce();
});

it("keeps a visible conversation manually marked unread elsewhere unread until the user opens it again", async () => {
  const viewed = session("/viewed", "/repos/long-example", "Viewed chat");
  viewed.unread = false;
  viewed.execution = {
    status: "idle",
    lastTurn: { commandId: "viewed-turn", finishedAt: 1, outcome: "completed" },
  };
  const data = snapshot([viewed]);
  data.selectedSession = {
    id: viewed.id,
    path: viewed.path,
    cwd: viewed.cwd,
    entries: [],
    bytes: 0,
    truncation: {
      maxBytes: 4 * 1024 * 1024,
      entriesOmitted: 0,
      messagesTruncated: 0,
      messagePartsOmitted: 0,
      truncated: false,
    },
  };
  const actions = createWebStore().getState().actions;
  const read = vi.spyOn(actions, "setSessionRead").mockResolvedValue();
  vi.spyOn(actions, "selectSession").mockResolvedValue();
  const view = mount(data, {
    actions,
    selectedPath: viewed.path,
    connected: true,
    sessionViewVisible: true,
  });
  expect(
    screen
      .getByRole("button", { name: `Viewed chat · ${viewed.path}` })
      .getAttribute("aria-current"),
  ).toBe("page");
  expect(read).not.toHaveBeenCalled();
  const externallyUnread = {
    ...viewed,
    unread: true,
    readRevision: "marked-unread-elsewhere",
  };
  view.rerender({ snapshot: { ...data, sessions: [externallyUnread] } });
  fireEvent(document, new Event("visibilitychange"));
  expect(document.querySelector(".session-state-completed")).toBeTruthy();
  expect(read).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: /^Viewed chat ·/ }));
  await waitFor(() =>
    expect(read).toHaveBeenCalledExactlyOnceWith(
      viewed.path,
      viewed.id,
      true,
      externallyUnread.readRevision,
    ),
  );
  expect(document.querySelector(".session-state-completed")).toBeTruthy();
});

it("clears sidebar execution markers when the runtime releases the Session", () => {
  const working = session(
    "/repos/long-example/one.jsonl",
    "/repos/long-example",
    "Working",
  );
  working.execution = { status: "running", pendingFollowUps: 1 };
  const { rerender } = mount(snapshot([working]));
  expect(
    screen
      .getByRole("button", { name: /Working.*Running.*1 messages queued/ })
      .querySelector(".session-status"),
  ).toBeTruthy();

  rerender({
    snapshot: snapshot([
      { ...working, execution: { status: "idle", pendingFollowUps: 0 } },
    ]),
  });
  expect(
    screen
      .getByRole("button", { name: `Working · ${working.path}` })
      .querySelector(".session-status"),
  ).toBeNull();
  rerender({ snapshot: snapshot([{ ...working, execution: undefined }]) });
  expect(
    screen
      .getByRole("button", { name: `Working · ${working.path}` })
      .querySelector(".session-status"),
  ).toBeNull();
});

it("searches the current loaded list and the separate archived query without changing collapse", async () => {
  const data = snapshot([
    session("/repos/long-example/one.jsonl", "/repos/long-example", "First"),
    session(
      "/repos/long-example/two.jsonl",
      "/repos/long-example",
      "Old",
      true,
    ),
    session("/other/shared/three.jsonl", "/other/shared", "Third"),
  ]);
  data.truncation.sessionsOmitted = 12;
  const { rerender } = mount(data, {
    collapsed: new Set(["/repos/long-example"]),
    query: "long-example",
    searchOpen: true,
  });
  expect(
    screen.getByText("First", { selector: ".session-title" }),
  ).toBeTruthy();
  expect(screen.queryByText("Old")).toBeNull();
  expect(screen.getByText("/repos/long-example")).toBeTruthy();
  expect(screen.getByText(/12 more sessions.*loaded list only/)).toBeTruthy();
  expect(
    screen
      .getByRole("button", { name: /Shared.*long-example/ })
      .getAttribute("aria-expanded"),
  ).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Archived" }));
  expect(await screen.findByText("Old")).toBeTruthy();
  expect(
    screen.queryByText("First", { selector: ".session-title" }),
  ).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Current" }));
  rerender({ query: "" });
  expect(
    screen.queryByText("First", { selector: ".session-title" }),
  ).toBeNull();
  expect(
    screen
      .getByRole("button", { name: /Shared.*long-example/ })
      .getAttribute("aria-expanded"),
  ).toBe("false");
});

it("does not claim zero unloaded records during a complete-list search", () => {
  const data = snapshot([
    session("/repos/long-example/one.jsonl", "/repos/long-example", "First"),
  ]);
  mount(data, { query: "first", searchOpen: true });

  expect(
    screen.getByText("First", { selector: ".session-title" }),
  ).toBeTruthy();
  expect(screen.queryByText(/loaded list only/iu)).toBeNull();
  expect(screen.queryByText(/0 more sessions/iu)).toBeNull();
});

it("scopes an empty search result to loaded history when sessions are omitted", () => {
  const data = snapshot([
    session("/repos/long-example/one.jsonl", "/repos/long-example", "First"),
  ]);
  data.truncation.sessionsOmitted = 12;
  mount(data, { query: "missing", searchOpen: true });

  expect(
    screen.getByText("No matching conversations in the loaded history"),
  ).toBeTruthy();
  expect(screen.queryByText("No matching conversations")).toBeNull();
});

it("distinguishes identical names by path and marks only a snapshot-confirmed selection", async () => {
  const first = session(
    "/repos/long-example/one.jsonl",
    "/repos/long-example",
    "Same title that continues over multiple words",
  );
  const second = session(
    "/other/shared/two.jsonl",
    "/other/shared",
    first.name!,
  );
  const data = snapshot([first, second]);
  const { actions, rerender } = mount(data, {
    selectedPath: first.path,
    selectedWorkspace: first.cwd,
  });
  const firstButton = screen.getByRole("button", {
    name: `${first.name} · ${first.path}`,
  });
  const secondButton = screen.getByRole("button", {
    name: `${second.name} · ${second.path}`,
  });
  expect(firstButton.getAttribute("aria-current")).toBeNull();
  data.selectedSession = {
    id: first.id,
    path: first.path,
  } as WebSnapshot["selectedSession"];
  data.currentSessionId = first.id;
  rerender({ snapshot: { ...data } });
  expect(firstButton.getAttribute("aria-current")).toBe("page");
  expect(secondButton.getAttribute("aria-current")).toBeNull();
  expect(
    screen
      .getByRole("button", { name: /Shared.*long-example/ })
      .getAttribute("aria-current"),
  ).toBe("location");
  const select = vi.spyOn(actions, "selectSession").mockResolvedValue();
  fireEvent.click(secondButton);
  expect(select).toHaveBeenCalledWith(second.path);
});

it("keeps a failed rename draft editable and saves it on retry", async () => {
  const data = snapshot([
    session("/repos/long-example/one.jsonl", "/repos/long-example", "First"),
  ]);
  const { actions } = mount(data);
  const rename = vi
    .spyOn(actions, "renameSession")
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce();
  fireEvent.click(screen.getByRole("button", { name: "Conversation options" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
  const input = await screen.findByRole<HTMLInputElement>("textbox", {
    name: "Conversation name",
  });
  fireEvent.change(input, { target: { value: "Revised" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(rename).toHaveBeenCalledTimes(1));
  expect(input.value).toBe("Revised");
  expect(
    screen.getByRole("dialog", { name: "Rename conversation" }),
  ).toBeTruthy();
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "Save" })),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "Rename conversation" }),
    ).toBeNull(),
  );
  expect(rename).toHaveBeenLastCalledWith(
    "/repos/long-example/one.jsonl",
    "Revised",
  );
});

it("keeps an archived row available after an unconfirmed restore", async () => {
  const data = snapshot([
    session(
      "/repos/long-example/old.jsonl",
      "/repos/long-example",
      "Old",
      true,
    ),
  ]);
  const { actions } = mount(data);
  const restore = vi
    .spyOn(actions, "unarchiveSession")
    .mockResolvedValueOnce(false)
    .mockResolvedValueOnce(true);
  fireEvent.click(screen.getByRole("button", { name: "Archived" }));
  await screen.findByText("Old");
  fireEvent.click(screen.getByRole("button", { name: "Conversation options" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Restore" }));
  await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
  expect(screen.getByText("Old")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Conversation options" }));
  await act(async () =>
    fireEvent.click(await screen.findByRole("menuitem", { name: "Restore" })),
  );
  expect(restore).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("alert")).toBeNull();
});

it.each([false, true])(
  "marks the confirmed reader independently of the controller (copied id: %s)",
  (copiedId) => {
    const controller = session(
      "/repos/long-example/a.jsonl",
      "/repos/long-example",
      "Controller",
    );
    controller.controller = "web";
    const reader = session("/other/shared/b.jsonl", "/other/shared", "Reader");
    if (copiedId) reader.id = controller.id;
    const data = snapshot([controller, reader]);
    data.currentSessionId = controller.id;
    data.currentSessionPath = controller.path;
    data.selectedSession = {
      id: reader.id,
      path: reader.path,
      cwd: reader.cwd,
    } as WebSnapshot["selectedSession"];
    const { rerender } = mount(data, { selectedPath: reader.path });
    const selected = screen.getByRole("button", {
      name: `Reader · ${reader.path}`,
    });
    expect(selected.getAttribute("aria-current")).toBe("page");
    expect(
      screen
        .getByRole("button", { name: `Controller · ${controller.path}` })
        .getAttribute("aria-current"),
    ).toBeNull();
    expect(
      screen
        .getByRole("button", { name: /Shared.*other\/shared/u })
        .getAttribute("aria-current"),
    ).toBe("location");
    rerender({ selectedPath: controller.path });
    expect(selected.getAttribute("aria-current")).toBeNull();
    expect(
      document.querySelector('.workspace-label[aria-current="location"]'),
    ).toBeNull();
    rerender({ selectedPath: null, selectedWorkspace: controller.cwd });
    expect(
      document.querySelector('.workspace-label[aria-current="location"]'),
    ).toBeNull();
  },
);

it("loads and appends archived records outside the bounded snapshot without duplicating paths", async () => {
  const first = session("/old/one.jsonl", "/old", "Unloaded first", true);
  const second = session("/old/two.jsonl", "/old", "Unloaded second", true);
  const list = vi
    .spyOn(WebClient.prototype, "listArchivedSessions")
    .mockResolvedValueOnce(archivePage([first], "next"))
    .mockResolvedValueOnce(archivePage([first, second]));
  mount(snapshot([]));
  fireEvent.click(screen.getByRole("button", { name: "Archived" }));
  await screen.findByText("Unloaded first");
  fireEvent.click(screen.getByRole("button", { name: i18n.t("moreArchives") }));
  await screen.findByText("Unloaded second");
  expect(screen.getAllByText("Unloaded first")).toHaveLength(1);
  expect(list).toHaveBeenLastCalledWith(
    { query: "", cursor: "next", limit: 25 },
    expect.any(AbortSignal),
  );
  expect(
    screen.queryByRole("button", { name: i18n.t("moreArchives") }),
  ).toBeNull();
});

it("shows archive loading without an empty result and disables duplicate reads", async () => {
  let finish!: (page: ArchivedSessionPage) => void;
  const list = vi
    .spyOn(WebClient.prototype, "listArchivedSessions")
    .mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
  mount(snapshot([]));
  fireEvent.click(screen.getByRole("button", { name: "Archived" }));
  expect(screen.getByText(i18n.t("loadingArchives")).getAttribute("role")).toBe(
    "status",
  );
  expect(
    screen.queryByText(i18n.t("noArchivedSessions"))?.closest("[hidden]"),
  ).toBeTruthy();
  const refresh = screen.getByRole<HTMLButtonElement>("button", {
    name: i18n.t("refreshArchives"),
  });
  expect(refresh.disabled).toBe(true);
  fireEvent.click(refresh);
  expect(list).toHaveBeenCalledOnce();
  await act(async () => finish(archivePage([])));
  expect(screen.getByText(i18n.t("noArchivedSessions"))).toBeTruthy();
  expect(refresh.disabled).toBe(false);
});

it("isolates archive queries and ignores an aborted late page", async () => {
  let finish!: (page: ArchivedSessionPage) => void;
  let firstSignal!: AbortSignal;
  const beta = session("/old/b.jsonl", "/old", "Beta", true);
  const list = vi
    .spyOn(WebClient.prototype, "listArchivedSessions")
    .mockImplementationOnce((_options, signal) => {
      firstSignal = signal!;
      return new Promise((resolve) => {
        finish = resolve;
      });
    })
    .mockResolvedValueOnce(archivePage([beta]));
  const view = mount(snapshot([]), { query: "alpha", searchOpen: true });
  fireEvent.click(screen.getByRole("button", { name: "Archived" }));
  view.rerender({ query: "beta" });
  expect(firstSignal.aborted).toBe(true);
  await screen.findByText("Beta");
  await act(async () =>
    finish(archivePage([session("/old/a.jsonl", "/old", "Alpha", true)])),
  );
  expect(screen.queryByText("Alpha")).toBeNull();
  expect(list).toHaveBeenLastCalledWith(
    { query: "beta", limit: 25 },
    expect.any(AbortSignal),
  );
});

it("retains archive rows on a stale cursor and refreshes the first page", async () => {
  const old = session("/old/a.jsonl", "/old", "Retained", true);
  const list = vi
    .spyOn(WebClient.prototype, "listArchivedSessions")
    .mockResolvedValueOnce(archivePage([old], "stale"))
    .mockRejectedValueOnce(
      new WebApiError("stale", 409, "ARCHIVED_SESSION_CURSOR_STALE"),
    )
    .mockResolvedValueOnce(archivePage([]));
  mount(snapshot([]));
  fireEvent.click(screen.getByRole("button", { name: "Archived" }));
  await screen.findByText("Retained");
  fireEvent.click(screen.getByRole("button", { name: i18n.t("moreArchives") }));
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain(i18n.t("archiveCursorStale"));
  expect(screen.getByText("Retained")).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: i18n.t("moreArchives") }),
  ).toBeNull();
  fireEvent.click(
    within(alert).getByRole("button", { name: i18n.t("refreshArchives") }),
  );
  await screen.findByText(i18n.t("noArchivedSessions"));
  expect(list).toHaveBeenLastCalledWith(
    { query: "", limit: 25 },
    expect.any(AbortSignal),
  );
});

it("retries the failed archive page without falsely treating a generic 409 as a stale cursor", async () => {
  const old = session("/old/a.jsonl", "/old", "Retained", true);
  const list = vi
    .spyOn(WebClient.prototype, "listArchivedSessions")
    .mockResolvedValueOnce(archivePage([old], "next"))
    .mockRejectedValueOnce(new WebApiError("busy", 409, "SESSION_BUSY"))
    .mockResolvedValueOnce(archivePage([]));
  mount(snapshot([]));
  fireEvent.click(screen.getByRole("button", { name: "Archived" }));
  await screen.findByText("Retained");
  fireEvent.click(screen.getByRole("button", { name: i18n.t("moreArchives") }));
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain(i18n.t("archiveLoadFailed"));
  expect(alert.textContent).not.toContain(i18n.t("archiveCursorStale"));
  fireEvent.click(
    within(alert).getByRole("button", { name: i18n.t("retryArchives") }),
  );
  await waitFor(() => expect(list).toHaveBeenCalledTimes(3));
  expect(list).toHaveBeenLastCalledWith(
    { query: "", cursor: "next", limit: 25 },
    expect.any(AbortSignal),
  );
  expect(screen.getByText("Retained")).toBeTruthy();
});

it.each(["view", "unmount"] as const)(
  "aborts archive reads at the %s lifecycle boundary",
  async (boundary) => {
    let finish!: (page: ArchivedSessionPage) => void;
    let signal!: AbortSignal;
    vi.spyOn(WebClient.prototype, "listArchivedSessions").mockImplementation(
      (_options, nextSignal) => {
        signal = nextSignal!;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    );
    const view = mount(snapshot([]));
    fireEvent.click(screen.getByRole("button", { name: "Archived" }));
    if (boundary === "unmount") view.unmount();
    else fireEvent.click(screen.getByRole("button", { name: "Current" }));
    expect(signal.aborted).toBe(true);
    await act(async () =>
      finish(archivePage([session("/old/a.jsonl", "/old", "Late", true)])),
    );
    expect(screen.queryByText("Late")).toBeNull();
  },
);

it("refreshes archives after restoration without selecting the restored Session", async () => {
  const old = session("/old/a.jsonl", "/old", "Restore me", true);
  vi.spyOn(WebClient.prototype, "listArchivedSessions")
    .mockResolvedValueOnce(archivePage([old]))
    .mockResolvedValueOnce(archivePage([]));
  const { actions } = mount(snapshot([]));
  const restore = vi.spyOn(actions, "unarchiveSession").mockResolvedValue(true);
  const select = vi.spyOn(actions, "selectSession").mockResolvedValue();
  fireEvent.click(screen.getByRole("button", { name: "Archived" }));
  await screen.findByText("Restore me");
  fireEvent.click(screen.getByRole("button", { name: "Conversation options" }));
  fireEvent.click(
    await screen.findByRole("menuitem", {
      name: i18n.t("sidebarRestore"),
    }),
  );
  await screen.findByText(i18n.t("noArchivedSessions"));
  expect(restore).toHaveBeenCalledExactlyOnceWith(old.path);
  expect(select).not.toHaveBeenCalled();
});

it("does not expose a restore failure from a previous archive query", async () => {
  const old = session("/old/a.jsonl", "/old", "Alpha", true);
  const next = session("/old/b.jsonl", "/old", "Beta", true);
  vi.spyOn(WebClient.prototype, "listArchivedSessions")
    .mockResolvedValueOnce(archivePage([old]))
    .mockResolvedValueOnce(archivePage([next]));
  const view = mount(snapshot([]), { query: "alpha" });
  let finish!: (restored: boolean) => void;
  vi.spyOn(view.actions, "unarchiveSession").mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Archived" }));
  await screen.findByText("Alpha");
  fireEvent.click(screen.getByRole("button", { name: "Conversation options" }));
  fireEvent.click(
    await screen.findByRole("menuitem", {
      name: i18n.t("sidebarRestore"),
    }),
  );
  view.rerender({ query: "beta" });
  await screen.findByText("Beta");
  await act(async () => finish(false));
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByText("Beta")).toBeTruthy();
});

it("keeps a confirmed workspace marked when its selected Session is outside the catalog", () => {
  const data = snapshot([]);
  data.selectedSession = {
    id: "reader",
    path: "/other/shared/old.jsonl",
    cwd: "/other/shared",
  } as WebSnapshot["selectedSession"];
  mount(data, { selectedPath: data.selectedSession!.path });
  expect(
    screen
      .getByRole("button", { name: /Shared.*other\/shared/u })
      .getAttribute("aria-current"),
  ).toBe("location");
});

it("does not mark a stale catalog id at the confirmed selected path", () => {
  const row = session("/other/shared/old.jsonl", "/other/shared", "Stale row");
  const data = snapshot([row]);
  data.selectedSession = {
    id: "replacement",
    path: row.path,
    cwd: row.cwd,
  } as WebSnapshot["selectedSession"];
  mount(data, { selectedPath: row.path });
  expect(
    screen
      .getByRole("button", { name: `Stale row · ${row.path}` })
      .getAttribute("aria-current"),
  ).toBeNull();
});

it("does not start another archive read after a restore settles beyond unmount", async () => {
  const old = session("/old/a.jsonl", "/old", "Old", true);
  const list = vi
    .spyOn(WebClient.prototype, "listArchivedSessions")
    .mockResolvedValue(archivePage([old]));
  const view = mount(snapshot([]));
  let finish!: (restored: boolean) => void;
  vi.spyOn(view.actions, "unarchiveSession").mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Archived" }));
  await screen.findByText("Old");
  fireEvent.click(screen.getByRole("button", { name: "Conversation options" }));
  fireEvent.click(
    await screen.findByRole("menuitem", {
      name: i18n.t("sidebarRestore"),
    }),
  );
  view.unmount();
  await act(async () => finish(true));
  expect(list).toHaveBeenCalledOnce();
});

it("reports an empty archived query as bounded when older records remain unscanned", async () => {
  vi.spyOn(WebClient.prototype, "listArchivedSessions").mockResolvedValue({
    ...archivePage([]),
    truncation: {
      ...archivePage([]).truncation,
      truncated: true,
      recordsUnscanned: 12,
    },
  });
  mount(snapshot([]), { query: "missing" });
  fireEvent.click(screen.getByRole("button", { name: "Archived" }));
  await screen.findByText(i18n.t("noMatchingScannedArchives"));
  expect(
    screen.getByText(i18n.t("archiveScanBounded", { count: 12 })),
  ).toBeTruthy();
  expect(screen.queryByText(i18n.t("noMatching"))).toBeNull();
});
