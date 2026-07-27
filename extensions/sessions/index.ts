// Adapted from pi-agent-extensions (MIT); see THIRD_PARTY_NOTICES.md.
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  DynamicBorder,
  SessionManager,
  keyHint,
} from "@earendil-works/pi-coding-agent";
import {
  CancellableLoader,
  Container,
  Key,
  SelectList,
  type SelectItem,
  Spacer,
  Text,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
  buildPreviewError,
  buildSessionDescription,
  buildSessionLabel,
  buildSessionPreview,
  buildSessionSearchEntries,
  filterSessionEntries,
  getSessionPaneLayout,
  parseLimit,
  type PreviewBlock,
  type SessionInfoLike,
  type SessionPreview,
  formatRelativeTime,
} from "./sessions.js";
import { execFile } from "node:child_process";

const DEFAULT_VISIBLE = 12;
const SNIPPET_MAX = 60;
const PREVIEW_LOAD_DEBOUNCE_MS = 50;

const isPrintable = (data: string): boolean => {
  if (data.length !== 1) return false;
  const code = data.charCodeAt(0);
  return code >= 32 && code !== 127;
};

const sortSessions = (sessions: SessionInfoLike[]): SessionInfoLike[] =>
  [...sessions].sort((a, b) => b.modified.getTime() - a.modified.getTime());

const formatPlainLine = (session: SessionInfoLike): string => {
  const label = buildSessionLabel(session);
  const description = buildSessionDescription(session, SNIPPET_MAX);
  return `${label}\t${description}`;
};

const padAnsiRight = (text: string, width: number): string => {
  const truncated = truncateToWidth(text, width, "");
  return `${truncated}${" ".repeat(Math.max(0, width - visibleWidth(truncated)))}`;
};

const themeText = (
  theme: {
    fg: (color: any, text: string) => string;
    bold: (text: string) => string;
    italic?: (text: string) => string;
  },
  kind:
    | "title"
    | "subtitle"
    | "rule"
    | "user"
    | "assistant"
    | "tool"
    | "error"
    | "muted"
    | "text"
    | "thinking",
  text: string,
): string => {
  if (kind === "title") return theme.fg("accent", theme.bold(text));
  if (kind === "subtitle") return theme.fg("dim", text);
  if (kind === "rule") return theme.fg("border", text);
  if (kind === "user") return theme.fg("accent", theme.bold(text));
  if (kind === "assistant") return theme.fg("warning", theme.bold(text));
  if (kind === "tool") return theme.fg("muted", theme.bold(text));
  if (kind === "error") return theme.fg("error", text);
  if (kind === "muted") return theme.fg("muted", text);
  if (kind === "thinking")
    return theme.italic
      ? theme.italic(theme.fg("dim", text))
      : theme.fg("dim", text);
  return theme.fg("text", text);
};

interface PreviewRenderOptions {
  toolsExpanded: boolean;
  thinkingVisible: boolean;
}

const splitLines = (text: string): string[] =>
  text.replace(/\r\n/g, "\n").split("\n");

const compactText = (
  text: string,
  maxLines: number,
): { lines: string[]; hidden: number } => {
  const lines = splitLines(text)
    .map((line) => line.replace(/\s+$/g, ""))
    .filter((line) => line.trim().length > 0);
  if (lines.length <= maxLines) return { lines, hidden: 0 };
  return { lines: lines.slice(0, maxLines), hidden: lines.length - maxLines };
};

const wrapStyled = (
  prefix: string,
  text: string,
  width: number,
  color: (line: string) => string,
): string[] => {
  const contentWidth = Math.max(1, width - visibleWidth(prefix));
  const wrapped = wrapTextWithAnsi(color(text), contentWidth);
  return wrapped.map((line) => `${prefix}${line}`);
};

const renderTextBlock = (
  label: string,
  text: string,
  width: number,
  theme: {
    fg: (color: any, text: string) => string;
    bold: (text: string) => string;
  },
  labelKind: "user" | "assistant" | "tool" | "muted" | "error" | "thinking",
): string[] => {
  const lines = [themeText(theme, labelKind, label)];
  for (const rawLine of splitLines(text)) {
    if (!rawLine.trim()) {
      lines.push("");
      continue;
    }
    lines.push(
      ...wrapStyled("  ", rawLine.trimEnd(), width, (line) =>
        theme.fg("text", line),
      ),
    );
  }
  return lines;
};

