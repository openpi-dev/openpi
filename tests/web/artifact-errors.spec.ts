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
import { afterEach, expect, it, vi } from "vitest";
import type { ArtifactPreview } from "../../web/protocol/artifacts.ts";
import { Markdown } from "../../web/ui/src/components/Markdown.tsx";
import { ArtifactProvider } from "../../web/ui/src/features/artifacts/Artifacts.tsx";
import { i18n } from "../../web/ui/src/i18n.ts";
import { WebApiError, WebClient } from "../../web/ui/src/protocol/client.ts";

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await i18n.changeLanguage("en");
});
const file: ArtifactPreview = {
  artifact: {
    sessionId: "s",
    handle: "h",
    path: "/report.txt",
    name: "report.txt",
    revision: "a",
    bytes: 10,
    preview: "text",
  },
  text: "Original file bytes",
  truncated: false,
};
function openFile() {
  vi.spyOn(WebClient.prototype, "resolveArtifact").mockResolvedValue({
    handle: "h",
  });
  vi.spyOn(WebClient.prototype, "releaseArtifact").mockResolvedValue({});
  render(
    createElement(
      ArtifactProvider,
      { sessionId: "s" },
      createElement(Markdown, null, "[Report](report.txt)"),
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Report" }));
}
it("reprojects an existing typed read error without repeating authorization or reads", async () => {
  const read = vi
    .spyOn(WebClient.prototype, "artifactPreview")
    .mockRejectedValue(
      new WebApiError("server expiry", 410, "ARTIFACT_EXPIRED"),
    );
  openFile();
  await screen.findByText(
    "File access expired. Open the file again from its Session.",
  );
  await act(() => i18n.changeLanguage("zh"));
  expect(
    screen.getByText("文件访问已过期，请从所属会话重新打开。"),
  ).toBeTruthy();
  expect(read).toHaveBeenCalledOnce();
  expect(WebClient.prototype.resolveArtifact).toHaveBeenCalledOnce();
  await act(() => i18n.changeLanguage("en"));
  expect(
    screen.getByText(
      "File access expired. Open the file again from its Session.",
    ),
  ).toBeTruthy();
  expect(read).toHaveBeenCalledOnce();
});
it.each(["download", "read-more"])(
  "reprojects %s failures while retaining the file and request counts",
  async (operation) => {
    const read = vi
      .spyOn(WebClient.prototype, "artifactPreview")
      .mockResolvedValue({
        ...file,
        ...(operation === "read-more"
          ? { truncated: true, nextOffset: 10 }
          : {}),
      });
    const download = vi
      .spyOn(WebClient.prototype, "downloadArtifact")
      .mockRejectedValue(
        new WebApiError("server missing", 404, "ARTIFACT_MISSING"),
      );
    openFile();
    await screen.findByText("Original file bytes");
    if (operation === "read-more")
      read.mockRejectedValue(
        new WebApiError("server missing", 404, "ARTIFACT_MISSING"),
      );
    fireEvent.click(
      screen.getByRole("button", {
        name: i18n.t(
          operation === "download" ? "downloadFile" : "filesReadMore",
        ),
      }),
    );
    await screen.findByText(/File no longer exists/);
    const reads = read.mock.calls.length;
    const downloads = download.mock.calls.length;
    await act(() => i18n.changeLanguage("zh"));
    expect(screen.getByText(/文件已不存在/)).toBeTruthy();
    expect(screen.getByText("Original file bytes")).toBeTruthy();
    expect(read).toHaveBeenCalledTimes(reads);
    expect(download).toHaveBeenCalledTimes(downloads);
  },
);
it("keeps unknown diagnostics verbatim on language change", async () => {
  vi.spyOn(WebClient.prototype, "artifactPreview").mockRejectedValue(
    new WebApiError(
      "Unknown custom diagnostic",
      410,
      "FUTURE_ARTIFACT_FAILURE",
    ),
  );
  openFile();
  await screen.findByText("Unknown custom diagnostic");
  await act(() => i18n.changeLanguage("zh"));
  expect(screen.getByText("Unknown custom diagnostic")).toBeTruthy();
});
it("reprojects image failures without redownloading the authorized image", async () => {
  vi.spyOn(WebClient.prototype, "artifactPreview").mockResolvedValue({
    ...file,
    artifact: {
      ...file.artifact,
      name: "report.png",
      path: "/report.png",
      preview: "unsupported",
    },
  });
  vi.spyOn(WebClient.prototype, "artifactMetadata").mockResolvedValue({
    identity: "a",
  });
  const download = vi
    .spyOn(WebClient.prototype, "downloadArtifact")
    .mockRejectedValue(
      new WebApiError("server expiry", 410, "ARTIFACT_EXPIRED"),
    );
  openFile();
  await screen.findByText(
    "File access expired. Open the file again from its Session.",
  );
  await act(() => i18n.changeLanguage("zh"));
  await waitFor(() =>
    expect(
      screen.getByText("文件访问已过期，请从所属会话重新打开。"),
    ).toBeTruthy(),
  );
  expect(download).toHaveBeenCalledOnce();
});

it("uses a localized fallback for non-Error failures", async () => {
  vi.spyOn(WebClient.prototype, "artifactPreview").mockRejectedValue(undefined);
  openFile();
  await screen.findByText(i18n.t("filesReadFailed"));
  await act(() => i18n.changeLanguage("zh"));
  expect(screen.getByText(i18n.t("filesReadFailed"))).toBeTruthy();
});
it.each(["missing-body", "too-large"])(
  "types the local %s download failure and retains reader cleanup",
  async (failure) => {
    const client = new WebClient();
    vi.spyOn(client, "headers").mockResolvedValue({
      Authorization: "Bearer fixture",
      "X-OpenPI-Web-Controller": "fixture",
    });
    const cancel = vi.fn(async () => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        body:
          failure === "missing-body"
            ? null
            : {
                getReader: () => ({
                  read: async () => ({
                    done: false,
                    value: new Uint8Array(20 * 1024 * 1024 + 1),
                  }),
                  cancel,
                }),
              },
      })),
    );
    await expect(
      client.downloadArtifact(file.artifact, new AbortController().signal),
    ).rejects.toMatchObject({
      name: "WebApiError",
      code:
        failure === "missing-body"
          ? "ARTIFACT_DOWNLOAD_BODY"
          : "ARTIFACT_TOO_LARGE",
    });
    expect(cancel).toHaveBeenCalledTimes(failure === "missing-body" ? 0 : 1);
  },
);
