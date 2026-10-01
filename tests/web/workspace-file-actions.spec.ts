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
  WorkspaceFileMutationResult,
} from "../../web/protocol/artifacts.ts";
import { WEB_PROMPT_FILE_MAX_BYTES } from "../../web/protocol/prompt-files.ts";
import { FilesPanel } from "../../web/ui/src/features/files/FilesPanel.tsx";
import { i18n } from "../../web/ui/src/i18n.ts";
import { copyText } from "../../web/ui/src/lib/clipboard.ts";
import { WebApiError, WebClient } from "../../web/ui/src/protocol/client.ts";
import { installCheckVisibilityFixture } from "./check-visibility-fixture.ts";

vi.mock("../../web/ui/src/lib/clipboard.ts", () => ({
  copyText: vi.fn().mockResolvedValue(true),
}));
installCheckVisibilityFixture();
let entries: WorkspaceFileEntry[];

beforeEach(() => {
  entries = [
    { name: "report.md", path: "report.md", kind: "file" },
    { name: "src", path: "src", kind: "directory" },
  ];
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(900);
  vi.spyOn(WebClient.prototype, "workspaceFiles").mockImplementation(
    async (_id, _session, path) => ({
      path,
      entries: entries.filter(
        (entry) =>
          (entry.path.includes("/")
            ? entry.path.slice(0, entry.path.lastIndexOf("/"))
            : ".") === path,
      ),
      truncated: false,
    }),
  );
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
        bytes: 0,
        preview: "text",
        editable: true,
      },
      identity: "v1",
      text: "",
      truncated: false,
    }),
  );
  vi.spyOn(WebClient.prototype, "mutateWorkspaceFile").mockImplementation(
    async (sessionId, sessionPath, mutation) => {
      const path =
        mutation.directory === "."
          ? mutation.name
          : `${mutation.directory}/${mutation.name}`;
      if (entries.some((entry) => entry.path === path))
        throw new WebApiError("exists", 409, "ARTIFACT_EXISTS");
      const kind = mutation.kind === "create-directory" ? "directory" : "file";
      entries.push({ name: mutation.name, path, kind });
      return {
        sessionId,
        sessionPath,
        path,
        kind,
        bytes: mutation.kind === "import-file" ? atob(mutation.data).length : 0,
      };
    },
  );
  vi.mocked(copyText).mockClear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const node = (
  sessionPath = "/session/a",
  canWrite = true,
  cwd = "/workspace",
) =>
  createElement(FilesPanel, {
    key: sessionPath,
    sessionId: "same-id",
    sessionPath,
    cwd,
    active: true,
    canWrite,
  });
const upload = (container: HTMLElement, files: File[]) =>
  fireEvent.change(
    container.querySelector<HTMLInputElement>('input[type="file"]')!,
    { target: { files } },
  );
const droppedFile = (file: File) => ({
  types: ["Files"],
  files: [file],
  items: [{ kind: "file", getAsFile: () => file }],
});
const dropFile = (target: Element, file: File) =>
  fireEvent.drop(target, { dataTransfer: droppedFile(file) });

it.each(["empty", "preview", "hidden", "explorer"] as const)(
  "imports exact file bytes once from the %s canvas area and reveals import feedback",
  async (area) => {
    const view = render(node());
    const report = await screen.findByRole("button", { name: "report.md" });
    if (area === "preview" || area === "hidden") {
      fireEvent.click(report);
      await waitFor(() =>
        expect(
          view.container.querySelector(".artifact-panel-body"),
        ).toBeTruthy(),
      );
    }
    if (area === "hidden")
      fireEvent.click(
        screen.getByRole("button", { name: i18n.t("filesHideTree") }),
      );
    const target = view.container.querySelector(
      area === "empty"
        ? ".files-preview-empty"
        : area === "explorer"
          ? ".file-explorer"
          : ".artifact-panel-body",
    )!;
    const file = new File([new Uint8Array([0, 255, 42])], `${area}.bin`);
    expect(
      fireEvent.dragOver(target, { dataTransfer: droppedFile(file) }),
    ).toBe(false);
    expect(
      view.container
        .querySelector(".file-explorer")
        ?.hasAttribute("data-drag-over"),
    ).toBe(true);
    expect(dropFile(target, file)).toBe(false);
    await screen.findByText(i18n.t("filesImported"));
    expect(
      WebClient.prototype.mutateWorkspaceFile,
    ).toHaveBeenCalledExactlyOnceWith("same-id", "/session/a", {
      kind: "import-file",
      directory: ".",
      name: file.name,
      data: "AP8q",
    });
    expect(
      view.container.querySelector(".files-tree-container"),
    ).toHaveProperty("hidden", false);
    expect(
      view.container
        .querySelector(".file-explorer")
        ?.hasAttribute("data-drag-over"),
    ).toBe(false);
  },
);