const isToolBlock = (block: PreviewBlock): boolean =>
  block.kind === "toolCall" ||
  block.kind === "toolResult" ||
  block.kind === "bash";

const summarizeToolRun = (blocks: PreviewBlock[]): string => {
  const names = new Set<string>();
  let outputLines = 0;
  let hasError = false;

  for (const block of blocks) {
    if (block.kind === "toolCall") names.add(block.name);
    if (block.kind === "toolResult") {
      if (block.name) names.add(block.name);
      outputLines += compactText(block.text, Number.MAX_SAFE_INTEGER).lines
        .length;
      hasError ||= !!block.isError;
    }
    if (block.kind === "bash") {
      names.add("bash");
      outputLines += compactText(block.output ?? "", Number.MAX_SAFE_INTEGER)
        .lines.length;
      hasError ||= !!block.isError;
    }
  }

  const nameList = Array.from(names).slice(0, 4).join(", ");
  const moreNames = names.size > 4 ? ` +${names.size - 4}` : "";
  const output = outputLines > 0 ? ` · ${outputLines} output lines` : "";
  return `${hasError ? "✖" : "▸"} Tool activity · ${blocks.length} events${nameList ? ` · ${nameList}${moreNames}` : ""}${output} (press t)`;
};

const renderPreviewBlock = (
  block: PreviewBlock,
  width: number,
  theme: {
    fg: (color: any, text: string) => string;
    bold: (text: string) => string;
    italic?: (text: string) => string;
  },
  options: PreviewRenderOptions,
): string[] => {
  if (block.kind === "notice") {
    return wrapTextWithAnsi(themeText(theme, "muted", block.text), width);
  }

  if (block.kind === "user") {
    return renderTextBlock("◆ User", block.text, width, theme, "user");
  }

  if (block.kind === "assistant") {
    return renderTextBlock(
      "● Assistant",
      block.text,
      width,
      theme,
      "assistant",
    );
  }

  if (block.kind === "thinking") {
    if (!options.thinkingVisible)
      return [themeText(theme, "thinking", "◌ Thinking hidden")];
    return renderTextBlock("◌ Thinking", block.text, width, theme, "thinking");
  }

  if (block.kind === "toolCall") {
    const header = `▸ Tool call · ${block.name}`;
    if (!options.toolsExpanded || !block.args)
      return [themeText(theme, "tool", header)];
    return [
      themeText(theme, "tool", header),
      ...wrapStyled("  ", block.args, width, (line) => theme.fg("muted", line)),
    ];
  }

  if (block.kind === "toolResult") {
    const label = `${block.isError ? "✖" : "▸"} Tool result${block.name ? ` · ${block.name}` : ""}`;
    const compact = compactText(block.text, options.toolsExpanded ? 200 : 4);
    const lines = [themeText(theme, block.isError ? "error" : "tool", label)];
    for (const line of compact.lines) {
      lines.push(
        ...wrapStyled("  ", line, width, (value) =>
          theme.fg(block.isError ? "error" : "muted", value),
        ),
      );
    }
    if (compact.hidden > 0)
      lines.push(
        theme.fg(
          "dim",
          `  … ${compact.hidden} output lines collapsed (press t to expand tools)`,
        ),
      );
    return lines;
  }

  if (block.kind === "bash") {
    const label = `${block.isError ? "✖" : "▸"} Bash`;
    const lines = [themeText(theme, block.isError ? "error" : "tool", label)];
    if (block.command)
      lines.push(
        ...wrapStyled("  ", `$ ${block.command}`, width, (line) =>
          theme.fg("accent", line),
        ),
      );
    const compact = compactText(
      block.output ?? "",
      options.toolsExpanded ? 200 : 4,
    );
    for (const line of compact.lines) {
      lines.push(
        ...wrapStyled("  ", line, width, (value) =>
          theme.fg(block.isError ? "error" : "muted", value),
        ),
      );
    }
    if (compact.hidden > 0)
      lines.push(
        theme.fg(
          "dim",
          `  … ${compact.hidden} output lines collapsed (press t to expand tools)`,
        ),
      );
    return lines;
  }

  if (block.kind === "summary") {
    return renderTextBlock(
      `◇ ${block.label}`,
      block.text,
      width,
      theme,
      "muted",
    );
  }

  return renderTextBlock(`◇ ${block.label}`, block.text, width, theme, "muted");
};

