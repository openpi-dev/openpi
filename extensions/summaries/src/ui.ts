import type { Theme } from "@earendil-works/pi-coding-agent";
import { Markdown, Text, type MarkdownTheme } from "@earendil-works/pi-tui";
import type { ReasoningLevel } from "./config.ts";
import type { RunRecap } from "./summarizer.ts";

export interface RecapEntryData extends RunRecap {
  readonly provider: string;
  readonly model: string;
  readonly reasoning: ReasoningLevel;
  readonly fallback?: boolean;
}

function subduedMarkdownTheme(theme: Theme): MarkdownTheme {
  const dim = (text: string) => theme.fg("dim", text);
  return {
    heading: (text) => dim(theme.bold(text)),
    link: (text) => dim(theme.underline(text)),
    linkUrl: dim,
    code: (text) => dim(theme.italic(text)),
    codeBlock: dim,
    codeBlockBorder: dim,
    quote: dim,
    quoteBorder: dim,
    hr: dim,
    listBullet: dim,
    bold: (text) => dim(theme.bold(text)),
    italic: (text) => dim(theme.italic(text)),
    strikethrough: (text) => dim(theme.strikethrough(text)),
    underline: (text) => dim(theme.underline(text)),
  };
}

class RecapCard {
  private readonly data: RecapEntryData;
  private readonly theme: Theme;

  constructor(data: RecapEntryData, theme: Theme) {
    this.data = data;
    this.theme = theme;
  }

  render(width: number) {
    const content = [
      `※ **recap:** ${this.data.recap}`,
      ...(this.data.next ? [`※ **next:** ${this.data.next}`] : []),
    ].join("\n");
    return new Markdown(content, 0, 0, subduedMarkdownTheme(this.theme), {
      color: (text) => this.theme.fg("dim", text),
    }).render(width);
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
