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
import {
  loadSetupConfig,
  SETUP_CONFIG_CHANGED_CHANNEL,
} from "../shared/setup-config.ts";
import {
  emptyGitInfoState,
  emptyModelInfoState,
  GIT_INFO_CHANNEL,
  MODEL_INFO_CHANNEL,
  REFRESH_CHANNEL,
  isGitInfoState,
  isModelInfoState,
} from "../shared/dashboard-state.ts";
import { formatDirectory, renderFooter } from "./footer.ts";

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

function center(text: string, width: number) {
  const padding = Math.max(0, Math.floor((width - visibleWidth(text)) / 2));
  return truncateToWidth(`${" ".repeat(padding)}${text}`, width);
}

export default function uiCustomization(pi: ExtensionAPI) {
  let title = "pi";
  let modelInfo = emptyModelInfoState();
  let gitInfo = emptyGitInfoState();
  let requestRender: (() => void) | undefined;
  let activeSession: ExtensionContext | undefined;

  let stopModelListener: (() => void) | undefined;
  let stopGitListener: (() => void) | undefined;

  const stopDashboardListeners = () => {
    stopModelListener?.();
    stopGitListener?.();
    stopModelListener = undefined;
    stopGitListener = undefined;
  };

  const startDashboardListeners = () => {
    stopDashboardListeners();
    stopModelListener = pi.events.on(MODEL_INFO_CHANNEL, (value) => {
      if (!isModelInfoState(value)) return;
      modelInfo = value;
      requestRender?.();
    });
    stopGitListener = pi.events.on(GIT_INFO_CHANNEL, (value) => {
      if (!isGitInfoState(value)) return;
      gitInfo = value;
      requestRender?.();
    });
  };

  // Kept for process lifetime so configure_my_pi_setup still refreshes later sessions.
  pi.events.on(SETUP_CONFIG_CHANGED_CHANNEL, () => {
    if (!activeSession || activeSession.mode !== "tui") return;
    install(activeSession);
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
            const statuses = footerData.getExtensionStatuses();
            const statusLines = Array.from(statuses.entries())
              .sort(([a], [b]) => a.localeCompare(b))
              .flatMap(([, text]) => text.split("\n"));

            return renderFooter({
              cwd: ctx.cwd,
              modelInfo,
              gitInfo,
              style: config.footerStyle,
              lines: config.footerLines,
              width,
              theme,
              formatPullRequest: (number, url) => {
                const label = `PR #${number}`;
                return getCapabilities().hyperlinks
                  ? hyperlink(label, url)
                  : label;
              },
              statuses: statusLines,
            });
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
    activeSession = ctx;
    startDashboardListeners();
    install(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    // Drop the session pointer first so a late config event cannot reinstall
    // against a shut-down context. The config listener stays armed for later sessions.
    activeSession = undefined;
    stopDashboardListeners();
    requestRender = undefined;
    if (ctx.mode === "tui") {
      ctx.ui.setHeader(undefined);
      ctx.ui.setFooter(undefined);
    }
  });
}
