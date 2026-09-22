// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createElement, useContext } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { ArtifactPreview } from "../../web/protocol/artifacts.ts";
import { ArtifactProvider } from "../../web/ui/src/features/artifacts/Artifacts.tsx";
import { ArtifactContext } from "../../web/ui/src/features/artifacts/context.ts";
import { WebClient } from "../../web/ui/src/protocol/client.ts";
import { i18n } from "../../web/ui/src/i18n.ts";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function Content() {
  const artifacts = useContext(ArtifactContext);
  return createElement(
    "div",
    null,
    createElement(
      "button",
      { type: "button", onClick: () => artifacts?.open("report.txt") },
      "Open file",
    ),
    createElement("input", { "aria-label": "Settings input" }),
  );
}
it.each(["disabled", "session"])(
  "notifies the outer panel when %s closes a pending preview without stealing focus",
  async (boundary) => {
    vi.spyOn(WebClient.prototype, "resolveArtifact").mockResolvedValue({
      handle: "grant",
    });
    vi.spyOn(WebClient.prototype, "releaseArtifact").mockResolvedValue({});
    let finish!: (value: ArtifactPreview) => void;
    const read = vi
      .spyOn(WebClient.prototype, "artifactPreview")
      .mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
    const close = vi.fn();
    const node = (changed = false) =>
      createElement(
        ArtifactProvider,
        {
          sessionId:
            changed && boundary === "session" ? "other-session" : "session",
          disabled: changed && boundary === "disabled",
          onClose: close,
        },
        createElement(Content),
      );
    const view = render(node());
    const opener = screen.getByRole("button", { name: "Open file" });
    opener.focus();
    fireEvent.click(opener);
    await waitFor(() => expect(read).toHaveBeenCalledOnce());
    const settings = screen.getByRole("textbox", { name: "Settings input" });
    settings.focus();
    view.rerender(node(true));
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(document.activeElement).toBe(settings);
    expect(close).toHaveBeenCalledExactlyOnceWith("context");
    expect(read.mock.calls[0]![2]?.aborted).toBe(true);
    await act(async () =>
      finish({
        artifact: {
          sessionId: "session",
          handle: "grant",
          path: "/report.txt",
          name: "report.txt",
          revision: "a",
          bytes: 4,
          preview: "text",
        },
        text: "Late file",
        truncated: false,
      }),
    );
    expect(screen.queryByText("Late file")).toBeNull();
    expect(close).toHaveBeenCalledOnce();
  },
);

it("keeps an explicit close distinct and returns focus to its opener", async () => {
  vi.spyOn(WebClient.prototype, "resolveArtifact").mockResolvedValue({
    handle: "grant",
  });
  vi.spyOn(WebClient.prototype, "releaseArtifact").mockResolvedValue({});
  vi.spyOn(WebClient.prototype, "artifactPreview").mockResolvedValue({
    artifact: {
      sessionId: "s",
      handle: "grant",
      path: "/report.txt",
      name: "report.txt",
      revision: "a",
      bytes: 4,
      preview: "text",
    },
    text: "File text",
    truncated: false,
  });
  const close = vi.fn();
  render(
    createElement(
      ArtifactProvider,
      { sessionId: "s", onClose: close },
      createElement(Content),
    ),
  );
  const opener = screen.getByRole("button", { name: "Open file" });
  opener.focus();
  fireEvent.click(opener);
  await screen.findByText("File text");
  fireEvent.click(screen.getByRole("button", { name: i18n.t("closePreview") }));
  expect(close).toHaveBeenCalledExactlyOnceWith("user");
  expect(document.activeElement).toBe(opener);
});
