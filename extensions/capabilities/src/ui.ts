import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { getCapabilities, type EditorComponent } from "@earendil-works/pi-tui";
import {
  BelowEditorNavigationEditor,
  BelowEditorStripState,
} from "../../shared/below-editor-navigation.ts";
import { capabilitiesRequestedByPrompt } from "../../shared/capability-intent.ts";

const DELEGATE_NAMES = /\bsubagents?\b|子代理/giu;
const WORKFLOW_NAMES = /\bworkflows?\b|工作流/giu;
const FOREGROUND_RESET = "\u001b[39m";
const SHIMMER_PERIOD_MS = 1_400;

type Rgb = readonly [number, number, number];

const DARK_SHIMMER_BASE: Rgb = [177, 119, 233];
const DARK_SHIMMER_HIGHLIGHT: Rgb = [255, 232, 255];
const LIGHT_SHIMMER_BASE: Rgb = [91, 48, 173];
const LIGHT_SHIMMER_HIGHLIGHT: Rgb = [205, 171, 255];
const DARK_STATIC_PURPLE: Rgb = [210, 168, 255];
const LIGHT_STATIC_PURPLE: Rgb = [130, 80, 223];

/** Keep editor animation cadence aligned with the package's other TUI motion. */
export const CAPABILITY_SHIMMER_INTERVAL_MS = 120;

interface CapabilityKeywordColorOptions {
  readonly colorMode: "truecolor" | "256color";
  readonly light: boolean;
  readonly animated?: boolean;
  /** A normalized position in the shimmer cycle. Defaults to the first frame. */
  readonly phase?: number;
}

interface CapabilityShimmerTerminal {
  readonly isTTY?: boolean;
  readonly term?: string;
  readonly trueColor: boolean;
}

/**
 * Dynamic color updates need an interactive terminal with a known color
 * capability. A 256-color terminal remains eligible; color mode alone is not
 * used as the animation decision.
 */
export function supportsDynamicCapabilityShimmer(
  terminal: CapabilityShimmerTerminal = {
    isTTY: process.stdout.isTTY,
    term: process.env.TERM,
    trueColor: getCapabilities().trueColor,
  },
) {
  const term = terminal.term?.toLowerCase();
  if (terminal.isTTY === false || term === "dumb") return false;
  return terminal.trueColor || term?.includes("256color") === true;
}

export function isLightNamedTheme(name: string | undefined) {
  return name !== undefined && /(?:^|[-_])light(?:$|[-_])/iu.test(name);
}

function mix(a: number, b: number, amount: number) {
  return Math.round(a + (b - a) * amount);
}

function shimmerIntensity(index: number, length: number, phase: number) {
  const position = length <= 1 ? 0.5 : index / (length - 1);
  const distance = Math.abs(position - phase);
  const wrappedDistance = Math.min(distance, 1 - distance);
  const glow = Math.max(0, 1 - wrappedDistance / 0.35);
  return 0.2 + 0.8 * glow * glow;
}

function shimmerRgb(base: Rgb, highlight: Rgb, amount: number): Rgb {
  return [
    mix(base[0], highlight[0], amount),
    mix(base[1], highlight[1], amount),
    mix(base[2], highlight[2], amount),
  ];
}

function truecolorForeground([red, green, blue]: Rgb) {
  return `\u001b[38;2;${red};${green};${blue}m`;
}

function ansi256Foreground(light: boolean, intensity: number) {
  if (light) {
    return `\u001b[38;5;${intensity > 0.8 ? 147 : intensity > 0.5 ? 141 : 98}m`;
  }
  return `\u001b[38;5;${intensity > 0.8 ? 225 : intensity > 0.5 ? 189 : 183}m`;
}

function staticPurpleForeground(
  light: boolean,
  colorMode: CapabilityKeywordColorOptions["colorMode"],
) {
  return colorMode === "truecolor"
    ? truecolorForeground(light ? LIGHT_STATIC_PURPLE : DARK_STATIC_PURPLE)
    : ansi256Foreground(light, 0.2);
}

/** Claude-style purple shimmer. The light variant preserves readable contrast. */
export function colorCapabilityKeyword(
  text: string,
  options: CapabilityKeywordColorOptions,
) {
  if (options.animated === false) {
    return `${staticPurpleForeground(options.light, options.colorMode)}${text}${FOREGROUND_RESET}`;
  }
  const phase = (((options.phase ?? 0) % 1) + 1) % 1;
  const characters = [...text];
  const base = options.light ? LIGHT_SHIMMER_BASE : DARK_SHIMMER_BASE;
  const highlight = options.light
    ? LIGHT_SHIMMER_HIGHLIGHT
    : DARK_SHIMMER_HIGHLIGHT;

  return `${characters
    .map((character, index) => {
      const intensity = shimmerIntensity(index, characters.length, phase);
      const start =
        options.colorMode === "truecolor"
          ? truecolorForeground(shimmerRgb(base, highlight, intensity))
          : ansi256Foreground(options.light, intensity);
      return `${start}${character}`;
    })
    .join("")}${FOREGROUND_RESET}`;
}

export function capabilityShimmerPhase(now = Date.now()) {
  return (
    (((now % SHIMMER_PERIOD_MS) + SHIMMER_PERIOD_MS) % SHIMMER_PERIOD_MS) /
    SHIMMER_PERIOD_MS
  );
}

export function highlightCapabilityNames(
  line: string,
  capabilities: readonly string[],
  highlight: (text: string) => string,
) {
  let result = line;
  if (capabilities.includes("delegate")) {
    result = result.replace(DELEGATE_NAMES, (match) => highlight(match));
  }
  if (capabilities.includes("workflow")) {
    result = result.replace(WORKFLOW_NAMES, (match) => highlight(match));
  }
  return result;
}

/**
 * Transparent, pre-submit feedback for capability intent. It colours only
 * names whose capability the shared classifier would load after submission;
 * it never changes editor text, Session history, or model context.
 */
export class CapabilityIntentHighlightEditor extends BelowEditorNavigationEditor {
  private readonly highlight: (text: string) => string;

  constructor(
    base: EditorComponent,
    keybindings: KeybindingsManager,
    highlight: (text: string) => string,
  ) {
    super(
      base,
      keybindings,
      new BelowEditorStripState(),
      () => false,
      () => undefined,
      () => undefined,
    );
    this.highlight = highlight;
  }

  hasCapabilityIntent() {
    const capabilities = capabilitiesRequestedByPrompt(this.getText());
    return (
      capabilities.includes("delegate") || capabilities.includes("workflow")
    );
  }

  override render(width: number) {
    const capabilities = capabilitiesRequestedByPrompt(this.getText());
    if (
      !capabilities.includes("delegate") &&
      !capabilities.includes("workflow")
    ) {
      return super.render(width);
    }
    return super
      .render(width)
      .map((line) =>
        highlightCapabilityNames(line, capabilities, this.highlight),
      );
  }
}
