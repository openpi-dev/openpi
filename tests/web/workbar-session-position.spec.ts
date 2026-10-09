// @vitest-environment jsdom
/// <reference types="vitest/jsdom" />

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
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  WebGitReviewFile,
  WebSnapshot,
} from "../../web/protocol/types.ts";
import { App } from "../../web/ui/src/app/App.tsx";
import { Providers } from "../../web/ui/src/app/providers.tsx";
import { i18n } from "../../web/ui/src/i18n.ts";
import {
  loadWorkbarPositions,
  saveWorkbarPositions,
  WORKBAR_POSITION_STORAGE_KEY,
} from "../../web/ui/src/features/workbar/workbar-position-storage.ts";
import { WebClient } from "../../web/ui/src/protocol/client.ts";
import { createWebStore, webStore } from "../../web/ui/src/store/web-store.ts";
import { installCheckVisibilityFixture } from "./check-visibility-fixture.ts";

installCheckVisibilityFixture();
const truncation = {
  bytes: 0,
  maxBytes: 4 * 1024 * 1024,
  messagesTruncated: 0,
  messagePartsOmitted: 0,
  entriesOmitted: 0,
  modelsOmitted: 0,
  sessionsOmitted: 0,
  workspacesOmitted: 0,
  truncated: false,
};
const original = webStore.getState();
const originalViewportWidth = window.innerWidth;

function snapshot(path = "/workspace/a.jsonl", id = "session-a"): WebSnapshot {
  return {
    protocolVersion: 1,
    preferences: { theme: "system" },
    generatedAt: "2026-09-30T12:00:00Z",
    cursor: 1,
    currentSessionId: id,
    currentSessionPath: path,
    workspaces: [{ path: "/workspace", name: "Workspace", current: true }],
    sessions: [],
    models: [],
    runtime: { status: "idle", capabilities: {} },
    truncation,
    selectedSession: {
      id,
      path,
      cwd: "/workspace",
      bytes: 1,
      truncation,
      entries: [
        {
          id: "prompt",
          type: "message",
          timestamp: "2026-09-30T12:00:00Z",
          message: { role: "user", content: "Hello" },
        },
      ],
    },
  };
}

beforeEach(() => {
  // Node 26 defines its own global localStorage; the app must use jsdom's.
  vi.stubGlobal("localStorage", jsdom.window.localStorage);
  // Each test starts without positions remembered by an earlier test.
  localStorage.removeItem(WORKBAR_POSITION_STORAGE_KEY);
  vi.spyOn(original.actions, "start").mockImplementation(() => {});
  vi.spyOn(original.actions, "stop").mockImplementation(() => {});
  vi.spyOn(WebClient.prototype, "pendingQuestions").mockResolvedValue({
    pending: null,
  });
  vi.spyOn(WebClient.prototype, "gitReview").mockResolvedValue({
    ok: false,
    reason: "not_git_repository",
  });
  vi.spyOn(WebClient.prototype, "workspaceFiles").mockResolvedValue({
    path: ".",
    entries: [{ name: "README.md", path: "README.md", kind: "file" }],
    truncated: false,
  });
  vi.spyOn(WebClient.prototype, "releaseFileListing").mockResolvedValue({});
  vi.spyOn(WebClient.prototype, "resolveArtifact").mockImplementation(
    async (_session, reference) => ({ handle: reference }),
  );
  vi.spyOn(WebClient.prototype, "releaseArtifact").mockResolvedValue({});
  vi.spyOn(WebClient.prototype, "artifactMetadata").mockResolvedValue({
    identity: "v1",
  });
  vi.spyOn(WebClient.prototype, "artifactPreview").mockImplementation(
    async (sessionId, handle) => ({
      artifact: {
        sessionId,
        handle,
        name: "README.md",
        path: "/workspace/README.md",
        revision: "a".repeat(64),
        bytes: 20,
        preview: "text",
        editable: true,
      },
      identity: "v1",
      text: "# Read me\n\nWorkspace content",
      truncated: false,
    }),
  );
  const current = snapshot();
  webStore.setState(
    {
      ...createWebStore().getState(),
      actions: original.actions,
      snapshot: current,
      connection: "connected",
      selectedWorkspace: "/workspace",
      selectedPath: current.selectedSession!.path,
    },
    true,
  );
});

