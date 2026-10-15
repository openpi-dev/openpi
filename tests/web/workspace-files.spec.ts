// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FilesPanel } from "../../web/ui/src/features/files/FilesPanel.tsx";
import { i18n } from "../../web/ui/src/i18n.ts";
import { WebClient } from "../../web/ui/src/protocol/client.ts";
import { installCheckVisibilityFixture } from "./check-visibility-fixture.ts";

installCheckVisibilityFixture();

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(900);
  vi.spyOn(WebClient.prototype, "workspaceFiles").mockResolvedValue({
    path: ".",
    entries: [{ name: "report.md", path: "report.md", kind: "file" }],
    truncated: false,
  });
  vi.spyOn(WebClient.prototype, "releaseFileListing").mockResolvedValue({});
  vi.spyOn(WebClient.prototype, "resolveArtifact").mockImplementation(
    async (_id, reference) => ({ handle: reference }),
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
        name: handle,
        path: `/workspace/${handle}`,
        revision: "a".repeat(64),
        bytes: 100,
        preview: "text",
      },
      identity: "v1",
      text:
        handle === "report.md"
          ? "# Report\n[Next](next.md)"
          : "# Next document",
      truncated: false,
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const node = (sessionPath = "/session/a", active = true) =>
  createElement(FilesPanel, {
    key: sessionPath,
    sessionId: "s",
    sessionPath,
    cwd: "/workspace",
    active,
  });

it("keeps the explorer mounted beside nested previews and returns focus without opening another panel", async () => {
  const view = render(node());
  const opener = await screen.findByRole("button", { name: "report.md" });
  const tree = view.container.querySelector<HTMLElement>(".file-tree")!;
  tree.scrollTop = 80;
  opener.focus();
  fireEvent.click(opener);
  await screen.findByRole("heading", { name: "Report" });
  expect(opener.isConnected).toBe(true);
  expect(opener.getAttribute("aria-current")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  await screen.findByRole("heading", { name: "Next document" });
  expect(view.container.querySelectorAll(".artifact-panel")).toHaveLength(1);
  expect(
    view.container.querySelector(".artifact-panel-embedded"),
  ).not.toBeNull();
  fireEvent.click(screen.getByRole("button", { name: i18n.t("closePreview") }));
  await waitFor(() => expect(document.activeElement).toBe(opener));
  expect(tree.scrollTop).toBe(80);
  expect(view.container.querySelector(".artifact-panel")).toBeNull();
});

it("appends directory pages and aborts stale search reads while preserving loaded entries", async () => {
  const list = vi.mocked(WebClient.prototype.workspaceFiles);
  list.mockResolvedValueOnce({
    path: ".",
    entries: [{ name: "first.txt", path: "first.txt", kind: "file" }],
    truncated: false,
    nextCursor: "page-2",
  });
  const view = render(node());
  await screen.findByRole("button", { name: "first.txt" });
  list.mockResolvedValueOnce({
    path: ".",
    entries: [{ name: "earlier.txt", path: "earlier.txt", kind: "file" }],
    truncated: false,
  });
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("filesLoadMore") }),
  );
  await screen.findByRole("button", { name: "earlier.txt" });
  expect(screen.getByRole("button", { name: "first.txt" })).toBeTruthy();
  expect(
    [...view.container.querySelectorAll("[data-file-row]")].map(
      (row) => row.textContent,
    ),
  ).toEqual(["first.txt", "earlier.txt"]);
  expect(list.mock.calls[1]?.[5]).toBe("page-2");
  let finish:
    | ((value: Awaited<ReturnType<WebClient["workspaceFiles"]>>) => void)
    | undefined;
  list.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  fireEvent.change(
    screen.getByRole("textbox", { name: i18n.t("filesSearch") }),
    { target: { value: "old" } },
  );
  await waitFor(() => expect(finish).toBeDefined());
  const staleSignal = list.mock.calls.at(-1)![4];
  fireEvent.change(
    screen.getByRole("textbox", { name: i18n.t("filesSearch") }),
    { target: { value: "new" } },
  );
  expect(staleSignal.aborted).toBe(true);
  await act(async () =>
    finish?.({
      path: ".",
      entries: [{ name: "stale.txt", path: "stale.txt", kind: "file" }],
      truncated: false,
    }),
  );
  expect(screen.queryByRole("button", { name: "stale.txt" })).toBeNull();
});

