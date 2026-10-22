// @vitest-environment jsdom

import { act, cleanup, render, waitFor } from "@testing-library/react";
import mermaid from "mermaid";
import { createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import MermaidPreview from "../../web/ui/src/features/files/MermaidPreview.tsx";

vi.mock("mermaid", () => ({
  default: { initialize: vi.fn(), render: vi.fn() },
}));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const svg = (text: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg"><text>${text}</text></svg>`;

it("recovers when Read more completes a previously truncated Mermaid source", async () => {
  const draw = vi.mocked(mermaid.render);
  draw.mockRejectedValueOnce(new Error("Incomplete diagram"));
  draw.mockResolvedValueOnce({ svg: svg("Recovered") } as Awaited<
    ReturnType<typeof mermaid.render>
  >);
  const view = render(
    createElement(MermaidPreview, { source: "graph TD\nA[" }),
  );
  await waitFor(() =>
    expect(view.container.textContent).toContain("Incomplete diagram"),
  );
  view.rerender(
    createElement(MermaidPreview, { source: "graph TD\nA[Recovered]" }),
  );
  await waitFor(() => expect(draw).toHaveBeenCalledTimes(2));
  await waitFor(() =>
    expect(view.container.querySelector(".file-diagram > img")).not.toBeNull(),
  );
  expect(view.container.textContent).not.toContain("Incomplete diagram");
});

it("hides the previous image while a changed source is rendering", async () => {
  const draw = vi.mocked(mermaid.render);
  draw.mockResolvedValueOnce({ svg: svg("Previous") } as Awaited<
    ReturnType<typeof mermaid.render>
  >);
  let finish!: (result: Awaited<ReturnType<typeof mermaid.render>>) => void;
  draw.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const view = render(
    createElement(MermaidPreview, { source: "graph TD\nA[Previous]" }),
  );
  await waitFor(() =>
    expect(view.container.querySelector(".file-diagram > img")).not.toBeNull(),
  );
  view.rerender(
    createElement(MermaidPreview, { source: "graph TD\nB[Current]" }),
  );
  await waitFor(() => expect(draw).toHaveBeenCalledTimes(2));
  expect(view.container.querySelector(".file-diagram img")).toBeNull();
  expect(view.container.querySelector('[role="status"]')).not.toBeNull();
  await act(async () =>
    finish({ svg: svg("Current") } as Awaited<
      ReturnType<typeof mermaid.render>
    >),
  );
  await waitFor(() =>
    expect(
      view.container.querySelector(".file-diagram > img")?.getAttribute("src"),
    ).toContain("Current"),
  );
});
