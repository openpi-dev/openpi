import { homedir } from "node:os";
import { relative } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  ReadonlyFooterDataProvider,
} from "@earendil-works/pi-coding-agent";
import {
  getCapabilities,
  hyperlink,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { loadSetupConfig, type FooterItem } from "../shared/setup-config.ts";
import {
  emptyGitInfoState,
  emptyModelInfoState,
  GIT_INFO_CHANNEL,
  MODEL_INFO_CHANNEL,
  REFRESH_CHANNEL,
  isGitInfoState,
  isModelInfoState,
  type GitInfoState,
  type ModelInfoState,
} from "../shared/dashboard-state.ts";

type Rgb = [number, number, number];

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const PALETTE: Rgb[] = [
  [22, 83, 189],
  [48, 129, 247],
  [93, 171, 255],
  [151, 205, 255],
  [93, 171, 255],
  [48, 129, 247],
];
const TITLE_LINES = [
  "  ██████╗  ██╗ ",
  "  ██╔══██╗ ██║ ",
  "  ██████╔╝ ██║ ",
  "  ██╔═══╝  ██║ ",
  "  ██║      ██║ ",
  "  ╚═╝      ╚═╝ ",
];
// eslint-disable-next-line no-control-regex
const OSC_PATTERN =
  /(?:\u001b\]|\u009d)(?:[^\u0007\u001b\u009c]|\u001b(?!\\))*(?:\u0007|\u001b\\|\u009c)/g;
// eslint-disable-next-line no-control-regex
const CSI_PATTERN = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const ESCAPE_PATTERN = /\u001b(?:[()][0-2A-Z]|[ -/]*[@-~])/g;

