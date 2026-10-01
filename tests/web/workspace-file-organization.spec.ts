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
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  WorkspaceFileEntry,
  WorkspaceTrashEntry,
} from "../../web/protocol/artifacts.ts";
import { FilesPanel } from "../../web/ui/src/features/files/FilesPanel.tsx";
import { i18n } from "../../web/ui/src/i18n.ts";
import { WebApiError, WebClient } from "../../web/ui/src/protocol/client.ts";
import { installCheckVisibilityFixture } from "./check-visibility-fixture.ts";

installCheckVisibilityFixture();
let entries: WorkspaceFileEntry[];
let removed: WorkspaceTrashEntry[];
const node = (sessionPath = "/sessions/one", canWrite = true) =>
  createElement(FilesPanel, {
    sessionId: "s",
    sessionPath,
    cwd: "/workspace",
    active: true,
    canWrite,
  });

beforeEach(() => {
  entries = [
    { name: "one.md", path: "one.md", kind: "file", identity: "one" },
    { name: "two.md", path: "two.md", kind: "file", identity: "two" },
    { name: "folder", path: "folder", kind: "directory", identity: "folder" },
    {
      name: "child.md",
      path: "folder/child.md",
      kind: "file",
      identity: "child",
    },
  ];
  removed = [];
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(900);
  vi.spyOn(WebClient.prototype, "workspaceFiles").mockImplementation(
    async (_id, _session, path) => {
      if (
        path !== "." &&
        !entries.some(
          (entry) => entry.path === path && entry.kind === "directory",
        )
      )
        throw new WebApiError(
          "File no longer exists.",
          404,
          "ARTIFACT_NOT_FOUND",
        );
      return {
        path,
        entries: entries.filter(
          (entry) =>
            (entry.path.split("/").slice(0, -1).join("/") || ".") === path,
        ),
        truncated: false,
      };
    },
  );
  vi.spyOn(WebClient.prototype, "releaseFileListing").mockResolvedValue({});
  vi.spyOn(WebClient.prototype, "workspaceTrash").mockImplementation(
    async (sessionId, sessionPath) => ({
      sessionId,
      sessionPath,
      entries: removed,
    }),
  );
  vi.spyOn(WebClient.prototype, "resolveArtifact").mockImplementation(
    async (_id, reference) => ({ handle: decodeURI(reference) }),
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
        path: `/workspace/${handle}`,
        name: handle.split("/").at(-1)!,
        revision: "a".repeat(64),
        bytes: 20,
        preview: "text",
        editable: true,
      },
      identity: "v1",
      text: "# Original",
      truncated: false,
    }),
  );
  vi.spyOn(WebClient.prototype, "mutateWorkspaceFile").mockImplementation(
    async (sessionId, sessionPath, mutation) => {
      if (mutation.kind === "trash") {
        const source = entries.find((entry) => entry.path === mutation.path)!;
        const trashed: WorkspaceTrashEntry = {
          id: source.path,
          path: source.path,
          kind: source.kind === "directory" ? "directory" : "file",
          identity: source.identity!,
          deletedAt: 1,
        };
        removed.push(trashed);
        entries = entries.filter(
          (entry) =>
            entry.path !== source.path &&
            !entry.path.startsWith(`${source.path}/`),
        );
        return {
          sessionId,
          sessionPath,
          path: source.path,
          kind: trashed.kind,
          trashed,
        };
      }
      if (mutation.kind === "restore") {
        const source = removed.find((entry) => entry.id === mutation.id)!;
        removed = removed.filter((entry) => entry !== source);
        entries.push({
          name: source.path.split("/").at(-1)!,
          path: source.path,
          kind: source.kind,
          identity: source.identity,
        });
        return {
          sessionId,
          sessionPath,
          path: source.path,
          kind: source.kind,
          bytes: 20,
        };
      }
      if (mutation.kind === "move") {
        const source = entries.find((entry) => entry.path === mutation.path)!;
        const path = [
          mutation.directory === "." ? "" : mutation.directory,
          mutation.name,
        ]
          .filter(Boolean)
          .join("/");
        entries = entries.map((entry) =>
          entry === source
            ? { ...entry, path, name: mutation.name }
            : entry.path.startsWith(`${source.path}/`)
              ? {
                  ...entry,
                  path: `${path}${entry.path.slice(source.path.length)}`,
                }
              : entry,
        );
        return {
          sessionId,
          sessionPath,
          path,
          kind: source.kind === "directory" ? "directory" : "file",
          bytes: 20,
          moved: {
            from: `/workspace/${source.path}`,
            to: `/workspace/${path}`,
          },
        };
      }
      return {
        sessionId,
        sessionPath,
        path: [
          mutation.directory === "." ? "" : mutation.directory,
          mutation.name,
        ]
          .filter(Boolean)
          .join("/"),
        kind: mutation.kind === "create-directory" ? "directory" : "file",
        bytes: 20,
      };
    },
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const menu = async (name: string, action: string) => {
  fireEvent.click(
    await screen.findByRole("button", {
      name: i18n.t("filesPathActions", { name }),
    }),
  );
  fireEvent.click(await screen.findByRole("menuitem", { name: action }));
};

it("renames from the row menu, focuses its name and retains an unsaved editor draft at the new canonical path", async () => {
  render(node());
  fireEvent.click(await screen.findByRole("button", { name: "one.md" }));
  await screen.findByRole("heading", { name: "Original" });
  fireEvent.click(screen.getByRole("button", { name: i18n.t("filesEdit") }));
  fireEvent.change(
    await screen.findByRole("textbox", { name: i18n.t("filesEditor") }),
    { target: { value: "# Unsaved draft" } },
  );
  await menu("one.md", i18n.t("filesRename"));
  const input = await screen.findByRole("textbox", {
    name: i18n.t("filesNewName"),
  });
  expect(document.activeElement).toBe(input);
  fireEvent.change(input, { target: { value: "renamed.md" } });
  fireEvent.submit(input.closest("form")!);
  await screen.findByRole("button", { name: "renamed.md" });
  await screen.findByRole("heading", { name: "Unsaved draft" });
  fireEvent.click(screen.getByRole("button", { name: i18n.t("filesEdit") }));
  expect(
    (
      (await screen.findByRole("textbox", {
        name: i18n.t("filesEditor"),
      })) as HTMLTextAreaElement
    ).value,
  ).toBe("# Unsaved draft");
  expect(WebClient.prototype.mutateWorkspaceFile).toHaveBeenCalledWith(
    "s",
    "/sessions/one",
    {
      kind: "move",
      path: "one.md",
      identity: "one",
      directory: ".",
      name: "renamed.md",
    },
  );
});

it("a batch reports each failed and successful item and keeps failed selections for retry", async () => {
  const mutate = vi.mocked(WebClient.prototype.mutateWorkspaceFile);
  const normal = mutate.getMockImplementation()!;
  mutate.mockImplementation(async (...args) => {
    if (args[2].kind === "move" && args[2].path === "one.md")
      throw new WebApiError("destination is occupied", 409, "ARTIFACT_EXISTS");
    return normal(...args);
  });
  render(node());
  await screen.findByRole("button", { name: "one.md" });
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("filesSelectMultiple") }),
  );
  fireEvent.click(
    screen.getByRole("checkbox", {
      name: i18n.t("filesSelectItem", { name: "one.md" }),
    }),
  );
  fireEvent.click(
    screen.getByRole("checkbox", {
      name: i18n.t("filesSelectItem", { name: "two.md" }),
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: i18n.t("filesMove") }));
  fireEvent.change(
    screen.getByRole("textbox", { name: i18n.t("filesMoveDestination") }),
    { target: { value: "folder" } },
  );
  fireEvent.submit(
    screen
      .getByRole("textbox", { name: i18n.t("filesMoveDestination") })
      .closest("form")!,
  );
  const result = await screen.findByRole("list", {
    name: i18n.t("filesOrganizationResults"),
  });
  await waitFor(() =>
    expect(within(result).getAllByRole("listitem")).toHaveLength(2),
  );
  expect(within(result).getByRole("alert").textContent).toBe(
    i18n.t("filesNameExists"),
  );
  expect(within(result).getByText(i18n.t("filesOperationDone"))).toBeTruthy();
  expect(
    (
      screen.getByRole("checkbox", {
        name: i18n.t("filesSelectItem", { name: "one.md" }),
      }) as HTMLInputElement
    ).checked,
  ).toBe(true);
  expect(mutate).toHaveBeenCalledTimes(2);
});

