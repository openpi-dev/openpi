import type { WorkbarTool } from "./types.ts";

export type WorkbarContentTool = Exclude<WorkbarTool, "launcher">;
export type WorkbarTabId = WorkbarContentTool | `terminal:${string}`;

export function workbarTabTool(id: WorkbarTabId) {
  return id.startsWith("terminal:") ? "terminal" : (id as WorkbarContentTool);
}

export interface WorkbarTabsState {
  tabs: WorkbarTabId[];
  active: WorkbarTabId | null;
  launcherOpen: boolean;
  activationHistory: WorkbarTabId[];
}

export function initialWorkbarTabs(tool: WorkbarTool): WorkbarTabsState {
  if (tool === "launcher") {
    return {
      tabs: [],
      active: null,
      launcherOpen: true,
      activationHistory: [],
    };
  }
  return {
    tabs: [tool],
    active: tool,
    launcherOpen: false,
    activationHistory: [tool],
  };
}

export function openWorkbarTool(
  state: WorkbarTabsState,
  tool: WorkbarTool | WorkbarTabId,
): WorkbarTabsState {
  if (tool === "launcher") {
    return { ...state, launcherOpen: true };
  }
  return {
    tabs: state.tabs.includes(tool) ? state.tabs : [...state.tabs, tool],
    active: tool,
    launcherOpen: false,
    activationHistory: [
      ...state.activationHistory.filter((item) => item !== tool),
      tool,
    ],
  };
}

export function activateWorkbarTool(
  state: WorkbarTabsState,
  tool: WorkbarTabId,
): WorkbarTabsState {
  if (!state.tabs.includes(tool)) return state;
  return openWorkbarTool(state, tool);
}

export function closeWorkbarTool(
  state: WorkbarTabsState,
  tool: WorkbarTabId,
): WorkbarTabsState {
  if (!state.tabs.includes(tool)) return state;
  const tabs = state.tabs.filter((item) => item !== tool);
  const activationHistory = state.activationHistory.filter(
    (item) => item !== tool,
  );
  if (state.active !== tool) {
    return { ...state, tabs, activationHistory };
  }
  const historicalFallback = activationHistory.at(-1);
  const closedIndex = state.tabs.indexOf(tool);
  const adjacentFallback = tabs[Math.min(closedIndex, tabs.length - 1)];
  const active = historicalFallback ?? adjacentFallback ?? null;
  return {
    tabs,
    active,
    launcherOpen: state.launcherOpen || active === null,
    activationHistory,
  };
}

export function dismissWorkbarLauncher(
  state: WorkbarTabsState,
): WorkbarTabsState {
  return {
    ...state,
    launcherOpen: state.active === null,
  };
}
