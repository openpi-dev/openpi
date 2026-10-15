// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createElement, Fragment, useLayoutEffect } from "react";
import { I18nextProvider } from "react-i18next";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import type { WebSessionSource } from "../../web/protocol/session-sources.ts";
import { WEB_PROMPT_IMAGE_MAX_BYTES } from "../../web/protocol/types.ts";
import {
  SourceImage,
  SourcesDialog,
} from "../../web/ui/src/features/subagents/session-sources.tsx";
import { UserImageAttachments } from "../../web/ui/src/features/transcript/UserImageAttachments.tsx";
import { i18n } from "../../web/ui/src/i18n.ts";
import { WebClient } from "../../web/ui/src/protocol/client.ts";

const source: WebSessionSource = {
  id: "native:4",
  entryId: "native",
  partIndex: 4,
  kind: "image",
  name: "中文图片.png",
};
const validImage = { mimeType: "image/png", data: "aGk=" };
const createUrl = vi.fn((_blob: Blob) => "blob:fixture");
const revokeUrl = vi.fn();
beforeAll(() => {
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: createUrl,
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: revokeUrl,
  });
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.open = true;
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.open = false;
    },
  });
});
afterAll(() => {
  Reflect.deleteProperty(URL, "createObjectURL");
  Reflect.deleteProperty(URL, "revokeObjectURL");
  Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
  Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
function withI18n(element: ReturnType<typeof createElement>) {
  return createElement(I18nextProvider, { i18n }, element);
}
function imageView(props: Partial<Parameters<typeof SourceImage>[0]> = {}) {
  return withI18n(
    createElement(SourceImage, {
      sessionId: "a",
      path: "/a.jsonl",
      source,
      ...props,
    }),
  );
}
function observerControl() {
  const callbacks: ((entries: { isIntersecting: boolean }[]) => void)[] = [];
  const disconnect = vi.fn();
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
        callbacks.push(callback);
      }
      observe = vi.fn();
      disconnect = disconnect;
    },
  );
  return {
    visible: (value: boolean, index = 0) =>
      act(() => callbacks[index]!([{ isIntersecting: value }])),
    disconnect,
  };
}

it("loads thumbnails only while visible and releases bytes when they leave the viewport", async () => {
  const control = observerControl();
  const read = vi
    .spyOn(WebClient.prototype, "sourceImage")
    .mockResolvedValue(validImage);
  const view = render(imageView({ thumbnail: true }));
  expect(read).not.toHaveBeenCalled();
  control.visible(true);
  await waitFor(() =>
    expect(view.container.querySelector("img")).not.toBeNull(),
  );
  expect(read).toHaveBeenCalledWith(
    "a",
    "/a.jsonl",
    "native",
    4,
    expect.any(AbortSignal),
  );
  expect(createUrl).toHaveBeenCalledOnce();
  control.visible(false);
  expect(view.container.querySelector("img")).toBeNull();
  expect(read.mock.calls[0]![4].aborted).toBe(true);
  expect(revokeUrl).toHaveBeenCalledWith("blob:fixture");
  control.visible(true);
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  view.unmount();
  expect(control.disconnect).toHaveBeenCalledOnce();
  expect(read.mock.calls[1]![4].aborted).toBe(true);
});

it("ignores late image bytes from a previous exact Session and never flashes its URL", async () => {
  let resolveFirst: ((image: typeof validImage) => void) | undefined;
  const first = new Promise<typeof validImage>((resolve) => {
    resolveFirst = resolve;
  });
  const read = vi
    .spyOn(WebClient.prototype, "sourceImage")
    .mockReturnValueOnce(first)
    .mockResolvedValueOnce(validImage);
  const view = render(imageView());
  view.rerender(imageView({ sessionId: "b", path: "/b.jsonl" }));
  expect(read.mock.calls[0]![4].aborted).toBe(true);
  await waitFor(() =>
    expect(view.container.querySelector("img")).not.toBeNull(),
  );
  await act(async () => {
    resolveFirst!(validImage);
    await first;
  });
  expect(createUrl).toHaveBeenCalledOnce();
  expect(read.mock.calls[1]!.slice(0, 4)).toEqual([
    "b",
    "/b.jsonl",
    "native",
    4,
  ]);
});

it("removes the previous source URL during the scope change render before effects run", async () => {
  vi.spyOn(WebClient.prototype, "sourceImage")
    .mockResolvedValueOnce(validImage)
    .mockReturnValueOnce(new Promise(() => undefined));
  const frames: { scope: string; url: string | null }[] = [];
  function Probe({ scope }: { scope: string }) {
    useLayoutEffect(() => {
      frames.push({
        scope,
        url: document.querySelector("img")?.getAttribute("src") ?? null,
      });
    }, [scope]);
    return null;
  }
  const frame = (sessionId: string) =>
    withI18n(
      createElement(
        Fragment,
        null,
        createElement(SourceImage, {
          sessionId,
          path: `/${sessionId}.jsonl`,
          source,
        }),
        createElement(Probe, { scope: sessionId }),
      ),
    );
  const view = render(frame("a"));
  await waitFor(() =>
    expect(view.container.querySelector("img")).not.toBeNull(),
  );
  view.rerender(frame("b"));
  expect(frames.at(-1)).toEqual({ scope: "b", url: null });
});

