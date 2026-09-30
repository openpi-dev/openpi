// @vitest-environment jsdom

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  cleanup,
} from "@testing-library/react";
import { createElement } from "react";
import { I18nextProvider } from "react-i18next";
import { expect, it, vi } from "vitest";
import { readGitReview } from "../../web/host/git-review.ts";
import type { WebSessionProjection } from "../../web/protocol/types.ts";
import { ReviewPanel } from "../../web/ui/src/features/review/ReviewPanel.tsx";
import { useGitReview } from "../../web/ui/src/features/review/use-git-review.ts";
import { WebClient } from "../../web/ui/src/protocol/client.ts";
import { i18n } from "../../web/ui/src/i18n.ts";

it("rejects changed contents when switching files in a pinned comparison until latest is adopted", async () => {
  const root = mkdtempSync(join(tmpdir(), "openpi-review-revision-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
  try {
    git("init", "-b", "main");
    git("config", "user.name", "Review");
    git("config", "user.email", "review@example.invalid");
    for (const path of ["a.txt", "b.txt"])
      writeFileSync(join(root, path), "base\n");
    git("add", ".");
    git("commit", "-m", "base");
    writeFileSync(join(root, "a.txt"), "old-a\n");
    writeFileSync(join(root, "b.txt"), "OLD_PINNED_B\n");
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(
          private callback: (
            entries: { contentRect: { width: number } }[],
          ) => void,
        ) {}
        observe(element: Element) {
          if (element.classList.contains("review-panel"))
            this.callback([{ contentRect: { width: 900 } }]);
        }
        unobserve() {}
        disconnect() {}
      },
    );
    const read = vi
      .spyOn(WebClient.prototype, "gitReview")
      .mockImplementation(async (_id, _path, _signal, options) =>
        readGitReview(root, {
          source: options?.source,
          summary: !options?.file,
          ...(options?.file ? { filePath: options.file } : {}),
          ...(options?.offset === undefined
            ? {}
            : { offset: Number(options.offset) }),
          ...(options?.revision ? { expectedRevision: options.revision } : {}),
        }),
      );
    const session: WebSessionProjection = {
      id: "review",
      path: "/sessions/review.jsonl",
      cwd: root,
      entries: [],
      bytes: 0,
      truncation: {
        truncated: false,
        maxBytes: 1024,
        entriesOmitted: 0,
        messagesTruncated: 0,
        messagePartsOmitted: 0,
      },
    };
    function Panel({ refreshKey }: { refreshKey: number }) {
      const review = useGitReview(session, refreshKey);
      return createElement(
        I18nextProvider,
        { i18n },
        createElement(ReviewPanel, {
          embedded: true,
          review,
          onClose: () => {},
        }),
      );
    }
    const { rerender } = render(createElement(Panel, { refreshKey: 0 }));
    await screen.findByRole("figure");
    writeFileSync(join(root, "b.txt"), "NEW_UNADOPTED_B\n");
    rerender(createElement(Panel, { refreshKey: 1 }));
    await screen.findByRole("button", { name: "Show latest diff" });
    fireEvent.click(screen.getByRole("button", { name: "b.txt" }));
    await screen.findByText(i18n.t("gitReviewChanged"));
    expect(screen.queryByRole("figure")).toBeNull();
    expect(
      read.mock.calls
        .filter((call) => call[3]?.file)
        .every((call) => Boolean(call[3]?.revision)),
    ).toBe(true);
    fireEvent.click(
      screen.getByRole("button", { name: i18n.t("retryAdmissionCheck") }),
    );
    await screen.findByText(i18n.t("gitReviewChanged"));
    expect(screen.queryByRole("figure")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show latest diff" }));
    await waitFor(() =>
      expect(screen.getByRole("figure").textContent).toContain(
        "NEW_UNADOPTED_B",
      ),
    );
    expect(
      screen.queryByRole("button", { name: "Show latest diff" }),
    ).toBeNull();
  } finally {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    rmSync(root, { recursive: true, force: true });
  }
});
