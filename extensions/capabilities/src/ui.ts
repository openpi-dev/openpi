import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorComponent } from "@earendil-works/pi-tui";
import {
  BelowEditorNavigationEditor,
  BelowEditorStripState,
} from "../../shared/below-editor-navigation.ts";
import { capabilitiesRequestedByPrompt } from "../../shared/capability-intent.ts";

const DELEGATE_NAMES = /\bsubagents?\b|子代理/giu;
const WORKFLOW_NAMES = /\bworkflows?\b|工作流/giu;
const FOREGROUND_RESET = "\u001b[39m";

interface CapabilityKeywordColorOptions {
  readonly colorMode: "truecolor" | "256color";
  readonly light: boolean;
}

export function isLightNamedTheme(name: string | undefined) {
  return name !== undefined && /(?:^|[-_])light(?:$|[-_])/iu.test(name);
}

/**
 * Claude-style lavender keyword color. The light variant preserves readable
 * contrast instead of mechanically reusing the bright dark-terminal swatch.
 */
export function colorCapabilityKeyword(
  text: string,
  options: CapabilityKeywordColorOptions,
) {
  const start = options.light
    ? options.colorMode === "truecolor"
      ? "\u001b[38;2;130;80;223m"
      : "\u001b[38;5;98m"
    : options.colorMode === "truecolor"
      ? "\u001b[38;2;210;168;255m"
      : "\u001b[38;5;183m";
  return `${start}${text}${FOREGROUND_RESET}`;
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
