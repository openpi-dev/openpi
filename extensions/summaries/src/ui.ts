import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Text } from "@earendil-works/pi-tui";
import type { ReasoningLevel } from "./config.ts";
import type { RunRecap } from "./summarizer.ts";

export interface RecapEntryData extends RunRecap {
  readonly provider: string;
  readonly model: string;
  readonly reasoning: ReasoningLevel;
  readonly fallback?: boolean;
}

class RecapCard {
  private readonly data: RecapEntryData;
  private readonly theme: Theme;
  private readonly expanded: boolean;

  constructor(data: RecapEntryData, theme: Theme, expanded: boolean) {
    this.data = data;
    this.theme = theme;
    this.expanded = expanded;
  }

  render(width: number) {
    const box = new Box(1, 1, (text) => this.theme.bg("customMessageBg", text));
    const title =
      this.theme.fg("accent", "✦ ") +
      this.theme.fg("customMessageLabel", this.theme.bold("Run recap"));
    box.addChild(new Text(title, 0, 0));
    box.addChild(
      new Markdown(this.data.recap, 0, 1, getMarkdownTheme(), {
        color: (text) => this.theme.fg("customMessageText", text),
      }),
    );
    if (this.data.next) {
      box.addChild(
        new Text(
          `${this.theme.fg("accent", this.theme.bold("Next:"))} ${this.theme.fg("customMessageText", this.data.next)}`,
          0,
          0,
        ),
      );
    }
    if (this.expanded) {
      const source = `${this.data.provider}/${this.data.model} · ${this.data.reasoning}${this.data.fallback ? " · local fallback" : ""}`;
      box.addChild(new Text(this.theme.fg("dim", source), 0, 1));
    }
    return box.render(width);
  }

  invalidate() {}
}

export function renderRecap(
  data: RecapEntryData | undefined,
  expanded: boolean,
  theme: Theme,
) {
  if (!data)
    return new Text(theme.fg("warning", "Run recap unavailable"), 0, 0);
  return new RecapCard(data, theme, expanded);
}
