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
import { Providers } from "../../web/ui/src/app/providers.tsx";
import { ArchiveNotifications } from "../../web/ui/src/features/sessions/ArchiveNotifications.tsx";
import { i18n } from "../../web/ui/src/i18n.ts";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function mount() {
  const actions = {
    selectSession: vi.fn().mockResolvedValue(true),
    unarchiveSession: vi.fn().mockResolvedValue(true),
    dismissArchiveNotice: vi.fn(),
  };
  const view = render(
    createElement(
      Providers,
      null,
      createElement(ArchiveNotifications, {
        notices: [
          {
            key: "receipt-a",
            path: "/a.jsonl",
            sessionId: "session-a",
            title: "Archived task",
          },
        ],
        actions,
      }),
    ),
  );
  return { ...view, actions };
}

it("expires after eight seconds, pausing while the pointer or keyboard is inside", () => {
  vi.useFakeTimers();
  const { actions } = mount();
  const toast = screen.getByRole("status");
  act(() => {
    vi.advanceTimersByTime(3000);
  });
  fireEvent.mouseEnter(toast);
  act(() => {
    vi.advanceTimersByTime(9000);
  });
  expect(actions.dismissArchiveNotice).not.toHaveBeenCalled();
  fireEvent.mouseLeave(toast);
  const undo = screen.getByRole("button", {
    name: i18n.t("archiveNoticeUndo"),
  });
  fireEvent.focus(undo);
  act(() => {
    vi.advanceTimersByTime(9000);
  });
  expect(actions.dismissArchiveNotice).not.toHaveBeenCalled();
  fireEvent.blur(undo, { relatedTarget: document.body });
  act(() => {
    vi.advanceTimersByTime(4999);
  });
  expect(actions.dismissArchiveNotice).not.toHaveBeenCalled();
  act(() => {
    vi.advanceTimersByTime(1);
  });
  expect(actions.dismissArchiveNotice).toHaveBeenCalledWith("receipt-a");
});

it("keeps a pending or failed undo available and retries only that archived Session", async () => {
  vi.useFakeTimers();
  const { actions } = mount();
  let settle!: (value: boolean) => void;
  actions.unarchiveSession.mockReturnValueOnce(
    new Promise<boolean>((resolve) => {
      settle = resolve;
    }),
  );
  const undo = screen.getByRole("button", {
    name: i18n.t("archiveNoticeUndo"),
  });
  fireEvent.click(undo);
  fireEvent.click(undo);
  act(() => {
    vi.advanceTimersByTime(9000);
  });
  expect(actions.unarchiveSession).toHaveBeenCalledTimes(1);
  expect(actions.unarchiveSession).toHaveBeenCalledWith("/a.jsonl");
  expect(actions.dismissArchiveNotice).not.toHaveBeenCalled();
  await act(async () => {
    settle(false);
  });
  expect(screen.getByRole("alert").textContent).toBe(
    i18n.t("archiveNoticeFailed"),
  );
  act(() => {
    vi.advanceTimersByTime(9000);
  });
  expect(actions.dismissArchiveNotice).not.toHaveBeenCalled();
  await act(async () => {
    fireEvent.click(undo);
  });
  expect(actions.dismissArchiveNotice).toHaveBeenCalledWith("receipt-a");
  expect(actions.selectSession).not.toHaveBeenCalled();
});

it("views the exact archived Session and closes without restoring it", async () => {
  const { actions } = mount();
  await act(async () => {
    fireEvent.click(
      screen.getByRole("button", { name: i18n.t("archiveNoticeView") }),
    );
  });
  expect(actions.selectSession).toHaveBeenCalledWith("/a.jsonl", "session-a");
  expect(actions.dismissArchiveNotice).toHaveBeenCalledWith("receipt-a");
  expect(actions.unarchiveSession).not.toHaveBeenCalled();
});