it("leaves ordinary text drag in the artifact editor to native editing", async () => {
  render(node());
  fireEvent.click(await screen.findByRole("button", { name: "report.md" }));
  fireEvent.click(
    await screen.findByRole("button", { name: i18n.t("filesEdit") }),
  );
  const editor = await screen.findByRole("textbox", {
    name: i18n.t("filesEditor"),
  });
  fireEvent.change(editor, { target: { value: "unsaved draft" } });
  const transfer = {
    types: ["text/plain"],
    files: [],
    items: [],
    getData: () => "text",
  };
  expect(fireEvent.dragOver(editor, { dataTransfer: transfer })).toBe(true);
  expect(fireEvent.drop(editor, { dataTransfer: transfer })).toBe(true);
  expect(editor).toHaveProperty("value", "unsaved draft");
  expect(WebClient.prototype.mutateWorkspaceFile).not.toHaveBeenCalled();
});

it("uses the selected directory for a later canvas drop instead of the listener's initial directory", async () => {
  const view = render(node());
  fireEvent.click(await screen.findByRole("button", { name: "src" }));
  dropFile(
    view.container.querySelector(".files-preview-empty")!,
    new File(["file"], "nested.txt"),
  );
  await screen.findByText(i18n.t("filesImported"));
  expect(
    WebClient.prototype.mutateWorkspaceFile,
  ).toHaveBeenCalledExactlyOnceWith("same-id", "/session/a", {
    kind: "import-file",
    directory: "src",
    name: "nested.txt",
    data: "ZmlsZQ==",
  });
});

it.each(["session", "workspace"] as const)(
  "does not apply a delayed preview-drop result after the native %s changes",
  async (change) => {
    let finish!: (result: WorkspaceFileMutationResult) => void;
    vi.mocked(WebClient.prototype.mutateWorkspaceFile).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const view = render(node());
    await screen.findByRole("button", { name: "src" });
    dropFile(
      view.container.querySelector(".files-preview-empty")!,
      new File(["original"], "old-drop.txt"),
    );
    await waitFor(() =>
      expect(WebClient.prototype.mutateWorkspaceFile).toHaveBeenCalledTimes(1),
    );
    view.rerender(
      change === "session"
        ? node("/session/b")
        : node("/session/a", true, "/other-workspace"),
    );
    await act(async () =>
      finish({
        sessionId: "same-id",
        sessionPath: "/session/a",
        path: "old-drop.txt",
        kind: "file",
        bytes: 8,
      }),
    );
    expect(WebClient.prototype.resolveArtifact).not.toHaveBeenCalled();
    expect(screen.queryByText(i18n.t("filesImported"))).toBeNull();
    expect(screen.queryByText("old-drop.txt")).toBeNull();
  },
);

it("cancels a dropped file read when the owning native Session changes before upload", async () => {
  const read = vi
    .spyOn(FileReader.prototype, "readAsDataURL")
    .mockImplementation(() => {});
  const abort = vi.spyOn(FileReader.prototype, "abort");
  const view = render(node());
  await screen.findByRole("button", { name: "src" });
  dropFile(
    view.container.querySelector(".files-preview-empty")!,
    new File(["original"], "cancel-read.txt"),
  );
  await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
  view.rerender(node("/session/b"));
  await waitFor(() => expect(abort).toHaveBeenCalledTimes(1));
  expect(WebClient.prototype.mutateWorkspaceFile).not.toHaveBeenCalled();
  expect(screen.queryByText("cancel-read.txt")).toBeNull();
});

it("creates in the selected directory, opens the file and returns keyboard focus to its row", async () => {
  render(node());
  fireEvent.click(await screen.findByRole("button", { name: "src" }));
  fireEvent.click(screen.getByRole("button", { name: i18n.t("filesNewFile") }));
  const field = screen.getByRole("textbox", { name: i18n.t("filesFileName") });
  expect(document.activeElement).toBe(field);
  fireEvent.change(field, { target: { value: "新文件.md" } });
  fireEvent.click(screen.getByRole("button", { name: i18n.t("filesCreate") }));
  const row = await screen.findByRole("button", { name: "新文件.md" });
  expect(WebClient.prototype.mutateWorkspaceFile).toHaveBeenCalledWith(
    "same-id",
    "/session/a",
    { kind: "create-file", directory: "src", name: "新文件.md" },
  );
  await waitFor(() => expect(document.activeElement).toBe(row));
  expect(WebClient.prototype.resolveArtifact).toHaveBeenCalledWith(
    "same-id",
    encodeURI("src/新文件.md"),
    undefined,
    expect.any(AbortSignal),
  );
});

