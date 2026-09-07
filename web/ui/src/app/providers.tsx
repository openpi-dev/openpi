import { Theme } from "@astryxdesign/core/theme";
import { neutralTheme } from "@astryxdesign/theme-neutral/built";
import { type PropsWithChildren, useEffect, useState } from "react";
import { I18nextProvider } from "react-i18next";
import { useStore } from "zustand";
import { i18n } from "../i18n.ts";
import { webStore } from "../store/web-store.ts";

export function Providers({ children }: PropsWithChildren) {
  const preference =
    useStore(webStore, (state) => state.snapshot?.preferences?.theme) ??
    "system";
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
  const mode =
    preference === "dark" || (preference === "system" && systemDark)
      ? "dark"
      : "light";
  useEffect(() => {
    document.documentElement.dataset.theme = mode;
  }, [mode]);
  return (
    <I18nextProvider i18n={i18n}>
      <Theme theme={neutralTheme} mode={mode}>
        {children}
      </Theme>
    </I18nextProvider>
  );
}
