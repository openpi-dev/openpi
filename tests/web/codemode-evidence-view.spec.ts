// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { ArtifactContext } from "../../web/ui/src/features/artifacts/context.ts";
import { CodemodeEvidence } from "../../web/ui/src/features/transcript/CodemodeEvidence.tsx";
import { i18n } from "../../web/ui/src/i18n.ts";

const call = {
  type: "toolCall" as const,
  id: "script",
  name: "codemode",
  arguments: JSON.stringify({ code: "await tools.read({path: 'report.md'});" }),
};
const result = {
  content: "Script completed\nOutput:\nexpected failure retained",
  isError: false,
  details: {
    calls: [
      {
        id: "script/1",
        name: "read",
        args: '{"path":"report.md"}',
        status: "ok",
      },
      {
        id: "script/2",
        name: "bash",
        args: '{"command":"exit 7"}',
        status: "error",
        error: "Command exited with code 7",
      },
    ],
  },
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("keeps script success separate from nested failure and reopens exact file parameters without invented output", () => {
  const open = vi.fn();
  const { container } = render(
    createElement(
      ArtifactContext.Provider,
      { value: { open } },
      createElement(CodemodeEvidence, { call, result }),
    ),
  );
  const card =
    container.querySelector<HTMLDetailsElement>(".codemode-evidence")!;
  expect(card.open).toBe(false);
  expect(card.dataset.state).toBe("returned");
  expect(card.querySelector(".codemode-failure-count")?.textContent).toBe(
    i18n.t("codemodeFailedCount", { count: 1 }),
  );
  expect(
    card.querySelector('[data-call-id="script/2"] [data-state="failed"]'),
  ).toBeTruthy();
  expect(
    screen.getByRole("region", { name: i18n.t("codemodeCalls"), hidden: true })
      .tabIndex,
  ).toBe(0);
  fireEvent.click(card.querySelector("summary")!);
  fireEvent.click(screen.getByRole("button", { name: "report.md" }));
  expect(open).toHaveBeenCalledWith("report.md");
  expect(card.open).toBe(true);
  expect(container.querySelectorAll(".evidence-shell")).toHaveLength(0);
  expect(screen.getAllByText(i18n.t("codemodeOutputNotSaved"))).toHaveLength(2);
  expect(
    screen.getByRole("figure", { name: i18n.t("codemodeOutput") }).textContent,
  ).toContain("expected failure retained");
});

it("expands while running, permits manual closing with current-call preview, and collapses after settlement", () => {
  const running = {
    content: "",
    details: {
      calls: [
        {
          id: "script/?",
          name: "bash",
          args: '{"command":"wc -l report.md"}',
          status: "running",
        },
      ],
    },
  };
  const { container, rerender } = render(
    createElement(CodemodeEvidence, {
      call,
      result: running,
      liveState: "running",
    }),
  );
  const card =
    container.querySelector<HTMLDetailsElement>(".codemode-evidence")!;
  expect(card.open).toBe(true);
  fireEvent.click(card.querySelector("summary")!);
  fireEvent(card, new Event("toggle"));
  expect(card.open).toBe(false);
  expect(card.querySelector(".evidence-command")?.textContent).toContain(
    "wc -l report.md",
  );
  rerender(
    createElement(CodemodeEvidence, {
      call,
      result: { ...running, content: "still executing" },
      liveState: "running",
    }),
  );
  expect(card.open).toBe(false);
  rerender(createElement(CodemodeEvidence, { call, result }));
  expect(card.open).toBe(false);
  expect(card.dataset.state).toBe("returned");
});

it("uses native live child evidence only with a matching parent and copies script and output separately", async () => {
  const writeText = vi.fn(async () => undefined);
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
  try {
    const { container } = render(
      createElement(CodemodeEvidence, {
        call,
        result,
        liveTools: [
          {
            call: {
              type: "toolCall",
              id: "script/1",
              name: "read",
              arguments: '{"path":"report.md"}',
            },
            parentToolCallId: "script",
            state: "returned",
            result: { content: "actual saved live output", isError: false },
          },
        ],
      }),
    );
    fireEvent.click(container.querySelector(".codemode-evidence > summary")!);
    expect(
      screen.getByRole("figure", {
        name: "File content",
        hidden: true,
      }).textContent,
    ).toContain("actual saved live output");
    fireEvent.click(container.querySelector(".codemode-script > summary")!);
    const copy = screen.getAllByRole("button", { name: i18n.t("copyCode") });
    await act(async () => fireEvent.click(copy[0]!));
    expect(writeText).toHaveBeenLastCalledWith(
      "await tools.read({path: 'report.md'});",
    );
    await act(async () => fireEvent.click(copy[1]!));
    expect(writeText).toHaveBeenLastCalledWith(result.content);
  } finally {
    vi.unstubAllGlobals();
  }
});