it("selecting a folder and its child removes contents once and offers an immediate undo", async () => {
  render(node());
  fireEvent.click(await screen.findByRole("button", { name: "folder" }));
  await screen.findByRole("button", { name: "child.md" });
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("filesSelectMultiple") }),
  );
  fireEvent.click(
    screen.getByRole("checkbox", {
      name: i18n.t("filesSelectItem", { name: "folder" }),
    }),
  );
  fireEvent.click(
    screen.getByRole("checkbox", {
      name: i18n.t("filesSelectItem", { name: "child.md" }),
    }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("filesTrashAction") }),
  );
  await screen.findByRole("button", { name: i18n.t("filesUndoTrash") });
  expect(WebClient.prototype.mutateWorkspaceFile).toHaveBeenCalledTimes(1);
  expect(WebClient.prototype.mutateWorkspaceFile).toHaveBeenCalledWith(
    "s",
    "/sessions/one",
    { kind: "trash", path: "folder", identity: "folder" },
  );
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "folder" })).toBeNull(),
  );
  expect(screen.queryByText("File no longer exists.")).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("filesUndoTrash") }),
  );
  await waitFor(() =>
    expect(WebClient.prototype.mutateWorkspaceFile).toHaveBeenCalledTimes(2),
  );
  expect(WebClient.prototype.mutateWorkspaceFile).toHaveBeenLastCalledWith(
    "s",
    "/sessions/one",
    { kind: "restore", id: "folder", identity: "folder" },
  );
});