it("creates a directory and rejects same-name and path inputs without discarding the name", async () => {
  render(node());
  await screen.findByRole("button", { name: "src" });
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("filesNewDirectory") }),
  );
  const field = screen.getByRole("textbox", {
    name: i18n.t("filesDirectoryName"),
  }) as HTMLInputElement;
  fireEvent.change(field, { target: { value: "../escape" } });
  fireEvent.click(screen.getByRole("button", { name: i18n.t("filesCreate") }));
  expect((await screen.findByRole("alert")).textContent).toContain(
    i18n.t("filesNameInvalid"),
  );
  expect(WebClient.prototype.mutateWorkspaceFile).not.toHaveBeenCalled();
  fireEvent.change(field, { target: { value: "src" } });
  fireEvent.click(screen.getByRole("button", { name: i18n.t("filesCreate") }));
  await screen.findByText(i18n.t("filesNameExists"));
  expect(field.value).toBe("src");
  fireEvent.change(field, { target: { value: "docs" } });
  fireEvent.click(screen.getByRole("button", { name: i18n.t("filesCreate") }));
  const folder = await screen.findByRole("button", { name: "docs" });
  await waitFor(() => expect(document.activeElement).toBe(folder));
  expect(WebClient.prototype.resolveArtifact).not.toHaveBeenCalled();
});

it("imports exact binary and empty file bytes, retains only the failed file for retry", async () => {
  const view = render(node());
  await screen.findByRole("button", { name: "src" });
  const mutate = vi.mocked(WebClient.prototype.mutateWorkspaceFile);
  const native = mutate.getMockImplementation()!;
  mutate.mockRejectedValueOnce(
    new WebApiError("exists", 409, "ARTIFACT_EXISTS"),
  );
  const binary = new File([new Uint8Array([0, 255, 42])], "binary.dat");
  const empty = new File([], "empty.txt");
  upload(view.container, [binary, empty]);
  const results = await screen.findByRole("list", {
    name: i18n.t("filesImportResults"),
  });
  await within(results).findByText(i18n.t("filesImported"));
  expect(mutate.mock.calls[0]?.[2]).toEqual({
    kind: "import-file",
    directory: ".",
    name: "binary.dat",
    data: "AP8q",
  });
  expect(mutate.mock.calls[1]?.[2]).toEqual({
    kind: "import-file",
    directory: ".",
    name: "empty.txt",
    data: "",
  });
  expect(i18n.t("filesRetryImport", { lng: "en" })).toBe("Retry import");
  expect(i18n.t("filesRetryImport", { lng: "zh-CN" })).toBe("重试导入");
  expect(
    within(results).getAllByRole("button", {
      name: i18n.t("filesRetryImport"),
    }),
  ).toHaveLength(1);
  mutate.mockImplementation(native);
  fireEvent.click(
    within(results).getByRole("button", {
      name: i18n.t("filesRetryImport"),
    }),
  );
  await waitFor(() => expect(mutate).toHaveBeenCalledTimes(3));
  await waitFor(() =>
    expect(
      within(results).queryByRole("button", {
        name: i18n.t("filesRetryImport"),
      }),
    ).toBeNull(),
  );
  expect(mutate).toHaveBeenCalledTimes(3);
  expect(mutate.mock.calls[2]?.[2]).toEqual(mutate.mock.calls[0]?.[2]);
  expect(
    mutate.mock.calls.filter((call) => call[2].name === "empty.txt"),
  ).toHaveLength(1);
});

it("rejects a dropped directory instead of creating an empty directory-shaped file", async () => {
  const view = render(node());
  await screen.findByRole("button", { name: "src" });
  const shell = new File([], "folder");
  fireEvent.drop(view.container.querySelector(".files-preview-empty")!, {
    dataTransfer: {
      types: ["Files"],
      files: [shell],
      items: [
        {
          kind: "file",
          webkitGetAsEntry: () => ({ isDirectory: true, name: "folder" }),
          getAsFile: () => shell,
        },
      ],
    },
  });
  expect(
    await screen.findByText(i18n.t("filesImportDirectoryUnsupported")),
  ).toBeTruthy();
  expect(WebClient.prototype.mutateWorkspaceFile).not.toHaveBeenCalled();
});

it("preserves a too-large file as a failed import without reading or sending it", async () => {
  const view = render(node());
  await screen.findByRole("button", { name: "src" });
  const file = new File(["small fixture"], "large.bin");
  Object.defineProperty(file, "size", { value: WEB_PROMPT_FILE_MAX_BYTES + 1 });
  dropFile(view.container.querySelector(".files-preview-empty")!, file);
  expect(await screen.findByText(i18n.t("filesImportTooLarge"))).toBeTruthy();
  expect(
    screen.getByRole("button", { name: i18n.t("filesRetryImport") }),
  ).toBeTruthy();
  expect(WebClient.prototype.mutateWorkspaceFile).not.toHaveBeenCalled();
});

