// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  createElement,
  createRef,
  type MouseEvent,
  useContext,
  useState,
} from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { ArtifactPreview } from "../../web/protocol/artifacts.ts";
import {
  ArtifactProvider,
  type ArtifactProviderHandle,
} from "../../web/ui/src/features/artifacts/Artifacts.tsx";
import { ArtifactContext } from "../../web/ui/src/features/artifacts/context.ts";
import { i18n } from "../../web/ui/src/i18n.ts";
import { WebClient } from "../../web/ui/src/protocol/client.ts";
import { installCheckVisibilityFixture } from "./check-visibility-fixture.ts";

installCheckVisibilityFixture();
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function Content({ hidden = false }: { hidden?: boolean }) {
  const artifacts = useContext(ArtifactContext);
  return createElement(
    "div",
    null,
    createElement(
      "button",
      {
        type: "button",
        hidden,
        onClick: (event: MouseEvent<HTMLButtonElement>) =>
          artifacts?.open("report.txt", undefined, event.currentTarget),
      },
      "Open file",
    ),
    createElement("input", { "aria-label": "Settings input" }),
  );
}
it.each(["disabled", "session", "path"])(
  "notifies the outer panel when %s closes a pending preview without stealing focus",
  async (boundary) => {
    vi.spyOn(WebClient.prototype, "resolveArtifact").mockResolvedValue({
      handle: "grant",
    });
    const release = vi
      .spyOn(WebClient.prototype, "releaseArtifact")
      .mockResolvedValue({});
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
          sessionPath:
            changed && boundary === "path" ? "/copy/session" : "/session",
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
    expect(release).toHaveBeenCalledExactlyOnceWith("session", "grant");
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
    expect(release).toHaveBeenCalledOnce();
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
  await waitFor(() => expect(document.activeElement).toBe(opener));
});

const file: ArtifactPreview = {
  artifact: {
    sessionId: "session",
    handle: "grant",
    path: "/report.txt",
    name: "report.txt",
    revision: "a",
    bytes: 4,
    preview: "text",
  },
  text: "File text",
  truncated: false,
};

function mockFile() {
  const resolve = vi
    .spyOn(WebClient.prototype, "resolveArtifact")
    .mockResolvedValue({ handle: "grant" });
  const release = vi
    .spyOn(WebClient.prototype, "releaseArtifact")
    .mockResolvedValue({});
  const read = vi
    .spyOn(WebClient.prototype, "artifactPreview")
    .mockResolvedValue(file);
  return { resolve, release, read };
}

function focusFrames() {
  const frames = new Map<number, FrameRequestCallback>();
  let sequence = 0;
  const request = vi
    .spyOn(window, "requestAnimationFrame")
    .mockImplementation((callback) => {
      const id = ++sequence;
      frames.set(id, callback);
      return id;
    });
  const cancel = vi
    .spyOn(window, "cancelAnimationFrame")
    .mockImplementation((id) => {
      frames.delete(id);
    });
  return {
    request,
    cancel,
    flush() {
      act(() => {
        const callbacks = [...frames.values()];
        frames.clear();
        for (const callback of callbacks) callback(0);
      });
    },
  };
}

it("restores the actual source only after closing makes it visible again", async () => {
  mockFile();
  const frames = focusFrames();
  function Host() {
    const [open, setOpen] = useState(false);
    return createElement(
      ArtifactProvider,
      {
        sessionId: "session",
        sessionPath: "/session",
        onOpen: () => setOpen(true),
        onClose: () => setOpen(false),
      },
      createElement(Content, { hidden: open }),
    );
  }
  render(createElement(Host));
  const opener = screen.getByRole<HTMLButtonElement>("button", {
    name: "Open file",
  });
  const settings = screen.getByRole("textbox", { name: "Settings input" });
  settings.focus();
  fireEvent.click(opener);
  await screen.findByText("File text");
  expect(opener.hidden).toBe(true);
  const focus = vi.spyOn(opener, "focus");
  fireEvent.click(screen.getByRole("button", { name: i18n.t("closePreview") }));
  expect(opener.hidden).toBe(false);
  expect(focus).not.toHaveBeenCalled();
  frames.flush();
  expect(focus).toHaveBeenCalledOnce();
  expect(document.activeElement).toBe(opener);
});