afterEach(() => {
  cleanup();
  webStore.setState(original, true);
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: originalViewportWidth,
  });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function select(path: string, id = "session-a") {
  await act(async () =>
    webStore.setState({
      snapshot: snapshot(path, id),
      selectedPath: path,
      sessionSwitching: false,
    }),
  );
}

async function open(tool: "files" | "browser" | "review") {
  const workbar = document.querySelector<HTMLElement>(".workbar-panel");
  fireEvent.click(
    workbar && !workbar.hidden
      ? within(workbar).getByRole("button", {
          name: i18n.t("openTools"),
        })
      : screen.getAllByRole("button", {
          name: i18n.t("openTools"),
        })[0]!,
  );
  fireEvent.click(
    within(screen.getByRole("region", { name: i18n.t("openTools") })).getByRole(
      "button",
      {
        name: new RegExp(
          `^${i18n.t(tool === "review" ? "changeEvidence" : tool)}`,
        ),
      },
    ),
  );
}

it("restores a comparison source, filter and reading position after reloading the selected diff for the exact Session", async () => {
  const file: WebGitReviewFile = {
    path: "src/example.ts",
    status: "modified",
    additions: 1,
    deletions: 1,
    diffTruncated: false,
    diffLoaded: true,
    diff: "@@ -1 +1 @@\n-old\n+new\n",
  };
  let resolveRestoredFile!: (file: WebGitReviewFile) => void;
  let restoring = false;
  vi.mocked(WebClient.prototype.gitReview).mockImplementation(
    async (_session, path, _signal, options) => {
      const files =
        options?.file && restoring
          ? [
              await new Promise<WebGitReviewFile>((resolve) => {
                resolveRestoredFile = resolve;
              }),
            ]
          : [
              restoring && path === "/workspace/a.jsonl"
                ? { ...file, diffLoaded: false, diff: "" }
                : file,
            ];
      return {
        ok: true,
        ...(options?.file ? { summaryRevision: options.revision } : {}),
        snapshot: {
          repositoryRoot: "/workspace",
          currentBranch: "main",
          baseBranch: null,
          comparison: options?.source ?? "unstaged",
          revision: "a".repeat(64),
          additions: 1,
          deletions: 1,
          truncated: false,
          files,
        },
      };
    },
  );
  const view = render(createElement(Providers, null, createElement(App)));
  await open("review");
  const scope = () =>
    within(view.container.querySelector<HTMLElement>(".workbar-panel")!);
  fireEvent.change(scope().getByRole("combobox"), {
    target: { value: "staged" },
  });
  await waitFor(() =>
    expect(
      vi.mocked(WebClient.prototype.gitReview).mock.calls.at(-1)?.[3]?.source,
    ).toBe("staged"),
  );
  fireEvent.change(scope().getByRole("searchbox"), {
    target: { value: "example" },
  });
  fireEvent.click(await scope().findByRole("button", { name: /example\.ts/u }));
  await scope().findByRole("figure");
  const preview = view.container.querySelector<HTMLElement>(
    ".review-file-preview",
  )!;
  preview.scrollTop = 135;
  fireEvent.scroll(preview);
  await select("/workspace/b.jsonl", "session-b");
  await open("review");
  fireEvent.change(scope().getByRole("combobox"), {
    target: { value: "branch" },
  });
  await waitFor(() =>
    expect(
      vi.mocked(WebClient.prototype.gitReview).mock.calls.at(-1)?.[3]?.source,
    ).toBe("branch"),
  );
  restoring = true;
  await select("/workspace/a.jsonl");
  await waitFor(() => expect(resolveRestoredFile).toBeTypeOf("function"));
  expect(scope().queryByRole("figure")).toBeNull();
  await act(async () => resolveRestoredFile(file));
  await scope().findByRole("figure");
  expect(scope().getByRole<HTMLSelectElement>("combobox").value).toBe("staged");
  expect(
    view.container.querySelector<HTMLElement>(".review-file-preview")!
      .scrollTop,
  ).toBe(135);
  fireEvent.click(
    scope().getByRole("button", { name: i18n.t("gitReviewBackToFiles") }),
  );
  expect(scope().getByRole<HTMLInputElement>("searchbox").value).toBe(
    "example",
  );
});