it("does not apply a delayed write result to another native Session path sharing the ID", async () => {
  let finish!: (result: WorkspaceFileMutationResult) => void;
  vi.mocked(WebClient.prototype.mutateWorkspaceFile).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const view = render(node());
  await screen.findByRole("button", { name: "src" });
  fireEvent.click(screen.getByRole("button", { name: i18n.t("filesNewFile") }));
  fireEvent.change(
    screen.getByRole("textbox", { name: i18n.t("filesFileName") }),
    { target: { value: "old.txt" } },
  );
  fireEvent.click(screen.getByRole("button", { name: i18n.t("filesCreate") }));
  view.rerender(node("/session/b"));
  await act(async () =>
    finish({
      sessionId: "same-id",
      sessionPath: "/session/a",
      path: "old.txt",
      kind: "file",
      bytes: 0,
    }),
  );
  expect(WebClient.prototype.resolveArtifact).not.toHaveBeenCalled();
  expect(
    screen.queryByText(i18n.t("filesCreated", { path: "old.txt" })),
  ).toBeNull();
  expect(
    screen.getByRole("button", { name: i18n.t("filesNewFile") }),
  ).toHaveProperty("disabled", false);
});

it("keeps write controls disabled for a viewing session while path copying remains available", async () => {
  const view = render(node("/session/a", false));
  await screen.findByRole("button", { name: "report.md" });
  expect(
    screen.getByRole("button", { name: i18n.t("filesNewFile") }),
  ).toHaveProperty("disabled", true);
  expect(
    screen.getByRole("button", { name: i18n.t("filesNewDirectory") }),
  ).toHaveProperty("disabled", true);
  expect(
    screen.getByRole("button", { name: i18n.t("filesImport") }),
  ).toHaveProperty("disabled", true);
  const preview = view.container.querySelector(".files-preview-empty")!;
  const file = new File(["not writable"], "readonly-drop.txt");
  expect(fireEvent.dragOver(preview, { dataTransfer: droppedFile(file) })).toBe(
    false,
  );
  expect(
    view.container
      .querySelector(".file-explorer")
      ?.hasAttribute("data-drag-over"),
  ).toBe(false);
  expect(dropFile(preview, file)).toBe(false);
  const menu = screen.getByRole("button", {
    name: i18n.t("filesPathActions", { name: "report.md" }),
  });
  fireEvent.click(menu);
  fireEvent.click(
    await screen.findByRole("menuitem", {
      name: i18n.t("filesCopyRelativePath"),
    }),
  );
  await waitFor(() => expect(copyText).toHaveBeenLastCalledWith("report.md"));
  fireEvent.click(menu);
  fireEvent.click(
    await screen.findByRole("menuitem", {
      name: i18n.t("filesCopyAbsolutePath"),
    }),
  );
  await waitFor(() =>
    expect(copyText).toHaveBeenLastCalledWith("/workspace/report.md"),
  );
  expect(WebClient.prototype.mutateWorkspaceFile).not.toHaveBeenCalled();
});

it("does not refresh another workspace when a delayed result shares the Session id and path", async () => {
  let finish!: (result: WorkspaceFileMutationResult) => void;
  vi.mocked(WebClient.prototype.mutateWorkspaceFile).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const view = render(node());
  await screen.findByRole("button", { name: "src" });
  fireEvent.click(screen.getByRole("button", { name: i18n.t("filesNewFile") }));
  fireEvent.change(
    screen.getByRole("textbox", { name: i18n.t("filesFileName") }),
    { target: { value: "old-workspace.txt" } },
  );
  fireEvent.click(screen.getByRole("button", { name: i18n.t("filesCreate") }));
  view.rerender(node("/session/a", true, "/other-workspace"));
  await act(async () =>
    finish({
      sessionId: "same-id",
      sessionPath: "/session/a",
      path: "old-workspace.txt",
      kind: "file",
      bytes: 0,
    }),
  );
  expect(WebClient.prototype.resolveArtifact).not.toHaveBeenCalled();
  expect(
    screen.queryByText(i18n.t("filesCreated", { path: "old-workspace.txt" })),
  ).toBeNull();
  expect(screen.getByText("other-workspace")).toBeTruthy();
});

it("reports saved files above the preview limit without issuing a doomed preview request", async () => {
  vi.mocked(WebClient.prototype.mutateWorkspaceFile).mockResolvedValueOnce({
    sessionId: "same-id",
    sessionPath: "/session/a",
    path: "big.bin",
    kind: "file",
    bytes: 25 * 1024 * 1024,
  });
  const view = render(node());
  await screen.findByRole("button", { name: "src" });
  upload(view.container, [new File(["fixture"], "big.bin")]);
  expect(
    await screen.findByText(i18n.t("filesImportedNoPreview")),
  ).toBeTruthy();
  expect(WebClient.prototype.resolveArtifact).not.toHaveBeenCalled();
});