it.each(["hidden", "removed"])(
  "does not restore a %s source after closing",
  async (boundary) => {
    mockFile();
    const frames = focusFrames();
    const node = (changed = false) =>
      createElement(
        ArtifactProvider,
        { sessionId: "session", sessionPath: "/session" },
        changed && boundary === "removed"
          ? createElement("input", { "aria-label": "Settings input" })
          : createElement(Content, { hidden: changed }),
      );
    const view = render(node());
    const opener = screen.getByRole("button", { name: "Open file" });
    fireEvent.click(opener);
    await screen.findByText("File text");
    const focus = vi.spyOn(opener, "focus");
    view.rerender(node(true));
    const settings = screen.getByRole("textbox", { name: "Settings input" });
    settings.focus();
    fireEvent.click(
      screen.getByRole("button", { name: i18n.t("closePreview") }),
    );
    frames.flush();
    expect(focus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(settings);
  },
);

it("cancels pending return focus when another preview opens in the same Session", async () => {
  mockFile();
  const frames = focusFrames();
  render(
    createElement(
      ArtifactProvider,
      { sessionId: "session" },
      createElement(Content),
    ),
  );
  const opener = screen.getByRole("button", { name: "Open file" });
  fireEvent.click(opener);
  await screen.findByText("File text");
  fireEvent.click(screen.getByRole("button", { name: i18n.t("closePreview") }));
  fireEvent.click(opener);
  await screen.findByText("File text");
  expect(frames.cancel).toHaveBeenCalledWith(1);
  frames.flush();
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: i18n.t("closePreview") }),
  );
});

it("does not take focus back after the user moves away during a pending return", async () => {
  mockFile();
  const frames = focusFrames();
  render(
    createElement(
      ArtifactProvider,
      { sessionId: "session" },
      createElement(Content),
    ),
  );
  const opener = screen.getByRole("button", { name: "Open file" });
  fireEvent.click(opener);
  await screen.findByText("File text");
  fireEvent.click(screen.getByRole("button", { name: i18n.t("closePreview") }));
  const settings = screen.getByRole("textbox", { name: "Settings input" });
  settings.focus();
  const focus = vi.spyOn(opener, "focus");
  frames.flush();
  expect(focus).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(settings);
});

it("closes for explicit navigation without returning focus to the preview source", async () => {
  const { release } = mockFile();
  const frames = focusFrames();
  const close = vi.fn();
  const provider = createRef<ArtifactProviderHandle>();
  render(
    createElement(
      ArtifactProvider,
      { ref: provider, sessionId: "session", onClose: close },
      createElement(Content),
    ),
  );
  const opener = screen.getByRole("button", { name: "Open file" });
  fireEvent.click(opener);
  await screen.findByText("File text");
  const focus = vi.spyOn(opener, "focus");
  const settings = screen.getByRole("textbox", { name: "Settings input" });
  settings.focus();
  act(() => provider.current?.close({ restoreFocus: false }));
  expect(screen.queryByRole("complementary")).toBeNull();
  expect(close).toHaveBeenCalledExactlyOnceWith("user");
  expect(release).toHaveBeenCalledExactlyOnceWith("session", "grant");
  expect(frames.request).not.toHaveBeenCalled();
  frames.flush();
  expect(focus).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(settings);
});

it.each(["path", "disabled", "unmount"])(
  "cancels a pending close return on %s boundary",
  async (boundary) => {
    mockFile();
    const frames = focusFrames();
    const node = (changed = false) =>
      createElement(
        ArtifactProvider,
        {
          sessionId: "session",
          sessionPath:
            changed && boundary === "path" ? "/copy/session" : "/session",
          disabled: changed && boundary === "disabled",
        },
        createElement(Content),
      );
    const view = render(node());
    fireEvent.click(screen.getByRole("button", { name: "Open file" }));
    await screen.findByText("File text");
    fireEvent.click(
      screen.getByRole("button", { name: i18n.t("closePreview") }),
    );
    if (boundary === "unmount") view.unmount();
    else {
      screen.getByRole("textbox", { name: "Settings input" }).focus();
      view.rerender(node(true));
    }
    const active = document.activeElement;
    expect(frames.cancel).toHaveBeenCalledWith(1);
    frames.flush();
    expect(document.activeElement).toBe(active);
  },
);

