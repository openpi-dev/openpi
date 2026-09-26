// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createElement } from "react";
import { I18nextProvider } from "react-i18next";
import { afterEach, expect, it, vi } from "vitest";
import { Markdown } from "../../web/ui/src/components/Markdown.tsx";
import { ArtifactProvider } from "../../web/ui/src/features/artifacts/Artifacts.tsx";
import { i18n } from "../../web/ui/src/i18n.ts";
import { WebClient } from "../../web/ui/src/protocol/client.ts";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const text =
  "[Result](./child/result.md)\n\n![Chart](./child/chart.png)\n\n[Source](https://example.com/source)";

function references(disabled: boolean) {
  return createElement(
    I18nextProvider,
    { i18n },
    createElement(
      ArtifactProvider,
      { sessionId: "parent", sessionPath: "/parent.jsonl", disabled },
      createElement(Markdown, null, text),
    ),
  );
}

it("does not promise file actions while the native preview provider is disabled", () => {
  const read = vi.spyOn(WebClient.prototype, "resolveArtifact");
  const authorize = vi.spyOn(WebClient.prototype, "authorizeArtifact");
  render(references(true));

  expect(screen.queryByRole("button", { name: /Result/u })).toBeNull();
  expect(screen.queryByRole("button", { name: /Chart/u })).toBeNull();
  for (const path of ["./child/result.md", "./child/chart.png"]) {
    const reference = screen.getByTitle(
      i18n.t("artifactReferenceUnavailable", { path }),
    );
    expect(reference.textContent).toContain(path);
    expect(reference.tagName).toBe("SPAN");
  }
  expect(
    screen.getByRole("link", { name: "Source" }).getAttribute("href"),
  ).toBe("https://example.com/source");
  expect(read).not.toHaveBeenCalled();
  expect(authorize).not.toHaveBeenCalled();
});

it("projects provider availability changes without adding another file authorization rule", async () => {
  const read = vi
    .spyOn(WebClient.prototype, "resolveArtifact")
    .mockImplementation(() => new Promise(() => {}));
  const view = render(references(true));

  view.rerender(references(false));
  fireEvent.click(screen.getByRole("button", { name: /Result/u }));
  await waitFor(() => expect(read).toHaveBeenCalledOnce());
  expect(read).toHaveBeenCalledWith(
    "parent",
    "./child/result.md",
    undefined,
    expect.any(AbortSignal),
  );

  view.rerender(references(true));
  expect(screen.queryByRole("button", { name: /Result/u })).toBeNull();
  expect(read.mock.calls[0]![3]!.aborted).toBe(true);
});

it("keeps local link and image references inspectable without an artifact provider", () => {
  render(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(Markdown, null, text),
    ),
  );

  for (const path of ["./child/result.md", "./child/chart.png"]) {
    expect(
      screen.getByTitle(i18n.t("artifactReferenceUnavailable", { path }))
        .textContent,
    ).toContain(path);
  }
  expect(screen.queryAllByRole("button")).toHaveLength(0);
});
