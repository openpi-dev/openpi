import { createContext, useContext } from "react";
import type { WebGitReviewSource } from "../../../../protocol/types.ts";
import type { WorkbarTabsState } from "./workbar-tabs.ts";

export interface BrowserPageReadingState {
  draft: string;
  history: string[];
  index: number;
}

// Presentation memory only. Handles, file contents, streams and iframe DOM are
// reacquired from their owners when the exact Session is opened again.
export interface TerminalReadingState {
  id?: string;
  viewport: number;
  atBottom: boolean;
  title?: string;
}

export interface WorkbarReadingState {
  tabs?: WorkbarTabsState;
  requestRevision?: number;
  files?: {
    selected: string;
    treeVisible: boolean;
    query: string;
    expanded: string[];
    treeScroll: number;
  };
  artifact?: {
    reference: string;
    source: boolean;
    editing: boolean;
    scroll: number;
    document?: {
      path: string;
      revision: string;
      page: number;
      scale?: number;
    };
  };
  review?: {
    scope: string;
    source: WebGitReviewSource;
    baseRef?: string;
    selected: string | null;
    query: string;
    collapsedDirectories: string[];
    visibleFiles: number;
    listScroll: number;
    previewScroll: number;
    viewed?: { revision: string; paths: string[] };
  };
  browser?: {
    tabs: {
      id: number;
      title: string;
      initialUrl?: string;
    }[];
    selected: number;
    pages: Record<number, BrowserPageReadingState>;
  };
  terminal?: { id: string; viewport: number; atBottom: boolean };
  terminals?: Record<string, TerminalReadingState>;
  sideConversation?: {
    selectedId: string | null;
    drafts: Record<string, string>;
  };
}

export const WorkbarReadingContext = createContext<
  WorkbarReadingState | undefined
>(undefined);

export function useWorkbarReadingState() {
  return useContext(WorkbarReadingContext);
}