function sanitizeTerminalLabel(text: string) {
  return text
    .replace(OSC_PATTERN, "")
    .replace(CSI_PATTERN, "")
    .replace(ESCAPE_PATTERN, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
}

function mix(a: number, b: number, amount: number) {
  return Math.round(a + (b - a) * amount);
}

function sampleGradient(position: number) {
  const wrapped = ((position % 1) + 1) % 1;
  const scaled = wrapped * PALETTE.length;
  const index = Math.floor(scaled);
  const nextIndex = (index + 1) % PALETTE.length;
  const amount = scaled - index;
  const start = PALETTE[index]!;
  const end = PALETTE[nextIndex]!;

  return [
    mix(start[0], end[0], amount),
    mix(start[1], end[1], amount),
    mix(start[2], end[2], amount),
  ] satisfies Rgb;
}

function foreground([red, green, blue]: Rgb, text: string) {
  return `\x1b[38;2;${red};${green};${blue}m${text}${RESET}`;
}

function gradientText(text: string, phase: number) {
  const characters = [...text];
  const span = Math.max(characters.length - 1, 1);

  return characters
    .map((character, index) =>
      character === " "
        ? character
        : foreground(sampleGradient(index / span + phase), character),
    )
    .join("");
}

function formatTokens(tokens: number) {
  if (tokens < 1_000) return `${tokens}`;
  if (tokens < 1_000_000) return `${Math.round(tokens / 1_000)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}m`;
}

function formatDirectory(cwd: string) {
  const home = homedir();
  if (cwd === home) return "~";
  const display = cwd.startsWith(`${home}/`) ? `~/${relative(home, cwd)}` : cwd;
  return sanitizeTerminalLabel(display);
}

function center(text: string, width: number) {
  const padding = Math.max(0, Math.floor((width - visibleWidth(text)) / 2));
  return truncateToWidth(`${" ".repeat(padding)}${text}`, width);
}

export function buildFooterContent(
  modelInfo: ModelInfoState,
  gitInfo: GitInfoState,
  selectedItems: readonly FooterItem[],
  formatPullRequest: (number: number, url: string) => string = (number) =>
    `PR #${number}`,
) {
  const items = new Set(selectedItems);
  const contextWindow =
    modelInfo.contextWindow > 0 ? formatTokens(modelInfo.contextWindow) : "";
  const context =
    modelInfo.contextPercent === null
      ? contextWindow
        ? `ctx ${contextWindow}`
        : ""
      : `${Math.round(modelInfo.contextPercent)}%${contextWindow ? `/${contextWindow}` : ""}`;
  const throughput =
    modelInfo.tokensPerSecond === null
      ? "— tok/s"
      : `~${Math.round(modelInfo.tokensPerSecond)} tok/s`;

  return {
    showCwd: items.has("cwd"),
    model: [
      items.has("model")
        ? modelInfo.provider
          ? `${modelInfo.provider}/${modelInfo.modelId}`
          : modelInfo.modelId
        : "",
      items.has("thinking") ? modelInfo.thinking : "",
    ]
      .filter(Boolean)
      .join(" · "),
    usage: [
      items.has("context") ? context : "",
      items.has("cache") && modelInfo.cachePercent !== null
        ? `cache ${Math.round(modelInfo.cachePercent)}%`
        : "",
      items.has("cost") ? `$${modelInfo.cost.toFixed(2)}` : "",
      items.has("throughput") ? throughput : "",
    ]
      .filter(Boolean)
      .join(" · "),
    git: [
      items.has("git") ? (gitInfo.branch ?? "") : "",
      items.has("pr") && gitInfo.pullRequest
        ? formatPullRequest(gitInfo.pullRequest.number, gitInfo.pullRequest.url)
        : "",
    ]
      .filter(Boolean)
      .join(" · "),
    showActivity: items.has("activity"),
  };
}

function columns(left: string, right: string, width: number) {
  if (!right) return truncateToWidth(left, width);

  const naturalGap = width - visibleWidth(left) - visibleWidth(right);
  if (naturalGap >= 1) return `${left}${" ".repeat(naturalGap)}${right}`;

  const leftWidth = Math.max(1, Math.floor(width * 0.45));
  const rightWidth = Math.max(1, width - leftWidth - 1);
  const fittedLeft = truncateToWidth(left, leftWidth);
  const fittedRight = truncateToWidth(right, rightWidth);
  const gap = Math.max(
    1,
    width - visibleWidth(fittedLeft) - visibleWidth(fittedRight),
  );
  return truncateToWidth(
    `${fittedLeft}${" ".repeat(gap)}${fittedRight}`,
    width,
  );
}

export default function uiCustomization(pi: ExtensionAPI) {
  let title = "pi";
  let modelInfo = emptyModelInfoState();
  let gitInfo = emptyGitInfoState();
  let requestRender: (() => void) | undefined;

  const stopModelListener = pi.events.on(MODEL_INFO_CHANNEL, (value) => {
    if (!isModelInfoState(value)) return;
    modelInfo = value;
    requestRender?.();
  });

  const stopGitListener = pi.events.on(GIT_INFO_CHANNEL, (value) => {
    if (!isGitInfoState(value)) return;
    gitInfo = value;
    requestRender?.();
  });

  function install(ctx: ExtensionContext) {
    if (ctx.mode !== "tui") return;
    const config = loadSetupConfig().ui;

    if (config.showHeader) {
      ctx.ui.setHeader((tui) => {
        requestRender = () => tui.requestRender();

        return {
          render(width: number) {
            const art = TITLE_LINES.map((line, row) =>
              center(gradientText(line, row * 0.045), width),
            );
            const subtitle = center(
              `${BOLD}${gradientText(title, 0.18)}${RESET}`,
              width,
            );
            return ["", ...art, subtitle, ""];
          },
          invalidate() {},
        };
      });
    } else {
      ctx.ui.setHeader(undefined);
    }

    if (config.customFooter) {
      ctx.ui.setFooter((tui, theme, footerData: ReadonlyFooterDataProvider) => {
        requestRender = () => tui.requestRender();

        return {
          invalidate() {},
          render(width: number) {
            const content = buildFooterContent(
              modelInfo,
              gitInfo,
              config.footerItems,
              (number, url) => {
                const label = `PR #${number}`;
                return getCapabilities().hyperlinks
                  ? hyperlink(label, url)
                  : label;
              },
            );
            const directory = content.showCwd
              ? theme.fg("text", formatDirectory(ctx.cwd))
              : "";

            const lines: string[] = [];
            const top = columns(
              directory,
              theme.fg("muted", content.model),
              width,
            );
            if (top) lines.push(top);
            const bottom = columns(
              theme.fg("muted", content.usage),
              theme.fg("muted", content.git),
              width,
            );
            if (bottom) lines.push(bottom);

            if (content.showActivity) {
              const statuses = footerData.getExtensionStatuses();
              const statusLines = Array.from(statuses.entries())
                .sort(([a], [b]) => a.localeCompare(b))
                .flatMap(([, text]) => text.split("\n"));
              for (const statusLine of statusLines) {
                lines.push(
                  truncateToWidth(statusLine, width, theme.fg("dim", "...")),
                );
              }
            }

            return lines;
          },
        };
      });
    } else {
      ctx.ui.setFooter(undefined);
    }

    ctx.ui.setTitle(`pi · ${title}`);
    pi.events.emit(REFRESH_CHANNEL, undefined);
  }

  pi.on("session_start", (_event, ctx) => {
    title = formatDirectory(ctx.cwd);
    modelInfo = emptyModelInfoState();
    gitInfo = emptyGitInfoState();
    install(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    stopModelListener();
    stopGitListener();
    requestRender = undefined;
    if (ctx.mode === "tui") {
      ctx.ui.setHeader(undefined);
      ctx.ui.setFooter(undefined);
    }
  });
}