it("renaming an expanded folder follows its selected child and unsaved draft, and creates the next file in the renamed directory", async () => {
  render(node());
  fireEvent.click(await screen.findByRole("button", { name: "folder" }));
  fireEvent.click(await screen.findByRole("button", { name: "child.md" }));
  await screen.findByRole("heading", { name: "Original" });
  fireEvent.click(screen.getByRole("button", { name: i18n.t("filesEdit") }));
  fireEvent.change(
    await screen.findByRole("textbox", { name: i18n.t("filesEditor") }),
    { target: { value: "# Folder draft" } },
  );
  await menu("folder", i18n.t("filesRename"));
  const input = screen.getByRole("textbox", { name: i18n.t("filesNewName") });
  fireEvent.change(input, { target: { value: "renamed-folder" } });
  fireEvent.submit(input.closest("form")!);
  await screen.findByRole("button", { name: "renamed-folder" });
  const child = await screen.findByRole("button", { name: "child.md" });
  expect(child.getAttribute("data-file-row")).toBe("renamed-folder/child.md");
  expect(child.getAttribute("aria-current")).toBe("true");
  expect(screen.queryByText("File no longer exists.")).toBeNull();
  await screen.findByRole("heading", { name: "Folder draft" });
  fireEvent.click(screen.getByRole("button", { name: i18n.t("filesEdit") }));
  expect(
    (
      screen.getByRole("textbox", {
        name: i18n.t("filesEditor"),
      }) as HTMLTextAreaElement
    ).value,
  ).toBe("# Folder draft");
  fireEvent.click(screen.getByRole("button", { name: i18n.t("filesNewFile") }));
  const name = screen.getByRole("textbox", { name: i18n.t("filesFileName") });
  fireEvent.change(name, { target: { value: "next.txt" } });
  fireEvent.submit(name.closest("form")!);
  await waitFor(() =>
    expect(WebClient.prototype.mutateWorkspaceFile).toHaveBeenLastCalledWith(
      "s",
      "/sessions/one",
      { kind: "create-file", directory: "renamed-folder", name: "next.txt" },
    ),
  );
});

it("trash can be reopened after remount, shows unverifiable entries and closes a removed active preview", async () => {
  const view = render(node());
  fireEvent.click(await screen.findByRole("button", { name: "two.md" }));
  await screen.findByRole("heading", { name: "Original" });
  await menu("two.md", i18n.t("filesTrashAction"));
  await waitFor(() =>
    expect(screen.queryByRole("heading", { name: "Original" })).toBeNull(),
  );
  view.unmount();
  vi.mocked(WebClient.prototype.workspaceTrash).mockImplementation(
    async (sessionId, sessionPath) => ({
      sessionId,
      sessionPath,
      entries: removed,
      unavailable: 1,
    }),
  );
  render(node());
  fireEvent.click(
    await screen.findByRole("button", { name: i18n.t("filesTrash") }),
  );
  await screen.findByRole("button", {
    name: i18n.t("filesRestoreItem", { name: "two.md" }),
  });
  expect(screen.getByRole("alert").textContent).toBe(
    i18n.t("filesTrashUnavailable", { count: 1 }),
  );
  fireEvent.click(
    screen.getByRole("button", {
      name: i18n.t("filesRestoreItem", { name: "two.md" }),
    }),
  );
  await screen.findByRole("button", { name: "two.md" });
});

