// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  DEFAULT_SETUP_CONFIG,
  DEFAULT_WEB_APPEARANCE,
} from "../../extensions/shared/setup-config.ts";
import { projectWebSetupConfig } from "../../web/runtime/settings-catalog.ts";
import { useSettingsCatalog } from "../../web/ui/src/features/settings/useSettingsCatalog.ts";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("refreshes another browser's preferences and ignores a read started before a confirmed write", async () => {
  const catalog = {
    sessionId: "session-a",
    setup: projectWebSetupConfig(DEFAULT_SETUP_CONFIG),
    resources: {
      skills: [],
      plugins: [],
      totals: { extensions: 0, skills: 0, prompts: 0, themes: 0 },
      diagnostics: { extensionErrors: 0, skillErrors: 0 },
      truncation: {
        truncated: false,
        skillsOmitted: 0,
        pluginsOmitted: 0,
        resourcesOmitted: 0,
      },
    },
  };
  let release!: (response: Response) => void;
  let reads = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      reads++;
      if (reads === 2)
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      return new Response(JSON.stringify(catalog));
    }),
  );
  const { result, rerender } = renderHook(
    ({ preferences }) => useSettingsCatalog("session-a", "model", preferences),
    { initialProps: { preferences: "initial" } },
  );
  await waitFor(() =>
    expect(result.current.catalog?.setup.ui.webTheme).toBe("system"),
  );
  act(() => result.current.refresh());
  await waitFor(() => expect(reads).toBe(2));
  const saved = {
    ...catalog.setup,
    ui: { ...catalog.setup.ui, webTheme: "dark" as const },
  };
  act(() => result.current.updateSetup(saved));
  await act(async () => {
    release(new Response(JSON.stringify(catalog)));
  });
  expect(result.current.catalog?.setup.ui.webTheme).toBe("dark");
  catalog.setup = {
    ...saved,
    ui: {
      ...saved.ui,
      webAppearance: {
        ...DEFAULT_WEB_APPEARANCE,
        ...saved.ui.webAppearance,
        font: "serif",
      },
    },
  };
  rerender({ preferences: "another-window-saved" });
  await waitFor(() =>
    expect(result.current.catalog?.setup.ui.webAppearance?.font).toBe("serif"),
  );
  expect(reads).toBe(3);
});
