import { Theme } from "@astryxdesign/core/theme";
import { neutralTheme } from "@astryxdesign/theme-neutral/built";
import { type PropsWithChildren, useEffect, useState } from "react";
import { I18nextProvider } from "react-i18next";
import { useStore } from "zustand";
import { i18n } from "../i18n.ts";
import {
  appearancePalette,
  defaultAppearance,
} from "../features/settings/appearance.ts";
import { webStore } from "../store/web-store.ts";

export function Providers({ children }: PropsWithChildren) {
  const preferences = useStore(
    webStore,
    (state) => state.snapshot?.preferences,
  );
  const preference = preferences?.theme ?? "system";
  const appearance = preferences?.appearance ?? defaultAppearance;
  const palette = appearancePalette(preference, appearance);
  const chatWidth = preferences?.chatWidth ?? 820;
  const chatFontSize = preferences?.chatFontSize ?? 14;
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false,
  );
  useEffect(() => {
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!media) return;
    const update = () => setSystemDark(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const resolvedTheme =
    preference === "system" ? (systemDark ? "dark" : "light") : preference;
  const mode =
    resolvedTheme === "dark" || resolvedTheme === "pine" ? "dark" : "light";
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = resolvedTheme;
    root.dataset.palette = palette;
    root.style.setProperty("--conversation-content-width", `${chatWidth}px`);
    root.style.setProperty("--conversation-font-size", `${chatFontSize}px`);
    const colors: Record<string, string> = {};
    if (appearance.background) colors["--page"] = appearance.background;
    if (appearance.foreground) colors["--text"] = appearance.foreground;
    if (appearance.background || appearance.foreground) {
      for (const [name, amount] of Object.entries({
        sidebar: 3,
        "sidebar-hover": 7,
        "sidebar-active": 10,
        border: 12,
        "border-strong": 22,
        muted: 65,
        subtle: 52,
        "settings-secondary-text": 75,
      })) {
        colors[`--${name}`] =
          `color-mix(in srgb, var(--text) ${amount}%, var(--page))`;
      }
    }
    if (appearance.accent) {
      colors["--accent"] = appearance.accent;
      colors["--focus"] = appearance.accent;
    }
    const families = {
      codex: "var(--openpi-default-font)",
      system: "var(--openpi-default-font)",
      sans: "Arial, Helvetica, sans-serif",
      serif: "Georgia, 'Times New Roman', serif",
      mono: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    };
    root.style.setProperty(
      "--openpi-interface-font",
      families[appearance.font],
    );
    const names = [
      "page",
      "text",
      "sidebar",
      "sidebar-hover",
      "sidebar-active",
      "border",
      "border-strong",
      "muted",
      "subtle",
      "settings-secondary-text",
      "accent",
      "focus",
    ];
    for (const name of names) {
      const value = colors[`--${name}`];
      if (value) root.style.setProperty(`--${name}`, value);
      else root.style.removeProperty(`--${name}`);
    }
  }, [appearance, chatFontSize, chatWidth, palette, resolvedTheme]);
  return (
    <I18nextProvider i18n={i18n}>
      <Theme theme={neutralTheme} mode={mode}>
        {children}
      </Theme>
    </I18nextProvider>
  );
}
