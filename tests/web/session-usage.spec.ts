// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { createElement } from "react";
import { afterEach, expect, it } from "vitest";
import type { WebSessionUsage } from "../../web/protocol/types.ts";
import { Providers } from "../../web/ui/src/app/providers.tsx";
import { SessionUsageBar } from "../../web/ui/src/features/workbar/SessionUsageBar.tsx";
import { i18n } from "../../web/ui/src/i18n.ts";
import { installCheckVisibilityFixture } from "./check-visibility-fixture.ts";

installCheckVisibilityFixture();
afterEach(cleanup);

const usage: WebSessionUsage = {
  input: 6_835,
  output: 6,
  cacheRead: 300,
  cacheWrite: 0,
  total: 7_141,
  context: { tokens: 6_841, contextWindow: 128_000, percent: 5.34453125 },
};

function usageView(value: WebSessionUsage | undefined) {
  return createElement(
    Providers,
    null,
    createElement(SessionUsageBar, {
      usage: value,
      workspace: "fixture-workspace",
      sessionId: "fixture-session-id",
    }),
  );
}

function usageTrigger() {
  return screen.getByRole("button", {
    name: i18n.t("usageOpenDetails", {
      input: "7k",
      output: "6",
      percent: "5%",
      capacity: "128k",
    }),
  });
}

it("shows input, output, context and capacity without opening details", () => {
  render(usageView(usage));
  const trigger = usageTrigger();
  expect(trigger.textContent).toContain("7k");
  expect(trigger.textContent).toContain("6");
  expect(trigger.textContent).toContain("5% / 128k");
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("opens precise context and native cumulative totals together in one click", async () => {
  render(usageView(usage));
  fireEvent.click(usageTrigger());
  const dialog = await screen.findByRole("dialog", {
    name: i18n.t("sessionUsage"),
  });
  const details = within(dialog);
  expect(details.getByText("5.3%")).toBeTruthy();
  expect(details.getByText("6,841")).toBeTruthy();
  expect(details.getByText("6,835")).toBeTruthy();
  // Pi's total includes cache usage; do not replace it with input + output.
  expect(details.getByText("7,141")).toBeTruthy();
  expect(details.getByText(i18n.t("usageTotalLabel"))).toBeTruthy();
  expect(details.getByText("fixture-workspace")).toBeTruthy();
  expect(details.getByText(i18n.t("usageTotalsHelp"))).toBeTruthy();
  const identity = details.getByText("fixture-session-id").closest("details");
  expect(identity?.open).toBe(false);
  fireEvent.click(details.getByText(i18n.t("usageSessionId")));
  expect(identity?.open).toBe(true);
});

it.each([
  { tokens: null, percent: null, expected: "unknown", progress: false },
  { tokens: 0, percent: 0, expected: "0%", progress: true },
])(
  "distinguishes $expected context from a missing reading",
  async (reading) => {
    render(
      usageView({
        ...usage,
        context: {
          tokens: reading.tokens,
          percent: reading.percent,
          contextWindow: 128_000,
        },
      }),
    );
    const expected =
      reading.expected === "unknown"
        ? i18n.t("usageUnknown")
        : reading.expected;
    const trigger = screen.getByRole("button", {
      name: i18n.t("usageOpenDetails", {
        input: "7k",
        output: "6",
        percent: expected,
        capacity: "128k",
      }),
    });
    expect(trigger.textContent).toContain(`${expected} / 128k`);
    fireEvent.click(trigger);
    const dialog = within(
      await screen.findByRole("dialog", { name: i18n.t("sessionUsage") }),
    );
    expect(Boolean(dialog.queryByRole("progressbar"))).toBe(reading.progress);
  },
);

it("does not invent statistics before Pi reports usage", () => {
  const view = render(usageView(usage));
  view.rerender(usageView(undefined));
  expect(screen.queryByRole("button")).toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("closes from the visible control and returns focus to the usage strip", async () => {
  render(usageView(usage));
  const trigger = usageTrigger();
  trigger.focus();
  fireEvent.click(trigger);
  const dialog = await screen.findByRole("dialog", {
    name: i18n.t("sessionUsage"),
  });
  fireEvent.click(
    within(dialog).getByRole("button", { name: i18n.t("close") }),
  );
  await waitFor(() =>
    expect(trigger.getAttribute("aria-expanded")).toBe("false"),
  );
  expect(document.activeElement).toBe(trigger);
  expect(screen.queryByRole("dialog")).toBeNull();
});
