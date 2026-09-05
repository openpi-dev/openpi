import { Theme } from "@astryxdesign/core/theme";
import { neutralTheme } from "@astryxdesign/theme-neutral/built";
import type { PropsWithChildren } from "react";
import { I18nextProvider } from "react-i18next";
import { i18n } from "../i18n.ts";

export function Providers({ children }: PropsWithChildren) {
  return (
    <I18nextProvider i18n={i18n}>
      <Theme theme={neutralTheme} mode="light">
        {children}
      </Theme>
    </I18nextProvider>
  );
}
