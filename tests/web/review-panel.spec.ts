// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { I18nextProvider } from "react-i18next";
import { afterEach, expect, it, vi } from "vitest";
import type { WebSessionProjection } from "../../web/protocol/types.ts";
import {
  changeCalls,
  changeLineCounts,
  ReviewPanel,
} from "../../web/ui/src/features/review/ReviewPanel.tsx";
import { i18n } from "../../web/ui/src/i18n.ts";

afterEach(cleanup);

const entries: WebSessionProjection["entries"] = [
  {
    id: "call-a",
    type: "message",
    timestamp: "2026-09-18T00:00:00Z",
    message: {
      role: "assistant",
      content: "",
      parts: [
        {
          type: "toolCall",
          id: "w1",
          name: "write",
          arguments: '{"path":"report.md"}',
        },
        {
          type: "toolCall",
          id: "w2",
          name: "edit",
          arguments: '{"path":"report.md"}',
        },
        {
          type: "toolCall",
          id: "w3",
          name: "edit",
          arguments: '{"path":"other.md"}',
        },
      ],
    },
  },
  {
    id: "result-a",
    type: "message",
    timestamp: "2026-09-18T00:00:01Z",
    message: {
      role: "toolResult",
      toolCallId: "w1",
      content: "created",
      isError: false,
      details: { change: "created" },
    },
  },
  {
    id: "result-b",
    type: "message",
    timestamp: "2026-09-18T00:00:02Z",
    message: {
      role: "toolResult",
      toolCallId: "w2",
      content: "edited",
      isError: false,
      details: { diff: "-old\n+new" },
    },
  },
  {
    id: "result-c",
    type: "message",
    timestamp: "2026-09-18T00:00:03Z",
    message: {
      role: "toolResult",
      toolCallId: "w3",
      content: "denied",
      isError: true,
    },
  },
];

const session: WebSessionProjection = {
  id: "parent",
  path: "/workspace/parent.jsonl",
  cwd: "/workspace",
  entries,
  bytes: 0,
  truncation: {
    truncated: true,
    entriesOmitted: 8,
    messagesTruncated: 0,
    messagePartsOmitted: 0,
    maxBytes: 2_097_152,
  },
};

it("keeps each exact tool receipt instead of merging a file into a Git snapshot", () => {
  const rows = changeCalls(session);
  expect(rows).toHaveLength(3);
  expect(rows.map((row) => row.result?.content)).toEqual([
    "created",
    "edited",
    "denied",
  ]);
  expect(
    changeCalls({ ...session, entries: entries.slice(0, 1) }).every(
      (row) => row.result === undefined,
    ),
  ).toBe(true);
  expect(changeLineCounts(rows[1]!.call, rows[1]!.result)).toEqual({
    additions: 1,
    deletions: 1,
  });
  expect(changeLineCounts(rows[0]!.call, rows[0]!.result)).toBeUndefined();
});

it("leaves ambiguous duplicate call and result IDs unpaired", () => {
  const ambiguousResults = changeCalls({
    ...session,
    entries: [
      ...entries,
      {
        type: "message",
        id: "result-duplicate",
        timestamp: "2026-09-18T00:00:04Z",
        message: {
          role: "toolResult",
          toolCallId: "w1",
          content: "another result",
          isError: false,
        },
      },
    ],
  });
  expect(ambiguousResults[0]?.result).toBeUndefined();
  expect(ambiguousResults[1]?.result?.content).toBe("edited");

  const ambiguousCalls = changeCalls({
    ...session,
    entries: [
      ...entries,
      {
        type: "message",
        id: "call-duplicate",
        timestamp: "2026-09-18T00:00:04Z",
        message: {
          role: "assistant",
          content: "",
          parts: [
            {
              type: "toolCall",
              id: "w1",
              name: "write",
              arguments: '{"path":"report.md"}',
            },
          ],
        },
      },
    ],
  });
  expect(ambiguousCalls[0]?.result).toBeUndefined();
  expect(ambiguousCalls[3]?.result).toBeUndefined();
});

it("labels partial Session evidence and supports keyboard return without a Git clean claim", () => {
  const onClose = vi.fn();
  const { container } = render(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(ReviewPanel, { session, onClose }),
    ),
  );
  expect(screen.getByText(/not the current Git working tree/u)).toBeTruthy();
  expect(screen.getByText(/earlier changes may be absent/u)).toBeTruthy();
  expect(container.querySelectorAll(".review-entry")).toHaveLength(3);
  expect(
    screen.getByText(
      i18n.t("changeEvidenceDelta", { additions: 1, deletions: 1 }),
    ),
  ).toBeTruthy();
  const cards = container.querySelectorAll(".review-entry .tool-evidence-card");
  fireEvent.click(cards[1]!.querySelector("summary")!);
  expect(
    screen.getByRole("figure", { name: "Change diff" }).textContent,
  ).toContain("+new");
  expect(cards[2]?.textContent).toContain("failed");
  fireEvent.keyDown(
    screen.getByRole("complementary", { name: "Change evidence" }),
    { key: "Escape" },
  );
  expect(onClose).toHaveBeenCalledTimes(1);
});