it("quotes an exact deleted line through the workbar into the existing chat draft without sending it", async () => {
  const current = snapshot("/workspace/feedback.jsonl", "session-feedback");
  webStore.setState({
    snapshot: current,
    selectedPath: current.selectedSession!.path,
  });
  const send = vi
    .spyOn(original.actions, "sendPrompt")
    .mockResolvedValue(false);
  vi.mocked(WebClient.prototype.gitReview).mockResolvedValue({
    ok: true,
    snapshot: {
      repositoryRoot: "/workspace",
      currentBranch: "main",
      baseBranch: null,
      comparison: "unstaged",
      revision: "a".repeat(64),
      additions: 1,
      deletions: 1,
      truncated: false,
      files: [
        {
          path: "src/example.ts",
          status: "modified",
          additions: 1,
          deletions: 1,
          diffTruncated: false,
          diff: "@@ -10 +10 @@\n-old exact text\n+new text\n",
        },
      ],
    },
  });
  const view = render(createElement(Providers, null, createElement(App)));
  const composer =
    view.container.querySelector<HTMLTextAreaElement>(".composer textarea")!;
  fireEvent.change(composer, { target: { value: "Please reconsider this." } });
  await open("review");
  fireEvent.click(await screen.findByRole("button", { name: /example\.ts/u }));
  fireEvent.click(
    screen.getByRole("button", {
      name: i18n.t("reviewSelectOldLine", { line: 10 }),
    }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("reviewQuoteLine") }),
  );
  await waitFor(() => expect(document.activeElement).toBe(composer));
  expect(view.container.querySelector(".composer textarea")).toBe(composer);
  expect(composer.value).toContain("Please reconsider this.\n\n");
  expect(composer.value).toContain(
    i18n.t("sourceFeedbackOld", {
      path: "src/example.ts",
      line: 10,
    }),
  );
  expect(composer.value).toContain("> old exact text");
  expect(composer.selectionStart).toBe(composer.value.length);
  expect(send).not.toHaveBeenCalled();
});

it("keeps one composer and its draft through focused tools and Back to chat", async () => {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 1600,
  });
  const current = snapshot("/workspace/focused.jsonl", "session-focused");
  webStore.setState({
    snapshot: current,
    selectedPath: current.selectedSession!.path,
  });
  vi.mocked(WebClient.prototype.gitReview).mockResolvedValue({
    ok: true,
    snapshot: {
      repositoryRoot: "/workspace",
      currentBranch: "main",
      baseBranch: null,
      comparison: "unstaged",
      revision: "a".repeat(64),
      additions: 0,
      deletions: 0,
      truncated: false,
      files: [],
    },
  });
  const view = render(createElement(Providers, null, createElement(App)));
  const composer =
    view.container.querySelector<HTMLTextAreaElement>(".composer textarea")!;
  fireEvent.change(composer, { target: { value: "Draft beside my work" } });
  await open("review");
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("gitReviewExpand") }),
  );
  expect(
    view.container
      .querySelector(".app-shell")
      ?.classList.contains("center-collapsed"),
  ).toBe(true);
  expect(view.container.querySelector(".composer textarea")).toBe(composer);
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("workbarBackToChat") }),
  );
  await waitFor(() => expect(document.activeElement).toBe(composer));
  expect(
    view.container
      .querySelector(".app-shell")
      ?.classList.contains("center-collapsed"),
  ).toBe(false);
  expect(composer.value).toBe("Draft beside my work");
  expect(view.container.querySelectorAll(".composer")).toHaveLength(1);
});

