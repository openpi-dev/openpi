// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.doUnmock("../../web/ui/src/features/files/MermaidPreview.tsx");
});

async function fixture(filePreview: boolean) {
  vi.resetModules();
  const load = vi.fn(() => {
    throw new Error("Diagram module download failed");
  });
  vi.doMock("../../web/ui/src/features/files/MermaidPreview.tsx", load);
  const { Markdown } = await import("../../web/ui/src/components/Markdown.tsx");
  const { Providers } = await import("../../web/ui/src/app/providers.tsx");
  const { i18n } = await import("../../web/ui/src/i18n.ts");
  const source = "flowchart LR\nA[Ready] --> B[Recovered]\n";
  const props = {
    filePreview,
    children: `Before diagram\n\n\`\`\`mermaid\n${source}\`\`\`\n\nAfter diagram`,
  };
  render(
    createElement(
      Providers,
      null,
      createElement("textarea", { "aria-label": "Chat input" }),
      createElement(Markdown, props),
    ),
  );
  return { load, source, i18n };
}

it("keeps chat Mermaid as readable code without loading the file renderer", async () => {
  const { load, source, i18n } = await fixture(false);
  expect(document.querySelector("pre code")?.textContent).toBe(source);
  expect(screen.getByRole("button", { name: i18n.t("copyCode") })).toBeTruthy();
  expect(load).not.toHaveBeenCalled();
});

it("preserves the page and copyable source when the file diagram module fails", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  const { load, source, i18n } = await fixture(true);
  expect(
    await screen.findByRole("button", { name: i18n.t("reloadPage") }),
  ).toBeTruthy();
  expect(load).toHaveBeenCalledOnce();
  expect(screen.getByText("Before diagram")).toBeTruthy();
  expect(screen.getByText("After diagram")).toBeTruthy();
  const input = screen.getByRole("textbox", { name: "Chat input" });
  fireEvent.change(input, { target: { value: "Continue working" } });
  expect((input as HTMLTextAreaElement).value).toBe("Continue working");
  fireEvent.click(screen.getByRole("button", { name: i18n.t("copyCode") }));
  expect(writeText).toHaveBeenCalledWith(source);
});