it("keeps refresh focus and clears the failed read while retrying", async () => {
  const { read } = mockFile();
  let finish!: (value: ArtifactPreview) => void;
  read.mockRejectedValueOnce(new Error("Read unavailable")).mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  render(
    createElement(
      ArtifactProvider,
      { sessionId: "session" },
      createElement(Content),
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Open file" }));
  await screen.findByText("Read unavailable");
  const refresh = screen.getByRole("button", { name: i18n.t("refreshFile") });
  refresh.focus();
  fireEvent.click(refresh);
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  expect(screen.queryByText("Read unavailable")).toBeNull();
  expect(document.activeElement).toBe(refresh);
  await act(async () => finish(file));
  await screen.findByText("File text");
  expect(document.activeElement).toBe(refresh);
});

it("releases a late grant acquired after the original preview context closed", async () => {
  const { resolve, release, read } = mockFile();
  let finish!: (value: { handle: string }) => void;
  resolve.mockReturnValue(
    new Promise((complete) => {
      finish = complete;
    }),
  );
  const close = vi.fn();
  const node = (path: string) =>
    createElement(
      ArtifactProvider,
      { sessionId: "session", sessionPath: path, onClose: close },
      createElement(Content),
    );
  const view = render(node("/session"));
  fireEvent.click(screen.getByRole("button", { name: "Open file" }));
  await waitFor(() => expect(resolve).toHaveBeenCalledOnce());
  const settings = screen.getByRole("textbox", { name: "Settings input" });
  settings.focus();
  view.rerender(node("/copy/session"));
  expect(resolve.mock.calls[0]![3]?.aborted).toBe(true);
  expect(screen.queryByRole("complementary")).toBeNull();
  await act(async () => finish({ handle: "late-grant" }));
  expect(release).toHaveBeenCalledExactlyOnceWith("session", "late-grant");
  expect(read).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledExactlyOnceWith("context");
  expect(document.activeElement).toBe(settings);
});

it("retains the original opener and reports nested preview navigation", async () => {
  const { resolve, read } = mockFile();
  const frames = focusFrames();
  resolve
    .mockResolvedValueOnce({ handle: "grant" })
    .mockResolvedValue({ handle: "child-grant" });
  read
    .mockResolvedValueOnce({
      ...file,
      artifact: { ...file.artifact, path: "/report.md", name: "report.md" },
      text: "[Child](child.txt)",
    })
    .mockResolvedValue({
      ...file,
      artifact: {
        ...file.artifact,
        handle: "child-grant",
        path: "/child.txt",
        name: "child.txt",
      },
      text: "Child text",
    });
  const open = vi.fn();
  render(
    createElement(
      ArtifactProvider,
      { sessionId: "session", onOpen: open },
      createElement(Content),
    ),
  );
  const opener = screen.getByRole("button", { name: "Open file" });
  fireEvent.click(opener);
  fireEvent.click(await screen.findByRole("button", { name: /Child/u }));
  await screen.findByText("Child text");
  expect(open.mock.calls).toEqual([[false], [true]]);
  expect(resolve).toHaveBeenLastCalledWith(
    "session",
    "child.txt",
    "grant",
    expect.any(AbortSignal),
  );
  fireEvent.click(screen.getByRole("button", { name: i18n.t("closePreview") }));
  frames.flush();
  expect(document.activeElement).toBe(opener);
});

it("leaves composition and already-handled Escape to their owner", async () => {
  mockFile();
  const frames = focusFrames();
  const close = vi.fn();
  render(
    createElement(
      ArtifactProvider,
      { sessionId: "session", onClose: close },
      createElement(Content),
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Open file" }));
  await screen.findByText("File text");
  const button = screen.getByRole("button", { name: i18n.t("closePreview") });
  fireEvent.keyDown(button, { key: "Escape", isComposing: true });
  expect(close).not.toHaveBeenCalled();
  const prevent = (event: KeyboardEvent) => event.preventDefault();
  button.addEventListener("keydown", prevent);
  fireEvent.keyDown(button, { key: "Escape" });
  expect(close).not.toHaveBeenCalled();
  button.removeEventListener("keydown", prevent);
  expect(fireEvent.keyDown(button, { key: "Escape" })).toBe(false);
  expect(close).toHaveBeenCalledExactlyOnceWith("user");
  expect(screen.queryByRole("complementary")).toBeNull();
  frames.flush();
});
