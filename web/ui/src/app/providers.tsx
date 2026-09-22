import { Theme } from "@astryxdesign/core/theme";
import { neutralTheme } from "@astryxdesign/theme-neutral/built";
import { type PropsWithChildren, useEffect, useState } from "react";
import { I18nextProvider } from "react-i18next";
import { useStore } from "zustand";
import { i18n } from "../i18n.ts";
import { webStore } from "../store/web-store.ts";

export function Providers({ children }: PropsWithChildren) {
  const preferences = useStore(
    webStore,
    (state) => state.snapshot?.preferences,
  );
  const preference = preferences?.theme ?? "system";
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
    root.style.setProperty("--conversation-content-width", `${chatWidth}px`);
    root.style.setProperty("--conversation-font-size", `${chatFontSize}px`);
  }, [chatFontSize, chatWidth, resolvedTheme]);
  return (
    <I18nextProvider i18n={i18n}>
      <Theme theme={neutralTheme} mode={mode}>
        {children}
      </Theme>
    </I18nextProvider>
  );
}