interface SessionStats {
  add: number;
  mod: number;
  del: number;
}

const statsCache = new Map<string, SessionStats>();
const statsLoading = new Set<string>();

const execGit = (args: string[], cwd: string): Promise<string> =>
  new Promise((resolve) => {
    execFile("git", args, { cwd, encoding: "utf8" }, (error, stdout) => {
      resolve(error ? "" : stdout);
    });
  });

const loadSessionStats = (
  session: SessionInfoLike,
  isLatestForCwd: boolean,
  tui: any,
) => {
  const key = session.path;
  if (statsCache.has(key) || statsLoading.has(key)) return;

  statsLoading.add(key);

  const after = session.created
    ? session.created.toISOString()
    : new Date(session.modified.getTime() - 24 * 3600 * 1000).toISOString();
  const before = session.modified.toISOString();
  Promise.all([
    execGit(
      [
        "log",
        `--after=${after}`,
        `--before=${before}`,
        "--numstat",
        "--pretty=format:",
      ],
      session.cwd,
    ),
    isLatestForCwd
      ? execGit(["diff", "--numstat"], session.cwd)
      : Promise.resolve(""),
  ]).then(([logOut, diffOut]) => {
    let added = 0;
    let deleted = 0;
    const parseOut = (out: string) => {
      const lines = out.split("\n");
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 2) {
          const a = parseInt(parts[0], 10);
          const d = parseInt(parts[1], 10);
          if (!isNaN(a)) added += a;
          if (!isNaN(d)) deleted += d;
        }
      }
    };
    parseOut(logOut);
    parseOut(diffOut);

    const mod = Math.min(added, deleted);
    const add = added - mod;
    const del = deleted - mod;

    statsCache.set(key, { add, mod, del });
    statsLoading.delete(key);
    tui.requestRender();
  });
};

const formatItemLabel = (
  session: SessionInfoLike,
  width: number,
  theme: any,
  statsCache: Map<string, SessionStats>,
): string => {
  const itemWidth = width - 4;
  const timeStr = formatRelativeTime(session.modified);

  const stats = statsCache.get(session.path);
  let statsStr = "";
  let statsLen = 0;
  if (stats && (stats.add > 0 || stats.mod > 0 || stats.del > 0)) {
    const parts = [];
    if (stats.add > 0) parts.push(theme.fg("success", `+${stats.add}`));
    if (stats.mod > 0) parts.push(theme.fg("warning", `~${stats.mod}`));
    if (stats.del > 0) parts.push(theme.fg("error", `-${stats.del}`));
    statsStr = parts.join(" ");
    statsLen =
      (stats.add > 0 ? `${stats.add}`.length + 1 : 0) +
      (stats.mod > 0 ? `${stats.mod}`.length + 1 : 0) +
      (stats.del > 0 ? `${stats.del}`.length + 1 : 0) +
      parts.length -
      1;
  }

  const title = buildSessionLabel(session);
  const reserved = 1 + timeStr.length + (statsLen > 0 ? statsLen + 2 : 0);
  const titleWidth = Math.max(5, itemWidth - reserved);
  const truncatedTitle = truncateToWidth(title, titleWidth, "…");

  const visibleTitleLen = visibleWidth(truncatedTitle);
  const paddingSize =
    itemWidth -
    visibleTitleLen -
    (statsLen > 0 ? statsLen : 0) -
    timeStr.length;

  if (statsStr) {
    const pad1 = " ".repeat(Math.max(1, paddingSize - 2));
    const pad2 = "  ";
    return `${truncatedTitle}${pad1}${statsStr}${pad2}${theme.fg("dim", timeStr)}`;
  } else {
    const padding = " ".repeat(Math.max(1, paddingSize));
    return `${truncatedTitle}${padding}${theme.fg("dim", timeStr)}`;
  }
};

