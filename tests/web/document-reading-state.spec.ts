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
import { Providers } from "../../web/ui/src/app/providers.tsx";
import DocumentPreview from "../../web/ui/src/features/files/DocumentPreview.tsx";
import { WorkbarPanel } from "../../web/ui/src/features/workbar/WorkbarPanel.tsx";
import {
  WorkbarReadingContext,
  type WorkbarReadingState,
} from "../../web/ui/src/features/workbar/workbar-reading-state.ts";
import { i18n } from "../../web/ui/src/i18n.ts";
import { WebClient } from "../../web/ui/src/protocol/client.ts";
import { installCheckVisibilityFixture } from "./check-visibility-fixture.ts";

installCheckVisibilityFixture();
const fixture = vi.hoisted(() => ({
  name: "report.pdf",
  revision: "a".repeat(64),
}));
const destroy = vi.hoisted(() => vi.fn(async () => {}));
const getPage = vi.hoisted(() => vi.fn());
const readingByScope = new Map<string, WorkbarReadingState>();
function pdfPage(rendered = Promise.resolve()) {
  return {
    getViewport: ({ scale }: { scale: number }) => ({
      width: 600 * scale,
      height: 800 * scale,
    }),
    render: () => ({ promise: rendered, cancel: vi.fn() }),
  };
}
vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: {},
  getDocument: () => ({
    destroy,
    promise: Promise.resolve({
      numPages: 4,
      getPage,
    }),
  }),
}));
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({
  default: "fixture-worker",
}));
vi.mock("../../web/ui/src/features/workbar/BrowserPanel.tsx", () => ({
  BrowserPanel: () => createElement("section", null, "Browser fixture"),
}));