it("accepts the full admitted raw byte limit even when base64 is larger than the old cap", async () => {
  const data = Buffer.alloc(WEB_PROMPT_IMAGE_MAX_BYTES, 127).toString("base64");
  expect(data.length).toBeGreaterThan(12 * 1024 * 1024);
  vi.spyOn(WebClient.prototype, "sourceImage").mockResolvedValue({
    ...validImage,
    data,
  });
  const view = render(imageView());
  await waitFor(() =>
    expect(view.container.querySelector("img")).not.toBeNull(),
  );
  expect(createUrl.mock.calls[0]?.[0].size).toBe(WEB_PROMPT_IMAGE_MAX_BYTES);
});

it.each([
  "aGl=",
  "!!!!",
  Buffer.alloc(WEB_PROMPT_IMAGE_MAX_BYTES + 1).toString("base64"),
])("fails closed on invalid or oversized source bytes", async (data) => {
  vi.spyOn(WebClient.prototype, "sourceImage").mockResolvedValue({
    ...validImage,
    data,
  });
  render(imageView());
  expect((await screen.findByRole("alert")).textContent).toContain(
    i18n.t("imagePreviewFailed"),
  );
  expect(createUrl).not.toHaveBeenCalled();
});

it("opens saved images at the original native part index and closes on Session changes", async () => {
  const read = vi
    .spyOn(WebClient.prototype, "sourceImage")
    .mockResolvedValue(validImage);
  observerControl();
  const props = {
    sessionId: "a",
    path: "/a.jsonl",
    entryId: "native",
    message: {
      role: "user" as const,
      content: "caption",
      parts: [
        {
          type: "image" as const,
          mimeType: "image/png",
          name: source.name,
          sourcePartIndex: 4,
        },
      ],
    },
  };
  const view = render(withI18n(createElement(UserImageAttachments, props)));
  expect(read).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: source.name }));
  await waitFor(() => expect(screen.getByAltText(source.name)).toBeTruthy());
  expect(read.mock.calls[0]!.slice(0, 4)).toEqual([
    "a",
    "/a.jsonl",
    "native",
    4,
  ]);
  expect(
    screen.queryByRole("button", { name: i18n.t("sourcesBack") }),
  ).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("originalImageSize") }),
  );
  expect(view.container.querySelector('[data-mode="original"]')).not.toBeNull();
  view.rerender(
    withI18n(
      createElement(UserImageAttachments, {
        ...props,
        sessionId: "b",
        path: "/b.jsonl",
      }),
    ),
  );
  expect(view.container.querySelector("dialog")).toBeNull();
  expect(read.mock.calls[0]![4].aborted).toBe(true);
});

it("does not invent a native location for optimistic or older unindexed image metadata", () => {
  const read = vi.spyOn(WebClient.prototype, "sourceImage");
  const view = render(
    withI18n(
      createElement(UserImageAttachments, {
        sessionId: "a",
        path: "/a.jsonl",
        entryId: "native",
        message: {
          role: "user",
          content: "caption",
          parts: [
            {
              type: "image",
              mimeType: "image/png",
              name: source.name,
              previewUrl: "blob:optimistic",
            },
          ],
        },
      }),
    ),
  );
  expect(screen.getByAltText(source.name).getAttribute("src")).toBe(
    "blob:optimistic",
  );
  expect(view.container.querySelector("button")).toBeNull();
  expect(read).not.toHaveBeenCalled();
});

it("retains the existing dialog close lifecycle to restore focus and stop image reads", async () => {
  observerControl();
  const read = vi
    .spyOn(WebClient.prototype, "sourceImage")
    .mockResolvedValue(validImage);
  const view = render(
    withI18n(
      createElement(UserImageAttachments, {
        sessionId: "a",
        path: "/a.jsonl",
        entryId: "native",
        message: {
          role: "user",
          content: "caption",
          parts: [
            {
              type: "image",
              mimeType: "image/png",
              name: source.name,
              sourcePartIndex: 4,
            },
          ],
        },
      }),
    ),
  );
  const opener = screen.getByRole("button", { name: source.name });
  opener.focus();
  fireEvent.click(opener);
  await waitFor(() => expect(screen.getByAltText(source.name)).toBeTruthy());
  fireEvent.click(screen.getByRole("button", { name: i18n.t("close") }));
  const dialog = view.container.querySelector("dialog")!;
  expect(dialog.open).toBe(false);
  expect(document.activeElement).toBe(opener);
  expect(read.mock.calls[0]![4].aborted).toBe(true);
  expect(revokeUrl).toHaveBeenCalledWith("blob:fixture");
});

it("does not fetch a retained closed preview dialog", () => {
  const read = vi.spyOn(WebClient.prototype, "sourceImage");
  render(
    withI18n(
      createElement(SourcesDialog, {
        sessionId: "a",
        path: "/a.jsonl",
        source,
        open: false,
        onSelect: vi.fn(),
        onClose: vi.fn(),
      }),
    ),
  );
  expect(read).not.toHaveBeenCalled();
});
