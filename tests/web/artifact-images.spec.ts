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
import type { ArtifactPreview } from "../../web/protocol/artifacts.ts";
import { Markdown } from "../../web/ui/src/components/Markdown.tsx";
import { ArtifactProvider } from "../../web/ui/src/features/artifacts/Artifacts.tsx";
import { i18n } from "../../web/ui/src/i18n.ts";
import { WebApiError, WebClient } from "../../web/ui/src/protocol/client.ts";

const createUrl = vi.fn((_blob: Blob) => "blob:artifact-image");
const revokeUrl = vi.fn((_url: string) => {});
const png = () => new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])]);

beforeEach(() => {
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
  vi.spyOn(WebClient.prototype, "artifactPreview").mockImplementation(
    async (sessionId, handle): Promise<ArtifactPreview> => ({
      artifact: {
        handle,
        sessionId,
        name: handle.slice(2),
        path: `/workspace/${handle.slice(2)}`,
        revision: "a".repeat(64),
        bytes: 8,
        preview: "unsupported",
      },
      identity: handle,
      truncated: false,
    }),
  );
  vi.spyOn(WebClient.prototype, "artifactMetadata").mockImplementation(
    async (_session, handle) => ({ identity: handle }),
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const node = (sessionId = "s", first = "first.png") =>
  createElement(
    ArtifactProvider,
    { sessionId },
    createElement(Markdown, null, `[First](./${first}) [Second](./second.png)`),
  );

it.each([
  ["png", [137, 80, 78, 71, 13, 10, 26, 10], "image/png"],
  ["jpg", [255, 216, 255], "image/jpeg"],
  ["gif", Array.from("GIF89a", (char) => char.charCodeAt(0)), "image/gif"],
  [
    "webp",
    Array.from("RIFF0000WEBP", (char) => char.charCodeAt(0)),
    "image/webp",
  ],
] as const)(
  "previews a %s through its existing authorized download and releases its blob on close",
  async (extension, bytes, mime) => {
    const download = vi
      .spyOn(WebClient.prototype, "downloadArtifact")
      .mockResolvedValue(new Blob([new Uint8Array(bytes)]));
    render(node("s", `first.${extension}`));
    fireEvent.click(screen.getByRole("button", { name: "First" }));
    const image = await screen.findByAltText<HTMLImageElement>(
      `first.${extension}`,
    );
    expect(download).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "s",
        handle: `./first.${extension}`,
        revision: "a".repeat(64),
      }),
      expect.any(AbortSignal),
    );
    expect(createUrl.mock.calls[0]![0].type).toBe(mime);
    expect(image.hidden).toBe(true);
    fireEvent.load(image);
    expect(image.hidden).toBe(false);
    expect(screen.queryByText(i18n.t("artifactUnsupported"))).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: i18n.t("closePreview") }),
    );
    expect(download.mock.calls[0]![1].aborted).toBe(true);
    expect(revokeUrl).toHaveBeenCalledWith("blob:artifact-image");
  },
);

it.each(["close", "session"])(
  "ignores an image download that finishes after %s",
  async (action) => {
    let finish!: (blob: Blob) => void;
    const download = vi
      .spyOn(WebClient.prototype, "downloadArtifact")
      .mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
    const view = render(node());
    fireEvent.click(screen.getByRole("button", { name: "First" }));
    await waitFor(() => expect(download).toHaveBeenCalledOnce());
    if (action === "close")
      fireEvent.click(
        screen.getByRole("button", { name: i18n.t("closePreview") }),
      );
    else view.rerender(node("different-session"));
    expect(download.mock.calls[0]![1].aborted).toBe(true);
    await act(async () => finish(png()));
    expect(createUrl).not.toHaveBeenCalled();
    expect(screen.queryByRole("complementary")).toBeNull();
  },
);

it("releases the previous image and cancels the new read when its panel unmounts", async () => {
  let finish!: (blob: Blob) => void;
  const download = vi
    .spyOn(WebClient.prototype, "downloadArtifact")
    .mockResolvedValueOnce(png())
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
  const view = render(node());
  fireEvent.click(screen.getByRole("button", { name: "First" }));
  await screen.findByAltText("first.png");
  fireEvent.click(screen.getByRole("button", { name: "Second" }));
  await waitFor(() => expect(download).toHaveBeenCalledTimes(2));
  expect(revokeUrl).toHaveBeenCalledWith("blob:artifact-image");
  expect(screen.queryByAltText("first.png")).toBeNull();
  view.unmount();
  expect(download.mock.calls[1]![1].aborted).toBe(true);
  await act(async () => finish(png()));
  expect(createUrl).toHaveBeenCalledOnce();
});

it("rejects disguised SVG bytes and keeps the explicit download available", async () => {
  vi.spyOn(WebClient.prototype, "downloadArtifact").mockResolvedValue(
    new Blob(["<svg xmlns='http://www.w3.org/2000/svg' />"]),
  );
  render(node());
  fireEvent.click(screen.getByRole("button", { name: "First" }));
  expect((await screen.findByRole("alert")).textContent).toContain(
    i18n.t("artifactImagePreviewFailed"),
  );
  expect(createUrl).not.toHaveBeenCalled();
  expect(
    screen.getByRole<HTMLButtonElement>("button", {
      name: i18n.t("downloadFile"),
    }).disabled,
  ).toBe(false);
});

