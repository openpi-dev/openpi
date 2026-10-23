// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { Providers } from "../../web/ui/src/app/providers.tsx";
import { RuntimeInfoPanel } from "../../web/ui/src/features/settings/RuntimeInfoPanel.tsx";
import { i18n } from "../../web/ui/src/i18n.ts";
import { WebClient } from "../../web/ui/src/protocol/client.ts";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("distinguishes loaded page identity from the backend startup snapshot without changing configuration", async () => {
  vi.stubGlobal("__OPENPI_WEB_BUILD__", {
    version: "2.0.0",
    id: "new-page",
    mode: "production",
  });
  const request = vi.spyOn(WebClient.prototype, "request").mockResolvedValue({
    openpi: {
      version: "1.0.0",
      packageRoot: "/source/openpi",
      startedAt: "2026-10-22T00:00:00Z",
      git: { revision: "startup-revision", dirty: true },
      frontendAtStartup: { id: "old-page" },
    },
  });
  render(createElement(Providers, null, createElement(RuntimeInfoPanel)));
  await screen.findByText("/source/openpi");
  expect(screen.getByText("new-page")).toBeTruthy();
  expect(screen.getByText("old-page")).toBeTruthy();
  expect(screen.getByText("startup-revision")).toBeTruthy();
  expect(screen.getByText(i18n.t("runtimeGitDirty"))).toBeTruthy();
  expect(screen.getByText(i18n.t("runtimeBuildMismatch"))).toBeTruthy();
  expect(request).toHaveBeenCalledTimes(1);
  expect(request.mock.calls[0]?.[0]).toBe("/api/diagnostics");
  expect(request.mock.calls[0]?.[1]?.method).toBeUndefined();
});

it("leaves unavailable or older-server provenance unknown and allows retry after a failed read", async () => {
  const request = vi
    .spyOn(WebClient.prototype, "request")
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue({ node: "v22" });
  render(createElement(Providers, null, createElement(RuntimeInfoPanel)));
  await screen.findByRole("alert");
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("refreshStatus") }),
  );
  await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(screen.getAllByText(i18n.t("notReported"))).toHaveLength(8);
  expect(screen.queryByText(i18n.t("runtimeGitClean"))).toBeNull();
});