it("retains loaded search pages across hiding and restores a readable root after an expanded folder disappears", async () => {
  const list = vi.mocked(WebClient.prototype.workspaceFiles);
  const view = render(node());
  await screen.findByRole("button", { name: "report.md" });
  const search = screen.getByRole("textbox", { name: i18n.t("filesSearch") });
  const first = {
    path: ".",
    entries: [{ name: "first.txt", path: "first.txt", kind: "file" as const }],
    truncated: false,
    nextCursor: "next",
  };
  const second = {
    path: ".",
    entries: [
      { name: "second.txt", path: "second.txt", kind: "file" as const },
    ],
    truncated: false,
  };
  list.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
  fireEvent.change(search, { target: { value: "txt" } });
  await waitFor(() =>
    expect(
      view.container.querySelector('[data-file-row="first.txt"]'),
    ).not.toBeNull(),
  );
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("filesLoadMore") }),
  );
  await waitFor(() =>
    expect(
      view.container.querySelector('[data-file-row="second.txt"]'),
    ).not.toBeNull(),
  );
  view.rerender(node("/session/a", false));
  list.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
  view.rerender(node());
  expect(
    view.container.querySelector('[data-file-row="second.txt"]'),
  ).not.toBeNull();
  await waitFor(() => expect(list).toHaveBeenCalledTimes(5));
  await waitFor(() =>
    expect(
      view.container.querySelector(".file-tree")?.getAttribute("aria-busy"),
    ).toBe("false"),
  );
  expect(list.mock.calls.at(-1)?.[5]).toBe("next");
  list.mockResolvedValueOnce({
    path: ".",
    entries: [{ name: "folder", path: "folder", kind: "directory" }],
    truncated: false,
  });
  fireEvent.change(search, { target: { value: "" } });
  const folder = await screen.findByRole("button", { name: "folder" });
  list
    .mockResolvedValueOnce({
      path: ".",
      entries: [{ name: "new.txt", path: "new.txt", kind: "file" }],
      truncated: false,
    })
    .mockRejectedValueOnce(new Error("Folder removed"));
  fireEvent.click(folder);
  await screen.findByRole("button", { name: "new.txt" });
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Folder removed",
  );
});

it("invalidates the preview on exact Session path changes and pauses hidden reads", async () => {
  const view = render(node());
  fireEvent.click(await screen.findByRole("button", { name: "report.md" }));
  await screen.findByRole("heading", { name: "Report" });
  view.rerender(node("/session/copied"));
  expect(screen.queryByRole("heading", { name: "Report" })).toBeNull();
  await waitFor(() =>
    expect(WebClient.prototype.releaseArtifact).toHaveBeenCalled(),
  );
  await screen.findByRole("button", { name: "report.md" });
  const calls = vi.mocked(WebClient.prototype.workspaceFiles).mock.calls.length;
  view.rerender(node("/session/copied", false));
  fireEvent.focus(window);
  await act(async () => {});
  expect(WebClient.prototype.workspaceFiles).toHaveBeenCalledTimes(calls);
});

it("continues text only at the original revision and keeps the same scroll container", async () => {
  const read = vi.mocked(WebClient.prototype.artifactPreview);
  const base = {
    artifact: {
      sessionId: "s",
      handle: "report.md",
      name: "report.md",
      path: "/workspace/report.md",
      revision: "a".repeat(64),
      bytes: 100,
      preview: "text" as const,
    },
    identity: "v1",
    text: "# First",
    truncated: true,
    nextOffset: 7,
  };
  read.mockResolvedValueOnce(base);
  const view = render(node());
  fireEvent.click(await screen.findByRole("button", { name: "report.md" }));
  await screen.findByRole("heading", { name: "First" });
  const body = view.container.querySelector<HTMLElement>(
    ".artifact-panel-body",
  )!;
  body.scrollTop = 42;
  read.mockResolvedValueOnce({
    ...base,
    text: "\n\nSecond page",
    truncated: false,
    nextOffset: undefined,
  });
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("filesReadMore") }),
  );
  await screen.findByText("Second page");
  expect(screen.getByRole("heading", { name: "First" })).toBeTruthy();
  expect(body.scrollTop).toBe(42);
  expect(read.mock.calls[1]?.[3]).toEqual({
    offset: 7,
    revision: base.artifact.revision,
  });
});
