import { browserAddress } from "./browser-address.ts";
import type { WorkbarTool } from "./types.ts";
import type { WorkbarReadingState } from "./workbar-reading-state.ts";
import type { WorkbarTabId } from "./workbar-tabs.ts";

export const WORKBAR_POSITION_STORAGE_KEY = "openpi:workbar-positions:v1";

export interface WorkbarWorkspace {
  sessionId: string;
  sessionPath: string;
  tool: WorkbarTool;
  requestRevision: number;
  open: boolean;
  reading: WorkbarReadingState;
  reviewTurn?: { promptEntryId: string; filePath?: string; revision: number };
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function text(value: unknown, limit = 4096) {
  return typeof value === "string" && value.length <= limit ? value : "";
}
function number(
  value: unknown,
  fallback = 0,
  minimum = 0,
  maximum = 50_000_000,
) {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= minimum &&
    value <= maximum
    ? value
    : fallback;
}
function strings(value: unknown, limit = 100) {
  return Array.isArray(value)
    ? value
        .slice(0, limit)
        .filter(
          (item): item is string =>
            typeof item === "string" && item.length <= 4096,
        )
    : [];
}
function address(value: unknown) {
  return browserAddress(text(value), window.location.origin);
}
function tabId(value: unknown): value is WorkbarTabId {
  return (
    typeof value === "string" &&
    (["files", "review", "browser", "terminal", "side-conversation"].includes(
      value,
    ) ||
      /^terminal:[a-zA-Z0-9-]{1,128}$/u.test(value))
  );
}
function tool(value: unknown): value is WorkbarTool {
  return (
    typeof value === "string" &&
    [
      "launcher",
      "files",
      "review",
      "browser",
      "terminal",
      "side-conversation",
    ].includes(value)
  );
}

function reading(value: unknown) {
  const result: WorkbarReadingState = {};
  if (!object(value)) return result;
  if (object(value.tabs)) {
    const tabs = Array.isArray(value.tabs.tabs)
      ? [...new Set(value.tabs.tabs.filter(tabId))].slice(0, 16)
      : [];
    const active =
      tabId(value.tabs.active) && tabs.includes(value.tabs.active)
        ? value.tabs.active
        : null;
    result.tabs = {
      tabs,
      active,
      launcherOpen: value.tabs.launcherOpen === true || active === null,
      activationHistory: Array.isArray(value.tabs.activationHistory)
        ? [
            ...new Set(
              value.tabs.activationHistory
                .filter(tabId)
                .filter((id) => tabs.includes(id)),
            ),
          ].slice(-16)
        : [],
    };
    result.requestRevision = number(value.requestRevision);
  }
  if (object(value.files))
    result.files = {
      selected: text(value.files.selected),
      treeVisible: value.files.treeVisible !== false,
      query: text(value.files.query, 200),
      expanded: strings(value.files.expanded),
      treeScroll: number(value.files.treeScroll),
    };
  if (object(value.artifact)) {
    result.artifact = {
      reference: text(value.artifact.reference),
      source: value.artifact.source === true,
      editing: false,
      scroll: number(value.artifact.scroll),
    };
    const doc = value.artifact.document;
    if (
      object(doc) &&
      typeof doc.revision === "string" &&
      /^[a-f0-9]{64}$/u.test(doc.revision)
    )
      result.artifact.document = {
        path: text(doc.path),
        revision: doc.revision,
        page: Math.floor(number(doc.page, 1, 1, 100_000)),
        ...(typeof doc.scale === "number"
          ? { scale: number(doc.scale, 1, 0.1, 8) }
          : {}),
      };
  }
  const review = value.review;
  if (
    object(review) &&
    (review.source === "unstaged" ||
      review.source === "staged" ||
      review.source === "branch" ||
      review.source === "session")
  ) {
    result.review = {
      scope: text(review.scope),
      source: review.source,
      ...(typeof review.baseRef === "string"
        ? { baseRef: text(review.baseRef, 1024) }
        : {}),
      selected:
        typeof review.selected === "string" ? text(review.selected) : null,
      query: text(review.query, 200),
      collapsedDirectories: strings(review.collapsedDirectories),
      visibleFiles: number(review.visibleFiles, 50, 0, 200),
      listScroll: number(review.listScroll),
      previewScroll: number(review.previewScroll),
    };
    if (object(review.viewed) && typeof review.viewed.revision === "string")
      result.review.viewed = {
        revision: text(review.viewed.revision, 128),
        paths: strings(review.viewed.paths, 200),
      };
  }
  const browser = value.browser;
  if (object(browser) && Array.isArray(browser.tabs)) {
    const seen = new Set<number>();
    const tabs = browser.tabs
      .flatMap((item) => {
        if (
          !object(item) ||
          !Number.isSafeInteger(item.id) ||
          typeof item.id !== "number" ||
          item.id < 0 ||
          item.id > 50_000_000
        )
          return [];
        if (seen.has(item.id)) return [];
        seen.add(item.id);
        const url = address(item.initialUrl);
        return [
          {
            id: item.id,
            title: text(item.title, 200),
            ...(url ? { initialUrl: url } : {}),
          },
        ];
      })
      .slice(0, 8);
    const pages: NonNullable<WorkbarReadingState["browser"]>["pages"] = {};
    for (const tab of tabs) {
      const page = object(browser.pages) ? browser.pages[tab.id] : undefined;
      if (!object(page)) continue;
      const history = strings(page.history, 32).flatMap(
        (url) => address(url) ?? [],
      );
      pages[tab.id] = {
        draft: address(page.draft) ?? "",
        history,
        index: history.length
          ? Math.min(Math.floor(number(page.index)), history.length - 1)
          : -1,
      };
    }
    result.browser = {
      tabs,
      selected: tabs.some((tab) => tab.id === browser.selected)
        ? Number(browser.selected)
        : (tabs[0]?.id ?? 0),
      pages,
    };
  }
  if (object(value.terminals)) {
    result.terminals = {};
    for (const [id, terminal] of Object.entries(value.terminals).slice(0, 16)) {
      if (
        !tabId(id) ||
        (id !== "terminal" && !id.startsWith("terminal:")) ||
        !result.tabs?.tabs.includes(id) ||
        !object(terminal)
      )
        continue;
      result.terminals[id] = {
        ...(typeof terminal.id === "string"
          ? { id: text(terminal.id, 128) }
          : {}),
        ...(typeof terminal.title === "string"
          ? { title: text(terminal.title, 80) }
          : {}),
        viewport: number(terminal.viewport),
        atBottom: terminal.atBottom !== false,
      };
    }
  }
  if (object(value.terminal) && typeof value.terminal.id === "string")
    result.terminal = {
      id: text(value.terminal.id, 128),
      viewport: number(value.terminal.viewport),
      atBottom: value.terminal.atBottom !== false,
    };
  if (object(value.sideConversation))
    result.sideConversation = {
      selectedId:
        typeof value.sideConversation.selectedId === "string"
          ? text(value.sideConversation.selectedId, 128)
          : null,
      drafts: {},
    };
  return result;
}

function workspace(value: unknown) {
  if (
    !object(value) ||
    !text(value.sessionId, 128) ||
    !text(value.sessionPath) ||
    !tool(value.tool)
  )
    return null;
  const result: WorkbarWorkspace = {
    sessionId: text(value.sessionId, 128),
    sessionPath: text(value.sessionPath),
    tool: value.tool,
    open: value.open === true,
    requestRevision: number(value.requestRevision),
    reading: reading(value.reading),
  };
  if (object(value.reviewTurn) && text(value.reviewTurn.promptEntryId, 512))
    result.reviewTurn = {
      promptEntryId: text(value.reviewTurn.promptEntryId, 512),
      revision: number(value.reviewTurn.revision),
      ...(typeof value.reviewTurn.filePath === "string"
        ? { filePath: text(value.reviewTurn.filePath) }
        : {}),
    };
  return result;
}

export function loadWorkbarPositions() {
  try {
    const raw = localStorage.getItem(WORKBAR_POSITION_STORAGE_KEY);
    if (!raw || raw.length > 256_000) return [];
    const values: unknown = JSON.parse(raw);
    if (!Array.isArray(values)) return [];
    const positions = new Map<string, WorkbarWorkspace>();
    for (const item of values.slice(-32)) {
      const valid = workspace(item);
      if (valid)
        positions.set(
          JSON.stringify([valid.sessionId, valid.sessionPath]),
          valid,
        );
    }
    return [...positions.values()];
  } catch {
    return [];
  }
}

export function saveWorkbarPositions(values: WorkbarWorkspace[]) {
  try {
    // Whitelist presentation metadata; live resources are reacquired by each owner.
    const positions = values
      .slice(-32)
      .flatMap((item) => workspace(item) ?? []);
    let raw = JSON.stringify(positions);
    while (raw.length > 256_000 && positions.length) {
      positions.shift();
      raw = JSON.stringify(positions);
    }
    localStorage.setItem(WORKBAR_POSITION_STORAGE_KEY, raw);
  } catch {
    /* Browser storage failure must not prevent using a tool. */
  }
}