beforeEach(() => {
  fixture.name = "report.pdf";
  fixture.revision = "a".repeat(64);
  destroy.mockClear();
  getPage.mockReset().mockImplementation(async () => pdfPage());
  readingByScope.clear();
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(900);
  vi.spyOn(WebClient.prototype, "workspaceFiles").mockImplementation(
    async () => ({
      path: ".",
      entries: [{ name: fixture.name, path: fixture.name, kind: "file" }],
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
        name: fixture.name,
        path: `/workspace/${fixture.name}`,
        revision: fixture.revision,
        bytes: 32,
        preview: "unsupported",
      },
      identity: "v1",
      truncated: false,
    }),
  );
  vi.spyOn(WebClient.prototype, "downloadArtifact").mockImplementation(
    async () => {
      const blob = new Blob([new Uint8Array(32)]);
      Object.defineProperty(blob, "arrayBuffer", {
        value: async () => new ArrayBuffer(32),
      });
      return blob;
    },
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function panel(
  tool: "files" | "browser",
  revision: number,
  sessionPath = "/workspace/same.jsonl",
) {
  const scope = JSON.stringify(["same-session", sessionPath]);
  const reading = readingByScope.get(scope) ?? {};
  readingByScope.set(scope, reading);
  return createElement(
    Providers,
    null,
    createElement(WorkbarPanel, {
      key: scope,
      readingState: reading,
      visible: true,
      requestedTool: tool,
      requestRevision: revision,
      sessionId: "same-session",
      sessionPath,
      cwd: "/workspace",
      capabilities: {},
      review: {
        result: null,
        loading: false,
        error: null,
        refresh: async () => {},
      },
      conversationCollapsed: false,
      onRestoreConversation: () => {},
      onClose: () => {},
    }),
  );
}
async function openPdf() {
  fireEvent.click(await screen.findByRole("button", { name: fixture.name }));
  const next = await screen.findByRole<HTMLButtonElement>("button", {
    name: i18n.t("filesNextPage"),
  });
  await waitFor(() => expect(next.disabled).toBe(false));
  await screen.findByRole("img");
  return next;
}

it.each(["getPage", "render"])(
  "hides the old PDF page while %s is pending or failed and recovers on a valid page",
  async (stage) => {
    render(panel("files", 1));
    const next = await openPdf();
    const canvas = await screen.findByRole("img");
    let reject!: (reason: Error) => void;
    const pending = new Promise<void>((_resolve, rejectPromise) => {
      reject = rejectPromise;
    });
    if (stage === "getPage")
      getPage.mockImplementationOnce(() => pending.then(() => pdfPage()));
    else getPage.mockResolvedValueOnce(pdfPage(pending));
    fireEvent.click(next);
    expect(screen.queryByRole("img")).toBeNull();
    expect(canvas.isConnected).toBe(true);
    expect(getComputedStyle(canvas).display).toBe("none");
    await act(async () => reject(new Error(`Failed ${stage}`)));
    expect((await screen.findByRole("alert")).textContent).toBe(
      `Failed ${stage}`,
    );
    expect(screen.queryByRole("img")).toBeNull();
    expect(getComputedStyle(canvas).display).toBe("none");
    fireEvent.click(
      screen.getByRole("button", { name: i18n.t("filesPreviousPage") }),
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("img")).toBeNull();
    await waitFor(() => expect(screen.getByRole("img")).toBe(canvas));
    expect(canvas.getAttribute("aria-label")).toBe(
      i18n.t("filesPdfPage", { page: 1 }),
    );
    expect(getComputedStyle(canvas).display).not.toBe("none");
    expect(screen.queryByRole("alert")).toBeNull();
  },
);

it.each(["download", "decode"])(
  "recovers a failed document %s when refreshing the same file revision",
  async (failure) => {
    let decodeFailure = true;
    if (failure === "download")
      vi.mocked(WebClient.prototype.downloadArtifact).mockRejectedValueOnce(
        new Error("Temporary document download failure"),
      );
    else {
      fixture.name = "report.docx";
      vi.stubGlobal(
        "Worker",
        class {
          onmessage?: (event: { data: unknown }) => void;
          postMessage() {
            queueMicrotask(() =>
              this.onmessage?.({
                data: decodeFailure
                  ? { error: "Temporary document decode failure" }
                  : {
                      result: { kind: "document", html: "Recovered document" },
                    },
              }),
            );
          }
          terminate() {}
        },
      );
    }
    const view = render(panel("files", 1));
    fireEvent.click(await screen.findByRole("button", { name: fixture.name }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      `Temporary document ${failure} failure`,
    );
    decodeFailure = false;
    fireEvent.click(
      screen.getByRole("button", { name: i18n.t("refreshFile") }),
    );
    await waitFor(() =>
      expect(WebClient.prototype.downloadArtifact).toHaveBeenCalledTimes(2),
    );
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    if (failure === "download") {
      const next = await screen.findByRole<HTMLButtonElement>("button", {
        name: i18n.t("filesNextPage"),
      });
      await waitFor(() => expect(next.disabled).toBe(false));
      await screen.findByRole("img");
    } else
      await waitFor(() =>
        expect(
          view.container
            .querySelector('iframe[title="report.docx"]')
            ?.getAttribute("srcdoc"),
        ).toContain("Recovered document"),
      );
  },
);

function expectPdf(page: number, zoom: string) {
  expect(screen.getByRole("img").getAttribute("aria-label")).toBe(
    i18n.t("filesPdfPage", { page }),
  );
  expect(
    screen.getByRole("button", { name: i18n.t("filesZoomReset") }).textContent,
  ).toContain(zoom);
}

it("does not reuse document controls for a different path with the same native revision", async () => {
  const reading: WorkbarReadingState = {
    artifact: {
      reference: encodeURI("/workspace/different.pdf"),
      source: false,
      editing: false,
      scroll: 0,
      document: {
        path: "/workspace/report.pdf",
        revision: fixture.revision,
        page: 3,
        scale: 1.5,
      },
    },
  };
  render(
    createElement(
      Providers,
      null,
      createElement(
        WorkbarReadingContext.Provider,
        { value: reading },
        createElement(DocumentPreview, {
          client: new WebClient(),
          artifact: {
            handle: "different",
            sessionId: "same-session",
            path: "/workspace/different.pdf",
            name: "different.pdf",
            revision: fixture.revision,
            bytes: 32,
            preview: "unsupported",
          },
        }),
      ),
    ),
  );
  const next = await screen.findByRole<HTMLButtonElement>("button", {
    name: i18n.t("filesNextPage"),
  });
  await waitFor(() => expect(next.disabled).toBe(false));
  await waitFor(() => expectPdf(1, "100%"));
});

it("restores PDF page and zoom through a real Files → Browser → Files remount while releasing resources", async () => {
  const view = render(panel("files", 0));
  fireEvent.click(await openPdf());
  fireEvent.click(screen.getByRole("button", { name: i18n.t("filesZoomIn") }));
  await waitFor(() => expectPdf(2, "125%"));
  view.rerender(panel("browser", 1));
  expect(screen.queryByRole("img")).toBeNull();
  expect(destroy).toHaveBeenCalledTimes(1);
  view.rerender(panel("files", 2));
  await screen.findByRole("img");
  await waitFor(() => expectPdf(2, "125%"));
  expect(WebClient.prototype.downloadArtifact).toHaveBeenCalledTimes(2);
});

it("resets reading controls when the same path has a new native revision", async () => {
  const view = render(panel("files", 0));
  fireEvent.click(await openPdf());
  fireEvent.click(screen.getByRole("button", { name: i18n.t("filesZoomIn") }));
  view.rerender(panel("browser", 1));
  fixture.revision = "b".repeat(64);
  view.rerender(panel("files", 2));
  await screen.findByRole("img");
  await waitFor(() => expectPdf(1, "100%"));
});

it("does not carry a document position into a Session with the same id and another path", async () => {
  const view = render(panel("files", 0));
  fireEvent.click(await openPdf());
  view.rerender(panel("files", 1, "/workspace/other.jsonl"));
  await openPdf();
  await waitFor(() => expectPdf(1, "100%"));
  view.rerender(panel("files", 2));
  await screen.findByRole("img");
  await waitFor(() => expectPdf(2, "100%"));
});

it("keeps the selected worksheet across the same tool remount", async () => {
  fixture.name = "report.xlsx";
  vi.stubGlobal(
    "Worker",
    class {
      onmessage?: (event: { data: unknown }) => void;
      onerror?: () => void;
      postMessage() {
        queueMicrotask(() =>
          this.onmessage?.({
            data: {
              result: {
                kind: "sheets",
                truncated: false,
                sheets: [
                  { name: "First sheet", rows: [["First"]], truncated: false },
                  {
                    name: "Second sheet",
                    rows: [["Second"]],
                    truncated: false,
                  },
                ],
              },
            },
          }),
        );
      }
      terminate() {}
    },
  );
  const view = render(panel("files", 0));
  fireEvent.click(await screen.findByRole("button", { name: fixture.name }));
  fireEvent.click(await screen.findByRole("button", { name: "Second sheet" }));
  view.rerender(panel("browser", 1));
  await act(async () => view.rerender(panel("files", 2)));
  await screen.findByRole("button", { name: "Second sheet" });
  expect(
    screen
      .getByRole("button", { name: "Second sheet" })
      .getAttribute("aria-pressed"),
  ).toBe("true");
});