const renderPreview = (
  preview: SessionPreview | undefined,
  width: number,
  height: number,
  scrollOffset: number,
  theme: {
    fg: (color: any, text: string) => string;
    bold: (text: string) => string;
    italic?: (text: string) => string;
  },
  options: PreviewRenderOptions,
  focus: "list" | "preview",
): { lines: string[]; totalLines: number; maxScroll: number } => {
  const raw: string[] = [];

  if (!preview) {
    raw.push(
      " ".repeat(Math.max(0, Math.floor((width - 7) / 2))) +
        themeText(theme, "title", "Preview"),
    );
    raw.push(
      " ".repeat(Math.max(0, Math.floor((width - 25) / 2))) +
        themeText(theme, "subtitle", "Loading selected session…"),
    );
  } else {
    const titleStr = "Thread Preview";
    const titleColor =
      focus === "preview"
        ? themeText(theme, "title", titleStr)
        : themeText(theme, "subtitle", titleStr);
    const titlePadding = " ".repeat(
      Math.max(0, Math.floor((width - titleStr.length) / 2)),
    );
    raw.push(`${titlePadding}${titleColor}`);

    const subStr = preview.subtitle;
    const subPadding = " ".repeat(
      Math.max(0, Math.floor((width - visibleWidth(subStr)) / 2)),
    );
    raw.push(`${subPadding}${themeText(theme, "subtitle", subStr)}`);

    raw.push(themeText(theme, "rule", "─".repeat(Math.max(0, width))));

    for (let i = 0; i < preview.blocks.length; i++) {
      const block = preview.blocks[i]!;
      if (!options.toolsExpanded && isToolBlock(block)) {
        const run: PreviewBlock[] = [];
        while (i < preview.blocks.length && isToolBlock(preview.blocks[i]!)) {
          run.push(preview.blocks[i]!);
          i++;
        }
        i--;
        if (raw.length > 3) raw.push("");
        raw.push(
          ...wrapTextWithAnsi(
            themeText(theme, "tool", summarizeToolRun(run)),
            width,
          ),
        );
        continue;
      }

      if (raw.length > 3) raw.push("");
      raw.push(...renderPreviewBlock(block, width, theme, options));
    }
  }

  const maxScroll = Math.max(0, raw.length - height);
  const boundedOffset = Math.max(0, Math.min(scrollOffset, maxScroll));

  // Render scrollbar on the right border
  const visible: string[] = [];
  const thumbSize = Math.max(
    1,
    Math.min(height, Math.round((height / raw.length) * height)),
  );
  const thumbStart =
    maxScroll > 0
      ? Math.max(
          0,
          Math.min(
            height - thumbSize,
            Math.round((boundedOffset / maxScroll) * (height - thumbSize)),
          ),
        )
      : 0;

  for (let i = 0; i < height; i++) {
    const lineIndex = boundedOffset + i;
    const line = lineIndex < raw.length ? raw[lineIndex]! : "";

    let scrollChar = "";
    if (maxScroll > 0) {
      if (i >= thumbStart && i < thumbStart + thumbSize) {
        scrollChar = theme.fg("text", "█");
      } else {
        scrollChar = theme.fg("border", "│");
      }
    } else {
      scrollChar = theme.fg("border", "│");
    }

    visible.push(padAnsiRight(line, width - 1) + scrollChar);
  }

  return { lines: visible, totalLines: raw.length, maxScroll };
};

const loadSessionPreview = async (
  session: SessionInfoLike,
): Promise<SessionPreview> => {
  try {
    const manager = SessionManager.open(session.path);
    const context = manager.buildSessionContext();
    return buildSessionPreview(session, context.messages as any[]);
  } catch (error) {
    return buildPreviewError(session, error);
  }
};

async function listSessions(
  ctx: ExtensionCommandContext,
): Promise<SessionInfoLike[] | null> {
  if (!ctx.hasUI) {
    const sessions = await SessionManager.list(ctx.cwd);
    return sortSessions(sessions);
  }

  let loadError: string | undefined;
  const sessions = await ctx.ui.custom<SessionInfoLike[] | null>(
    (tui, theme, _kb, done) => {
      const container = new Container();
      const borderColor = (text: string) => theme.fg("border", text);

      const loader = new CancellableLoader(
        tui,
        (text) => theme.fg("accent", text),
        (text) => theme.fg("muted", text),
        "Loading sessions...",
      );

      let settled = false;
      const finish = (result: SessionInfoLike[] | null) => {
        if (settled) return;
        settled = true;
        done(result);
      };

      loader.onAbort = () => finish(null);

      container.addChild(new DynamicBorder(borderColor));
      container.addChild(loader);
      container.addChild(new Spacer(1));
      container.addChild(
        new Text(keyHint("tui.select.cancel", "cancel"), 1, 0),
      );
      container.addChild(new Spacer(1));
      container.addChild(new DynamicBorder(borderColor));

      const load = async () => {
        try {
          const results = await SessionManager.list(
            ctx.cwd,
            undefined,
            (loaded, total) => {
              if (total > 0) {
                loader.setMessage(`Loading sessions (${loaded}/${total})...`);
              }
            },
          );
          finish(sortSessions(results));
        } catch (error) {
          loadError = error instanceof Error ? error.message : "Unknown error";
          finish(null);
        }
      };

      void load();

      return {
        render: (width) => container.render(width),
        invalidate: () => container.invalidate(),
        handleInput: (data) => {
          loader.handleInput(data);
          tui.requestRender();
        },
      };
    },
  );

  if (loadError) {
    ctx.ui.notify(`Failed to load sessions: ${loadError}`, "error");
  }

  return sessions;
}