it("hydrates saved widths, clamps small windows without saving, and saves explicit keyboard resizing once", async () => {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 1600,
  });
  const current = snapshot();
  current.preferences = {
    theme: "system",
    sidebarWidth: 400,
    auxiliaryWidth: 620,
  };
  webStore.setState({ snapshot: current });
  const save = vi
    .spyOn(original.actions, "savePreferences")
    .mockImplementation(async (patch) => {
      webStore.setState({
        snapshot: {
          ...current,
          preferences: { ...current.preferences, ...patch },
        },
      });
    });
  const view = render(createElement(Providers, null, createElement(App)));
  const shell = view.container.querySelector<HTMLElement>(".app-shell")!;
  expect(shell.style.getPropertyValue("--sidebar-width")).toBe("400px");
  expect(shell.style.getPropertyValue("--auxiliary-width")).toBe("620px");
  await act(async () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 900,
    });
    window.dispatchEvent(new Event("resize"));
  });
  expect(save).not.toHaveBeenCalled();
  await act(async () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1600,
    });
    window.dispatchEvent(new Event("resize"));
  });
  expect(shell.style.getPropertyValue("--sidebar-width")).toBe("400px");
  await open("browser");
  fireEvent.keyDown(
    screen.getByRole("separator", { name: i18n.t("resizeSidebar") }),
    { key: "ArrowLeft" },
  );
  fireEvent.keyDown(
    screen.getByRole("separator", { name: i18n.t("resizeWorkbar") }),
    { key: "ArrowRight" },
  );
  await waitFor(() =>
    expect(save).toHaveBeenCalledExactlyOnceWith({
      sidebarWidth: 384,
      auxiliaryWidth: 604,
    }),
  );
  view.unmount();
  const reloaded = render(createElement(Providers, null, createElement(App)));
  const reloadedShell =
    reloaded.container.querySelector<HTMLElement>(".app-shell")!;
  expect(reloadedShell.style.getPropertyValue("--sidebar-width")).toBe("384px");
  expect(reloadedShell.style.getPropertyValue("--auxiliary-width")).toBe(
    "604px",
  );
  expect(save).toHaveBeenCalledOnce();
});

it("bounds remembered tools to 32 exact Session identities while keeping a recently revisited position", async () => {
  const view = render(createElement(Providers, null, createElement(App)));
  await open("browser");
  fireEvent.change(
    screen.getByRole("textbox", { name: i18n.t("browserAddress") }),
    {
      target: { value: "https://example.com/remembered" },
    },
  );
  // Fill the remaining 31 slots through the persisted position store rather
  // than 31 full UI round-trips, so the bound is not limited by render speed.
  view.unmount();
  saveWorkbarPositions([
    ...loadWorkbarPositions(),
    ...Array.from({ length: 31 }, (_, offset) => ({
      sessionId: `cache-${offset + 1}`,
      sessionPath: `/workspace/cache-${offset + 1}.jsonl`,
      tool: "browser" as const,
      requestRevision: 1,
      open: true,
      reading: {},
    })),
  ]);
  expect(loadWorkbarPositions().map((position) => position.sessionId)).toEqual([
    "session-a",
    ...Array.from({ length: 31 }, (_, offset) => `cache-${offset + 1}`),
  ]);
  webStore.setState({
    snapshot: snapshot("/workspace/cache-31.jsonl", "cache-31"),
    selectedPath: "/workspace/cache-31.jsonl",
  });
  const reloaded = render(createElement(Providers, null, createElement(App)));
  await select("/workspace/a.jsonl");
  expect(
    screen.getByRole<HTMLInputElement>("textbox", {
      name: i18n.t("browserAddress"),
    }).value,
  ).toBe("https://example.com/remembered");
  await select("/workspace/cache-32.jsonl", "cache-32");
  await open("browser");
  await select("/workspace/cache-1.jsonl", "cache-1");
  expect(reloaded.container.querySelector(".workbar-panel")).toBeNull();
  await select("/workspace/cache-2.jsonl", "cache-2");
  expect(reloaded.container.querySelector(".workbar-panel")).not.toBeNull();
  await select("/workspace/a.jsonl");
  expect(
    screen.getByRole<HTMLInputElement>("textbox", {
      name: i18n.t("browserAddress"),
    }).value,
  ).toBe("https://example.com/remembered");
  await select("/workspace/a.jsonl", "replacement-session");
  expect(reloaded.container.querySelector(".workbar-panel")).toBeNull();
}, 20_000);