it("reports raster decode errors without leaving a broken image", async () => {
  vi.spyOn(WebClient.prototype, "downloadArtifact").mockResolvedValue(png());
  render(node());
  fireEvent.click(screen.getByRole("button", { name: "First" }));
  const image = await screen.findByAltText("first.png");
  fireEvent.error(image);
  expect(screen.getByRole("alert").textContent).toContain(
    i18n.t("artifactImagePreviewFailed"),
  );
  expect(screen.queryByAltText("first.png")).toBeNull();
});

it("keeps a decoded image when a metadata refresh returns the same authorized content", async () => {
  const first: ArtifactPreview = {
    artifact: {
      sessionId: "s",
      handle: "./first.png",
      path: "/workspace/first.png",
      name: "first.png",
      revision: "a".repeat(64),
      bytes: 8,
      preview: "unsupported",
    },
    identity: "before-touch",
    truncated: false,
  };
  const previews = vi
    .mocked(WebClient.prototype.artifactPreview)
    .mockResolvedValueOnce(first)
    .mockResolvedValue({
      ...first,
      artifact: { ...first.artifact },
      identity: "after-touch",
    });
  vi.mocked(WebClient.prototype.artifactMetadata).mockResolvedValue({
    identity: "after-touch",
  });
  const download = vi
    .spyOn(WebClient.prototype, "downloadArtifact")
    .mockResolvedValue(png());
  render(node());
  fireEvent.click(screen.getByRole("button", { name: "First" }));
  const image = await screen.findByAltText<HTMLImageElement>("first.png");
  fireEvent.load(image);
  expect(image.hidden).toBe(false);
  await waitFor(() => expect(previews).toHaveBeenCalledTimes(2), {
    timeout: 3500,
  });
  expect(download).toHaveBeenCalledOnce();
  expect(download.mock.calls[0]![1].aborted).toBe(false);
  expect(revokeUrl).not.toHaveBeenCalled();
  expect(screen.getByAltText("first.png")).toBe(image);
  expect(image.hidden).toBe(false);
});

it.each(["revision", "handle", "path"] as const)(
  "replaces the image when its %s changes and cancels a late replacement",
  async (field) => {
    const first: ArtifactPreview = {
      artifact: {
        sessionId: "s",
        handle: "./first.png",
        path: "/workspace/first.png",
        name: "first.png",
        revision: "a".repeat(64),
        bytes: 8,
        preview: "unsupported",
      },
      identity: "before",
      truncated: false,
    };
    const updated = {
      ...first.artifact,
      [field]:
        field === "revision"
          ? "b".repeat(64)
          : field === "path"
            ? "/another/first.png"
            : "new-grant",
    };
    vi.mocked(WebClient.prototype.artifactPreview)
      .mockResolvedValueOnce(first)
      .mockResolvedValue({ ...first, artifact: updated, identity: "after" });
    vi.mocked(WebClient.prototype.artifactMetadata).mockResolvedValue({
      identity: "after",
    });
    let finish!: (blob: Blob) => void;
    const download = vi
      .spyOn(WebClient.prototype, "downloadArtifact")
      .mockResolvedValueOnce(png())
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
    const view = render(node());
    fireEvent.click(screen.getByRole("button", { name: "First" }));
    const image = await screen.findByAltText<HTMLImageElement>("first.png");
    fireEvent.load(image);
    await waitFor(() => expect(download).toHaveBeenCalledTimes(2), {
      timeout: 3500,
    });
    expect(download.mock.calls[0]![1].aborted).toBe(true);
    expect(image.isConnected).toBe(false);
    expect(revokeUrl).toHaveBeenCalledWith("blob:artifact-image");
    view.unmount();
    expect(download.mock.calls[1]![1].aborted).toBe(true);
    await act(async () => finish(png()));
    expect(createUrl).toHaveBeenCalledOnce();
  },
);

it.each([401, 403, 410])(
  "cancels an in-flight image when metadata returns revoked access (%s)",
  async (status) => {
    vi.mocked(WebClient.prototype.artifactMetadata).mockRejectedValue(
      new WebApiError(
        "File access revoked",
        status,
        status === 410 ? "ARTIFACT_EXPIRED" : "ARTIFACT_DENIED",
      ),
    );
    let finish!: (blob: Blob) => void;
    const download = vi
      .spyOn(WebClient.prototype, "downloadArtifact")
      .mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
    const view = render(node());
    fireEvent.click(screen.getByRole("button", { name: "First" }));
    await waitFor(() => expect(download).toHaveBeenCalledOnce());
    await screen.findByText("File access revoked", {}, { timeout: 3500 });
    expect(view.container.querySelector(".artifact-image-preview")).toBeNull();
    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: i18n.t("downloadFile"),
      }).disabled,
    ).toBe(true);
    // Revoked content is removed in the commit; React runs the child's
    // passive-effect cleanup (which aborts the fetch) after that commit.
    await waitFor(() => expect(download.mock.calls[0]![1].aborted).toBe(true));
    await act(async () => finish(png()));
    expect(createUrl).not.toHaveBeenCalled();
    expect(screen.queryByAltText("first.png")).toBeNull();
  },
);

it.each(["svg", "html"])(
  "does not automatically download a %s as an image",
  async (extension) => {
    const download = vi.spyOn(WebClient.prototype, "downloadArtifact");
    render(node("s", `first.${extension}`));
    fireEvent.click(screen.getByRole("button", { name: "First" }));
    await screen.findByText(i18n.t("artifactUnsupported"));
    expect(download).not.toHaveBeenCalled();
    expect(createUrl).not.toHaveBeenCalled();
  },
);
