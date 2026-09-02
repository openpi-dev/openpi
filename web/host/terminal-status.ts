interface WebReadyScreenOptions {
  origin: string;
  url: string;
  opened: boolean;
  color?: boolean;
}

const ANSI = {
  accent: "\u001b[36m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  green: "\u001b[32m",
  reset: "\u001b[0m",
};

export function formatWebReadyScreen(options: WebReadyScreenOptions) {
  const color =
    options.color ?? (process.stdout.isTTY === true && !("NO_COLOR" in process.env));
  const paint = (codes: string, text: string) =>
    color ? `${codes}${text}${ANSI.reset}` : text;
  const label = (text: string) => paint(ANSI.dim, text.padEnd(12));
  const rows = [
    "",
    `${paint(`${ANSI.bold}${ANSI.accent}`, "OpenPI Web Workbench")}  ${paint(ANSI.green, "ready")}`,
    paint(
      ANSI.dim,
      "Local, authenticated, and isolated from the terminal Pi Session.",
    ),
    "",
    `${label("Local")} ${options.origin}`,
    `${label("Workspaces")} choose and switch in the browser`,
    `${label("Sessions")} separate from terminal Pi`,
    `${label("Browser")} ${options.opened ? "opened" : "not opened"}`,
  ];
  if (!options.opened) rows.push(`${label("Open")} ${options.url}`);
  rows.push("", `${paint(ANSI.bold, "Ctrl+C")}  stop`, "");
  return rows.join("\n");
}