async function showSessionPicker(
  ctx: ExtensionCommandContext,
  sessions: SessionInfoLike[],
  maxVisible: number,
): Promise<SessionInfoLike | null> {
  let sorted = sessions;
  let entries = buildSessionSearchEntries(sorted);
  const sessionByPath = new Map(
    sorted.map((session) => [session.path, session]),
  );

  return ctx.ui.custom<SessionInfoLike | null>(
    (tui, theme, kb, done) => {
      let filter = "";
      let selectList: SelectList;
      let filteredEntries = entries;
      let selectedPath = sorted[0]?.path ?? "";
      let previewScrollOffset = 0;
      let toolsExpanded = false;
      let thinkingVisible = false;
      const previewCache = new Map<string, SessionPreview>();
      let activePreview: SessionPreview | undefined;
      let previewTimer: ReturnType<typeof setTimeout> | undefined;
      let previewSeq = 0;

      let focus: "list" | "preview" = "list";
      let showAllWorkspaces = false;
      let isLoading = false;

      const previewKey = (session: SessionInfoLike): string =>
        `${session.path}:${session.modified.getTime()}`;

      // Group by CWD to find latest session per CWD
      const getLatestSessionMap = (list: SessionInfoLike[]) => {
        const latestMap = new Map<string, string>();
        for (const s of list) {
          if (!latestMap.has(s.cwd)) {
            latestMap.set(s.cwd, s.path);
          }
        }
        return latestMap;
      };

      const triggerStatsLoad = (list: SessionInfoLike[]) => {
        const latestMap = getLatestSessionMap(list);
        for (const s of list) {
          const isLatest = latestMap.get(s.cwd) === s.path;
          loadSessionStats(s, isLatest, tui);
        }
      };

      // Initial stats load
      triggerStatsLoad(sorted);

      const loadWorkspaceSessions = async (allWorkspaces: boolean) => {
        isLoading = true;
        tui.requestRender();
        try {
          let results: SessionInfoLike[];
          if (allWorkspaces) {
            results = await SessionManager.listAll();
          } else {
            results = await SessionManager.list(ctx.cwd);
          }
          sorted = sortSessions(results);
          for (const s of sorted) {
            sessionByPath.set(s.path, s);
          }
          entries = buildSessionSearchEntries(sorted);
          triggerStatsLoad(sorted);

          filteredEntries = filterSessionEntries(entries, filter);
          const matchedIndex = filteredEntries.findIndex(
            (entry) => entry.session.path === selectedPath,
          );
          if (matchedIndex >= 0) {
            // Keep selection
          } else {
            selectedPath = filteredEntries[0]?.session.path ?? "";
          }
          rebuild();
          schedulePreviewLoad();
        } catch (error) {
          ctx.ui.notify(
            `Failed to load sessions: ${error instanceof Error ? error.message : error}`,
            "error",
          );
        } finally {
          isLoading = false;
          tui.requestRender();
        }
      };

      const schedulePreviewLoad = () => {
        previewScrollOffset = 0;
        const session = sessionByPath.get(selectedPath);
        if (!session) {
          activePreview = undefined;
          return;
        }

        const key = previewKey(session);
        const cached = previewCache.get(key);
        if (cached) {
          activePreview = cached;
          return;
        }

        activePreview = {
          title: buildSessionLabel(session),
          subtitle: `${session.modified.toLocaleString()} · loading preview`,
          blocks: [{ kind: "notice", text: "Loading selected session…" }],
        };

        if (previewTimer) clearTimeout(previewTimer);
        const seq = ++previewSeq;
        previewTimer = setTimeout(() => {
          void loadSessionPreview(session).then((preview) => {
            if (seq !== previewSeq || selectedPath !== session.path) return;
            previewCache.set(key, preview);
            activePreview = preview;
            tui.requestRender();
          });
        }, PREVIEW_LOAD_DEBOUNCE_MS);
      };

      const setSelectedPath = (path: string | undefined) => {
        if (!path || path === selectedPath) return;
        selectedPath = path;
        schedulePreviewLoad();
      };

      const buildItems = (
        current: typeof entries,
        listWidth: number,
      ): SelectItem[] =>
        current.map((entry) => ({
          value: entry.session.path,
          label: formatItemLabel(entry.session, listWidth, theme, statsCache),
        }));

      const rebuild = () => {
        filteredEntries = filterSessionEntries(entries, filter);
        const matchedIndex = filteredEntries.findIndex(
          (entry) => entry.session.path === selectedPath,
        );
        if (matchedIndex >= 0) {
          // Keep selection
        } else {
          selectedPath = filteredEntries[0]?.session.path ?? "";
          schedulePreviewLoad();
        }
      };

      const renderSinglePane = (width: number): string[] => {
        const container = new Container();
        const filterLine = filter.length
          ? `${theme.fg("muted", "Filter: ")}${theme.fg("text", filter)}`
          : `${theme.fg("muted", "Filter: ")}${theme.fg("dim", "type to filter")}`;

        container.addChild(
          new DynamicBorder((text: string) => theme.fg("accent", text)),
        );
        container.addChild(
          new Text(theme.fg("accent", theme.bold("Sessions")), 1, 0),
        );
        container.addChild(new Text(filterLine, 1, 0));
        if (isLoading) {
          container.addChild(new Spacer(1));
          container.addChild(
            new Text(theme.fg("muted", "  Loading sessions..."), 1, 0),
          );
          container.addChild(new Spacer(1));
        } else {
          const items = buildItems(filteredEntries, width);
          selectList = new SelectList(
            items,
            Math.max(1, Math.min(maxVisible, Math.max(items.length, 1))),
            {
              selectedPrefix: (text) =>
                theme.fg(focus === "list" ? "accent" : "muted", text),
              selectedText: (text) =>
                theme.fg(focus === "list" ? "accent" : "muted", text),
              description: (text) => theme.fg("muted", text),
              scrollInfo: (text) => theme.fg("dim", text),
              noMatch: () => theme.fg("warning", "  No matching sessions"),
            },
          );
          const selectedIndex = filteredEntries.findIndex(
            (entry) => entry.session.path === selectedPath,
          );
          selectList.setSelectedIndex(selectedIndex >= 0 ? selectedIndex : 0);
          selectList.onSelect = (item) =>
            done(sessionByPath.get(item.value) ?? null);
          selectList.onCancel = () => done(null);
          selectList.onSelectionChange = (item) => setSelectedPath(item.value);
          container.addChild(selectList);
        }
        container.addChild(
          new Text(
            theme.fg("dim", "↑↓ navigate • enter open • esc cancel"),
            1,
            0,
          ),
        );
        container.addChild(
          new DynamicBorder((text: string) => theme.fg("accent", text)),
        );
        return container.render(width);
      };

      const buildTopBorder = (
        listWidth: number,
        previewWidth: number,
      ): string => {
        const leftTitle = " Switch Thread ";
        const left = `┌─${leftTitle}${"─".repeat(Math.max(0, listWidth - leftTitle.length - 2))}`;
        const right = "─".repeat(Math.max(0, previewWidth - 1)) + "┐";
        return `${theme.fg("border", left)}${theme.fg("border", "─┬─")}${theme.fg("border", right)}`;
      };

      const buildBottomBorder = (
        listWidth: number,
        previewWidth: number,
        previewStats: string,
      ): string => {
        const help = showAllWorkspaces
          ? " Opt+W/Ctrl+T current workspace  ·  Esc close "
          : " Opt+W/Ctrl+T all workspaces  ·  Esc close ";
        const left = `└${"─".repeat(Math.max(0, listWidth - 1))}`;
        const right = `${"─".repeat(Math.max(0, previewWidth - help.length - 1))}${help}┘`;
        return `${theme.fg("border", left)}${theme.fg("border", "─┴─")}${theme.fg("border", right)}`;
      };

      const renderSplitPane = (width: number): string[] => {
        const layout = getSessionPaneLayout(width);
        const termRows = Math.max(12, tui.terminal?.rows ?? 24);
        const contentHeight = Math.max(8, termRows - 2);
        const filterLine = filter.length
          ? `${theme.fg("muted", "Filter: ")}${theme.fg("text", filter)}`
          : `${theme.fg("muted", "Filter: ")}${theme.fg("dim", "type to filter")}`;
        const listHeight = Math.max(1, contentHeight - 1);

        let leftLines: string[] = [];
        if (isLoading) {
          leftLines.push(filterLine);
          leftLines.push("");
          leftLines.push(theme.fg("muted", "  Loading sessions..."));
        } else {
          const items = buildItems(filteredEntries, layout.listWidth);
          selectList = new SelectList(
            items,
            Math.max(
              listHeight,
              Math.min(maxVisible, Math.max(items.length, 1)),
            ),
            {
              selectedPrefix: (text) =>
                theme.fg(focus === "list" ? "accent" : "muted", text),
              selectedText: (text) =>
                theme.fg(focus === "list" ? "accent" : "muted", text),
              description: (text) => theme.fg("muted", text),
              scrollInfo: (text) => theme.fg("dim", text),
              noMatch: () => theme.fg("warning", "  No matching sessions"),
            },
          );
          const selectedIndex = filteredEntries.findIndex(
            (entry) => entry.session.path === selectedPath,
          );
          selectList.setSelectedIndex(selectedIndex >= 0 ? selectedIndex : 0);
          selectList.onSelect = (item) =>
            done(sessionByPath.get(item.value) ?? null);
          selectList.onCancel = () => done(null);
          selectList.onSelectionChange = (item) => setSelectedPath(item.value);

          leftLines = [
            filterLine,
            ...selectList.render(layout.listWidth),
          ].slice(0, contentHeight);
        }

        while (leftLines.length < contentHeight) leftLines.push("");

        const renderedPreview = renderPreview(
          activePreview,
          layout.previewWidth,
          contentHeight,
          previewScrollOffset,
          theme,
          {
            toolsExpanded,
            thinkingVisible,
          },
          focus,
        );
        previewScrollOffset = Math.min(
          previewScrollOffset,
          renderedPreview.maxScroll,
        );
        const modeHints = `t ${toolsExpanded ? "compact" : "tools"} • h ${thinkingVisible ? "hide thinking" : "thinking"}`;
        const previewStats =
          renderedPreview.maxScroll > 0
            ? ` ${previewScrollOffset + 1}-${Math.min(previewScrollOffset + contentHeight, renderedPreview.totalLines)}/${renderedPreview.totalLines} • pgup/pgdn • ${modeHints} `
            : ` esc/enter • ${modeHints} `;

        const lines = [buildTopBorder(layout.listWidth, layout.previewWidth)];
        for (let i = 0; i < contentHeight; i++) {
          const left = padAnsiRight(leftLines[i] ?? "", layout.listWidth);
          const right =
            renderedPreview.lines[i] ?? " ".repeat(layout.previewWidth);
          lines.push(`${left}${theme.fg("border", " │ ")}${right}`);
        }
        lines.push(
          buildBottomBorder(
            layout.listWidth,
            layout.previewWidth,
            previewStats,
          ),
        );
        return lines.map((line) => truncateToWidth(line, width, "", true));
      };

      rebuild();
      schedulePreviewLoad();

      return {
        render: (width) => {
          const layout = getSessionPaneLayout(width);
          if (layout.mode === "single") return renderSinglePane(width);
          return renderSplitPane(width);
        },
        invalidate: () => {
          previewCache.clear();
          rebuild();
        },
        handleInput: (data) => {
          if (data === "\u0014" || data === "\u001bw") {
            showAllWorkspaces = !showAllWorkspaces;
            void loadWorkspaceSessions(showAllWorkspaces);
            return;
          }

          if (data === "\t") {
            focus = focus === "list" ? "preview" : "list";
            tui.requestRender();
            return;
          }
          if (matchesKey(data, Key.left)) {
            if (focus === "preview") {
              focus = "list";
              tui.requestRender();
            }
            return;
          }
          if (matchesKey(data, Key.right)) {
            if (focus === "list") {
              focus = "preview";
              tui.requestRender();
            }
            return;
          }

          if (isLoading) return;

          if (matchesKey(data, Key.backspace) || matchesKey(data, Key.delete)) {
            if (filter.length > 0) {
              filter = filter.slice(0, -1);
              rebuild();
              tui.requestRender();
            }
            return;
          }

          const currentLayout = getSessionPaneLayout(
            tui.terminal?.columns ?? 80,
          );
          if (currentLayout.mode === "split") {
            if (data === "t") {
              toolsExpanded = !toolsExpanded;
              previewScrollOffset = 0;
              tui.requestRender();
              return;
            }
            if (data === "h") {
              thinkingVisible = !thinkingVisible;
              previewScrollOffset = 0;
              tui.requestRender();
              return;
            }

            if (focus === "preview") {
              const pageSize = Math.max(4, (tui.terminal?.rows ?? 24) - 4);
              if (
                matchesKey(data, Key.pageDown) ||
                matchesKey(data, Key.ctrl("d"))
              ) {
                previewScrollOffset += pageSize;
                tui.requestRender();
                return;
              }
              if (
                matchesKey(data, Key.pageUp) ||
                matchesKey(data, Key.ctrl("u"))
              ) {
                previewScrollOffset = Math.max(
                  0,
                  previewScrollOffset - pageSize,
                );
                tui.requestRender();
                return;
              }
              if (
                matchesKey(data, Key.down) ||
                matchesKey(data, Key.ctrl("j"))
              ) {
                previewScrollOffset++;
                tui.requestRender();
                return;
              }
              if (matchesKey(data, Key.up) || matchesKey(data, Key.ctrl("k"))) {
                previewScrollOffset = Math.max(0, previewScrollOffset - 1);
                tui.requestRender();
                return;
              }
            }
          }

          if (focus === "list") {
            if (isPrintable(data)) {
              filter += data;
              rebuild();
              tui.requestRender();
              return;
            }

            if (kb.matches(data, "tui.select.pageUp")) {
              const currentIndex = Math.max(
                0,
                filteredEntries.findIndex(
                  (entry) => entry.session.path === selectedPath,
                ),
              );
              const nextIndex = Math.max(0, currentIndex - maxVisible);
              selectList.setSelectedIndex(nextIndex);
              setSelectedPath(filteredEntries[nextIndex]?.session.path);
              tui.requestRender();
              return;
            }

            if (kb.matches(data, "tui.select.pageDown")) {
              const currentIndex = Math.max(
                0,
                filteredEntries.findIndex(
                  (entry) => entry.session.path === selectedPath,
                ),
              );
              const nextIndex = Math.min(
                filteredEntries.length - 1,
                currentIndex + maxVisible,
              );
              selectList.setSelectedIndex(nextIndex);
              setSelectedPath(filteredEntries[nextIndex]?.session.path);
              tui.requestRender();
              return;
            }

            selectList.handleInput(data);
            tui.requestRender();
          }
        },
      };
    },
    {
      overlay: true,
      overlayOptions: {
        anchor: "top-left",
        row: 0,
        col: 0,
        width: "100%",
        maxHeight: "100%",
        margin: 0,
      },
    },
  );
}

async function runSessionsCommand(
  args: string | undefined,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const limit = parseLimit(args, DEFAULT_VISIBLE);
  const sessions = await listSessions(ctx);

  if (!sessions || sessions.length === 0) {
    if (ctx.hasUI) {
      ctx.ui.notify("No sessions found for this project.", "info");
    } else {
      console.log("No sessions found for this project.");
    }
    return;
  }

  if (!ctx.hasUI) {
    for (const session of sessions) {
      console.log(formatPlainLine(session));
    }
    return;
  }

  const selection = await showSessionPicker(ctx, sessions, limit);
  if (!selection) return;

  const result = await ctx.switchSession(selection.path);
  if (result.cancelled) {
    ctx.ui.notify("Session switch cancelled.", "info");
  }
}

export default function sessionsExtension(pi: ExtensionAPI) {
  pi.registerCommand("sessions", {
    description: "Pick a session from the current project",
    handler: async (args, ctx) => {
      await runSessionsCommand(args, ctx);
    },
  });
}
