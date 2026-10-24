import type {
  WebAppearancePreference,
  WebThemePreference,
} from "../../../../protocol/types.ts";

export const appearancePalettes = ["default", "mist", "rose", "pine"] as const;
export const appearanceFonts = ["codex", "sans", "serif", "mono"] as const;
export const appearanceModes = ["system", "light", "dark"] as const;
export const defaultAppearance: WebAppearancePreference = {
  palette: "default",
  accent: "",
  background: "",
  foreground: "",
  font: "codex",
};

export function appearanceMode(theme: WebThemePreference) {
  return theme === "pine"
    ? "dark"
    : theme === "mist" || theme === "rose"
      ? "light"
      : theme;
}

export function appearancePalette(
  theme: WebThemePreference,
  appearance: WebAppearancePreference,
) {
  return theme === "mist" || theme === "rose" || theme === "pine"
    ? theme
    : appearance.palette;
}

export function appearanceColors(
  palette: WebAppearancePreference["palette"],
  dark: boolean,
) {
  switch (palette) {
    case "mist":
      return dark
        ? {
            background: "#182126",
            foreground: "#EDF3F5",
            sidebar: "#1D292F",
            accent: "#7BB5CA",
          }
        : {
            background: "#F8FBFC",
            foreground: "#253239",
            sidebar: "#EEF3F5",
            accent: "#347991",
          };
    case "rose":
      return dark
        ? {
            background: "#211A1C",
            foreground: "#F4ECEC",
            sidebar: "#2A2123",
            accent: "#E09AA5",
          }
        : {
            background: "#FFF9F7",
            foreground: "#342729",
            sidebar: "#F6EDEA",
            accent: "#B45562",
          };
    case "pine":
      return dark
        ? {
            background: "#101A17",
            foreground: "#EAF2EC",
            sidebar: "#16241F",
            accent: "#86C89E",
          }
        : {
            background: "#F4F8F5",
            foreground: "#20352A",
            sidebar: "#E9F1EB",
            accent: "#32704A",
          };
    default:
      return dark
        ? {
            background: "#17191C",
            foreground: "#EDF0F2",
            sidebar: "#1D2024",
            accent: "#74A9E6",
          }
        : {
            background: "#FFFFFF",
            foreground: "#1A1C1F",
            sidebar: "#F6F7F9",
            accent: "#2563EB",
          };
  }
}

export function parseAppearanceTheme(value: string) {
  if (value.length > 2000) return null;
  try {
    const data: unknown = JSON.parse(value);
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    const record = data as Record<string, unknown>;
    if (
      Object.keys(record).sort().join(",") !== "appearance,theme,version" ||
      record.version !== 1
    )
      return null;
    const theme = appearanceModes.find((mode) => mode === record.theme);
    if (
      !theme ||
      !record.appearance ||
      typeof record.appearance !== "object" ||
      Array.isArray(record.appearance)
    )
      return null;
    const source = record.appearance as Record<string, unknown>;
    if (
      Object.keys(source).sort().join(",") !==
      "accent,background,font,foreground,palette"
    )
      return null;
    const palette = appearancePalettes.find((item) => item === source.palette);
    const font =
      source.font === "system"
        ? "codex"
        : appearanceFonts.find((item) => item === source.font);
    const { accent, background, foreground } = source;
    if (
      !palette ||
      !font ||
      typeof accent !== "string" ||
      typeof background !== "string" ||
      typeof foreground !== "string" ||
      ![accent, background, foreground].every(
        (color) => color === "" || /^#[0-9a-f]{6}$/iu.test(color),
      )
    )
      return null;
    return {
      theme,
      appearance: { palette, font, accent, background, foreground },
    };
  } catch {
    return null;
  }
}