it("reattaches a Session's file position after a copied same-ID Session, releasing the old preview", async () => {
  const view = render(createElement(Providers, null, createElement(App)));
  await open("files");
  fireEvent.click(await screen.findByRole("button", { name: "README.md" }));
  await screen.findByRole("heading", { name: "Read me" });
  const tree = view.container.querySelector<HTMLElement>(".file-tree")!;
  const preview = view.container.querySelector<HTMLElement>(
    ".artifact-panel-body",
  )!;
  tree.scrollTop = 84;
  preview.scrollTop = 175;
  fireEvent.scroll(tree);
  fireEvent.scroll(preview);
  fireEvent.change(
    screen.getByRole("textbox", { name: i18n.t("filesSearch") }),
    { target: { value: "README" } },
  );
  await select("/workspace/copy.jsonl");
  expect(view.container.querySelector(".workbar-panel")).toBeNull();
  expect(vi.mocked(WebClient.prototype.releaseArtifact)).toHaveBeenCalledWith(
    "session-a",
    "README.md",
  );
  await open("browser");
  expect(
    screen.getByRole<HTMLInputElement>("textbox", {
      name: i18n.t("browserAddress"),
    }).value,
  ).toBe("");
  await select("/workspace/a.jsonl");
  await screen.findByRole("heading", { name: "Read me" });
  expect(view.container.querySelectorAll(".workbar-panel")).toHaveLength(1);
  expect(
    screen.getByRole<HTMLInputElement>("textbox", {
      name: i18n.t("filesSearch"),
    }).value,
  ).toBe("README");
  await waitFor(() =>
    expect(
      view.container.querySelector<HTMLElement>(".file-tree")!.scrollTop,
    ).toBe(84),
  );
  expect(
    view.container.querySelector<HTMLElement>(".artifact-panel-body")!
      .scrollTop,
  ).toBe(175);
  expect(
    vi.mocked(WebClient.prototype.resolveArtifact),
  ).toHaveBeenLastCalledWith(
    "session-a",
    "/workspace/README.md",
    undefined,
    expect.any(AbortSignal),
  );
});

