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
import { Markdown } from "../../web/ui/src/components/Markdown.tsx";
import { ArtifactProvider } from "../../web/ui/src/features/artifacts/Artifacts.tsx";
import { ArtifactContext } from "../../web/ui/src/features/artifacts/context.ts";
import { i18n } from "../../web/ui/src/i18n.ts";
import { WebClient } from "../../web/ui/src/protocol/client.ts";

const createUrl = vi.fn((_blob: Blob) => "blob:inline-image");
const revokeUrl = vi.fn((_url: string) => {});
beforeEach(async () => {
  createUrl.mockClear();
  revokeUrl.mockClear();
  const OriginalURL = URL;
  vi.stubGlobal(
    "URL",
    class extends OriginalURL {
      static createObjectURL = createUrl;
      static revokeObjectURL = revokeUrl;
    },
  );
  vi.spyOn(WebClient.prototype, "resolveArtifact").mockImplementation(
    async (_session, reference) => ({ handle: reference }),
  );
  vi.spyOn(WebClient.prototype, "releaseArtifact").mockResolvedValue({});
  vi.spyOn(WebClient.prototype, "artifactMetadata").mockResolvedValue({
    identity: "same",
  });
  vi.spyOn(WebClient.prototype, "artifactPreview").mockImplementation(
    async (sessionId, handle, _signal, page) => ({
      artifact: {
        sessionId,
        handle,
        name: handle,
        path: `/workspace/${handle}`,
        revision: "a".repeat(64),
        bytes: 100,
        preview: "text",
      },
      identity: "same",
      text:
        handle === "report.md"
          ? page
            ? "\n\nMore text"
            : "![Picture](relative.png)"
          : undefined,
      truncated: handle === "report.md" && !page,
      ...(handle === "report.md" && !page ? { nextOffset: 24 } : {}),
    }),
  );
  const png = await new Response(
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
  ).blob();
  vi.spyOn(WebClient.prototype, "downloadArtifact").mockResolvedValue(png);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const markdown = (
  parent = "parent",
  text = "![Picture](relative.png)",
  disabled = false,
  sessionId = "s",
) => {
  const props = { filePreview: true, children: text };
  return createElement(
    ArtifactContext.Provider,
    { value: { open() {}, sessionId, parent, disabled } },
    createElement(Markdown, props),
  );
};

it("keeps displayed inline images when copying the file path and reading more text", async () => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
  render(
    createElement(
      ArtifactProvider,
      { sessionId: "s", embedded: true },
      createElement(Markdown, null, "[Open document](report.md)"),
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Open document" }));
  const image = await screen.findByAltText("Picture");
  await act(async () =>
    fireEvent.click(
      screen.getByRole("button", { name: i18n.t("copyFilePath") }),
    ),
  );
  expect(screen.getByAltText("Picture")).toBe(image);
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("filesReadMore") }),
  );
  await screen.findByText("More text");
  expect(screen.getByAltText("Picture")).toBe(image);
  expect(WebClient.prototype.downloadArtifact).toHaveBeenCalledOnce();
  expect(createUrl).toHaveBeenCalledOnce();
  expect(revokeUrl).not.toHaveBeenCalled();
});

it.each(["parent", "src", "session"])(
  "removes old pixels and cancels downloads when the image %s changes",
  async (change) => {
    const view = render(markdown());
    const image = await screen.findByAltText("Picture");
    const download = vi.mocked(WebClient.prototype.downloadArtifact);
    let finish!: (blob: Blob) => void;
    const late = new Promise<Blob>((resolve) => {
      finish = resolve;
    });
    download.mockReturnValueOnce(late);
    view.rerender(
      markdown(
        change === "parent" ? "other-parent" : "parent",
        change === "src" ? "![Picture](other.png)" : undefined,
        false,
        change === "session" ? "other-session" : "s",
      ),
    );
    expect(image.isConnected).toBe(false);
    expect(revokeUrl).toHaveBeenCalledWith("blob:inline-image");
    expect(download.mock.calls[0]![1].aborted).toBe(true);
    await waitFor(() => expect(download).toHaveBeenCalledTimes(2));
    expect(WebClient.prototype.resolveArtifact).toHaveBeenLastCalledWith(
      change === "session" ? "other-session" : "s",
      change === "src" ? "other.png" : "relative.png",
      change === "parent" ? "other-parent" : "parent",
      expect.any(AbortSignal),
    );
    view.unmount();
    expect(download.mock.calls[1]![1].aborted).toBe(true);
    await act(async () =>
      finish(
        await new Response(
          new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
        ).blob(),
      ),
    );
    expect(createUrl).toHaveBeenCalledOnce();
    expect(WebClient.prototype.releaseArtifact).toHaveBeenCalledTimes(2);
  },
);

it("clears a previous error when another parent starts loading", async () => {
  vi.mocked(WebClient.prototype.resolveArtifact).mockRejectedValueOnce(
    new Error("Missing image"),
  );
  const view = render(markdown());
  await screen.findByText("[Picture]");
  vi.mocked(WebClient.prototype.resolveArtifact).mockImplementationOnce(
    (_session, _reference, _parent, signal) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("Aborted")), {
          once: true,
        });
      }),
  );
  view.rerender(markdown("new-parent"));
  expect(screen.queryByText("[Picture]")).toBeNull();
  expect(screen.getByText("Picture")).toBeTruthy();
  await waitFor(() =>
    expect(WebClient.prototype.resolveArtifact).toHaveBeenCalledTimes(2),
  );
});

it("keeps the sixteen-image limit across context updates and document growth", async () => {
  const text = Array.from(
    { length: 17 },
    (_, index) => `![Image ${index}](image-${index}.png)`,
  ).join("\n\n");
  const view = render(markdown("parent", text));
  await waitFor(() => expect(screen.getAllByRole("img")).toHaveLength(16));
  expect(WebClient.prototype.downloadArtifact).toHaveBeenCalledTimes(16);
  view.rerender(markdown("parent", `${text}\n\nMore text`));
  expect(screen.getAllByRole("img")).toHaveLength(16);
  expect(WebClient.prototype.downloadArtifact).toHaveBeenCalledTimes(16);
  expect(screen.getByRole("button", { name: /Image 16/u })).toBeTruthy();
  view.rerender(markdown("parent", text, true));
  expect(screen.queryAllByRole("img")).toHaveLength(0);
  expect(revokeUrl).toHaveBeenCalledTimes(16);
});