it("folder selection preserves relative paths and the directory picker exposes the browser's folder mode", async () => {
  render(node());
  await screen.findByRole("button", { name: "one.md" });
  const input = screen.getByLabelText(i18n.t("filesImportFolderChoose"));
  expect(input.hasAttribute("webkitdirectory")).toBe(true);
  const first = new File(["first"], "first.txt");
  const second = new File(["second"], "second.txt");
  Object.defineProperty(first, "webkitRelativePath", {
    value: "资料/first.txt",
  });
  Object.defineProperty(second, "webkitRelativePath", {
    value: "资料/子目录/second.txt",
  });
  fireEvent.change(input, { target: { files: [first, second] } });
  await waitFor(() =>
    expect(WebClient.prototype.mutateWorkspaceFile).toHaveBeenCalledTimes(2),
  );
  expect(
    vi
      .mocked(WebClient.prototype.mutateWorkspaceFile)
      .mock.calls.map((call) => call[2]),
  ).toEqual([
    {
      kind: "import-file",
      directory: "资料",
      name: "first.txt",
      data: btoa("first"),
      createParents: true,
    },
    {
      kind: "import-file",
      directory: "资料/子目录",
      name: "second.txt",
      data: btoa("second"),
      createParents: true,
    },
  ]);
});

it("a late mutation from the previous exact Session cannot report success or change the next Session", async () => {
  let finish!: (
    value: Awaited<ReturnType<WebClient["mutateWorkspaceFile"]>>,
  ) => void;
  vi.mocked(WebClient.prototype.mutateWorkspaceFile).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const view = render(node());
  await menu("two.md", i18n.t("filesTrashAction"));
  view.rerender(node("/sessions/copied"));
  await act(async () => {
    finish({
      sessionId: "s",
      sessionPath: "/sessions/one",
      path: "two.md",
      kind: "file",
      trashed: {
        id: "two",
        path: "two.md",
        kind: "file",
        identity: "two",
        deletedAt: 1,
      },
    });
  });
  expect(
    screen.queryByRole("list", { name: i18n.t("filesOrganizationResults") }),
  ).toBeNull();
  expect(
    screen.queryByRole("button", { name: i18n.t("filesUndoTrash") }),
  ).toBeNull();
});

it("dropping a whole folder preserves empty directories and reads every directory batch before importing", async () => {
  const file = new File(["nested original"], "note.txt");
  const leaf = {
    name: "note.txt",
    isFile: true,
    isDirectory: false,
    file: (resolve: (value: File) => void) => resolve(file),
  };
  const folder = (name: string, children: unknown[]) => ({
    name,
    isFile: false,
    isDirectory: true,
    createReader: () => {
      let reads = 0;
      return {
        readEntries: (resolve: (value: unknown[]) => void) =>
          resolve(reads++ === 0 ? children : []),
      };
    },
  });
  const dropped = folder("drop", [
    folder("empty", []),
    folder("nested", [leaf]),
  ]);
  const view = render(node());
  await screen.findByRole("button", { name: "one.md" });
  fireEvent.drop(view.container.querySelector(".files-preview-empty")!, {
    dataTransfer: {
      types: ["Files"],
      items: [{ kind: "file", webkitGetAsEntry: () => dropped }],
      files: [],
    },
  });
  await waitFor(() =>
    expect(WebClient.prototype.mutateWorkspaceFile).toHaveBeenCalledTimes(4),
  );
  expect(
    vi
      .mocked(WebClient.prototype.mutateWorkspaceFile)
      .mock.calls.map((call) => call[2]),
  ).toEqual([
    { kind: "create-directory", directory: ".", name: "drop" },
    { kind: "create-directory", directory: "drop", name: "empty" },
    { kind: "create-directory", directory: "drop", name: "nested" },
    {
      kind: "import-file",
      directory: "drop/nested",
      name: "note.txt",
      data: btoa("nested original"),
      createParents: true,
    },
  ]);
});