it("preserves browser address and tabs through detachment without retaining live iframe DOM", async () => {
  const view = render(createElement(Providers, null, createElement(App)));
  await open("browser");
  const address = screen.getByRole<HTMLInputElement>("textbox", {
    name: i18n.t("browserAddress"),
  });
  fireEvent.change(address, { target: { value: "https://example.com/first" } });
  fireEvent.submit(address.closest("form")!);
  const frame = view.container.querySelector("iframe")!;
  const pageDocument = frame.contentDocument!;
  const html =
    pageDocument.documentElement ??
    pageDocument.appendChild(pageDocument.createElement("html"));
  const pageInput = pageDocument.createElement("input");
  html.appendChild(pageInput);
  pageInput.value = "Unsubmitted page form";
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("browserAddTab") }),
  );
  fireEvent.change(
    screen.getByRole("textbox", { name: i18n.t("browserAddress") }),
    { target: { value: "https://example.com/unsent" } },
  );
  expect(frame.isConnected).toBe(true);
  fireEvent.click(screen.getByRole("tab", { name: "example.com" }));
  expect(
    view.container.querySelector(".browser-page:not([hidden]) iframe"),
  ).toBe(frame);
  expect(frame.contentDocument?.querySelector("input")?.value).toBe(
    "Unsubmitted page form",
  );
  fireEvent.click(screen.getByRole("tab", { name: i18n.t("browserNewTab") }));
  await select("/workspace/b.jsonl", "session-b");
  expect(frame.isConnected).toBe(false);
  expect(view.container.querySelector("iframe")).toBeNull();
  await select("/workspace/a.jsonl");
  expect(view.container.querySelectorAll(".browser-tab")).toHaveLength(2);
  expect(
    screen.getByRole<HTMLInputElement>("textbox", {
      name: i18n.t("browserAddress"),
    }).value,
  ).toBe("https://example.com/unsent");
  expect(
    view.container.querySelector(".browser-page:not([hidden]) iframe"),
  ).toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: "example.com" }));
  expect(view.container.querySelector("iframe")?.getAttribute("src")).toBe(
    "https://example.com/first",
  );
});

it("keeps a resized width when save completes with a stale refreshed snapshot", async () => {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 1600,
  });
  const current = snapshot();
  current.preferences = {
    theme: "system",
    sidebarWidth: 296,
    auxiliaryWidth: 520,
  };
  webStore.setState({ snapshot: current });
  const save = vi
    .spyOn(original.actions, "savePreferences")
    .mockImplementation(async () => {
      // A refresh already in flight can still return the earlier saved width.
      webStore.setState({ snapshot: { ...current } });
    });
  const view = render(createElement(Providers, null, createElement(App)));
  const shell = view.container.querySelector<HTMLElement>(".app-shell")!;
  fireEvent.keyDown(
    screen.getByRole("separator", { name: i18n.t("resizeSidebar") }),
    { key: "Enter" },
  );
  expect(shell.style.getPropertyValue("--sidebar-width")).toBe("280px");
  await waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(shell.style.getPropertyValue("--sidebar-width")).toBe("280px");
});

it("keeps the latest operator width when later snapshots contain an older saved choice", async () => {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 1600,
  });
  const current = snapshot();
  current.preferences = {
    theme: "system",
    sidebarWidth: 280,
    auxiliaryWidth: 520,
  };
  webStore.setState({ snapshot: current });
  const save = vi
    .spyOn(original.actions, "savePreferences")
    .mockImplementation(async (patch) => {
      webStore.setState({
        snapshot: {
          ...current,
          preferences: { ...current.preferences, ...patch },
        },
      });
    });
  const view = render(createElement(Providers, null, createElement(App)));
  const shell = view.container.querySelector<HTMLElement>(".app-shell")!;
  const handle = screen.getByRole("separator", {
    name: i18n.t("resizeSidebar"),
  });
  fireEvent.keyDown(handle, { key: "ArrowRight" });
  await waitFor(() =>
    expect(save).toHaveBeenCalledExactlyOnceWith({
      sidebarWidth: 296,
      auxiliaryWidth: 520,
    }),
  );
  fireEvent.keyDown(handle, { key: "Enter" });
  await waitFor(() =>
    expect(save).toHaveBeenLastCalledWith({
      sidebarWidth: 280,
      auxiliaryWidth: 520,
    }),
  );
  await act(async () => {
    webStore.setState({
      snapshot: {
        ...current,
        cursor: 3,
        preferences: { ...current.preferences, sidebarWidth: 296 },
      },
    });
  });
  expect(shell.style.getPropertyValue("--sidebar-width")).toBe("280px");
  expect(save).toHaveBeenCalledTimes(2);
});
