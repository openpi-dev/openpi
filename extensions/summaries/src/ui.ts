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
  constructor(data: RecapEntryData, theme: Theme) {
    this.data = data;
    this.theme = theme;
  }

  render(width: number) {
    const box = new Box(1, 0, (text) => this.theme.bg("customMessageBg", text));
    box.addChild(
      new Markdown(`Recap: ${this.data.recap}`, 0, 0, getMarkdownTheme(), {
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
    return box.render(width);
  }

  invalidate() {}
}

export function renderRecap(
  data: RecapEntryData | undefined,
  _expanded: boolean,
  theme: Theme,
) {
  if (!data)
    return new Text(theme.fg("warning", "Run recap unavailable"), 0, 0);
  return new RecapCard(data, theme);
}
