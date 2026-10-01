import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import {
  ArrowLeft,
  Check,
  ChevronRight,
  FileDiff,
  FolderOpen,
  Globe2,
  MessagesSquare,
  PanelLeftOpen,
  Plus,
  Send,
  SquareTerminal,
  StopCircle,
  X,
} from "lucide-react";
import {
  type FormEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import type {
  WebBackgroundTerminalActivity,
  WebCapabilityProjection,
  WebCapabilitySnapshot,
  WebSubagentActivity,
} from "../../../../../extensions/shared/web-observer-registry.ts";
import { WebClient } from "../../protocol/client.ts";
import { FilesPanel } from "../files/FilesPanel.tsx";
import type { DiffLineReference } from "../review/DiffCodePreview.tsx";
import {
  type GitReviewViewState,
  ReviewPanel,
} from "../review/ReviewPanel.tsx";
import { useTurnReview } from "../review/use-turn-review.ts";
import { SubagentDetailView } from "../subagents/SubagentPanel.tsx";
import { BrowserPanel } from "./BrowserPanel.tsx";
import { InteractiveTerminal } from "./InteractiveTerminal.tsx";
import type { WorkbarTool } from "./types.ts";
import {
  useWorkbarReadingState,
  WorkbarReadingContext,
  type WorkbarReadingState,
} from "./workbar-reading-state.ts";
import {
  activateWorkbarTool,
  closeWorkbarTool,
  dismissWorkbarLauncher,
  initialWorkbarTabs,
  openWorkbarTool,
  type WorkbarContentTool,
} from "./workbar-tabs.ts";

const launcherTools = [
  {
    kind: "side-conversation" as const,
    icon: MessagesSquare,
    title: "sideConversation",
    description: "sideConversationDescription",
  },
  {
    kind: "review" as const,
    icon: FileDiff,
    title: "changeEvidence",
    description: "workbarChangesDescription",
  },
  {
    kind: "terminal" as const,
    icon: SquareTerminal,
    title: "terminal",
    description: "workbarTerminalDescription",
  },
  {
    kind: "browser" as const,
    icon: Globe2,
    title: "browser",
    description: "workbarBrowserDescription",
  },
  {
    kind: "files" as const,
    icon: FolderOpen,
    title: "files",
    description: "workbarFilesDescription",
  },
] as const;

function WorkbarLauncher({
  onSelect,
}: {
  onSelect: (tool: WorkbarTool) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="workbar-launcher">
      <div className="workbar-launcher-list">
        {launcherTools.map((tool) => {
          const Icon = tool.icon;
          return (
            <button
              type="button"
              key={tool.kind}
              onClick={() => onSelect(tool.kind)}
            >
              <Icon aria-hidden="true" />
              <span>
                <strong>{t(tool.title)}</strong>
                <small>{t(tool.description)}</small>
              </span>
              <ChevronRight aria-hidden="true" />
            </button>
          );
        })}
      </div>
    </div>
  );
}

function SideConversationPanel({
  sessionId,
  activity,
}: {
  sessionId: string;
  activity?: WebCapabilityProjection<WebSubagentActivity>;
}) {
  const { t } = useTranslation();
  const client = useMemo(() => new WebClient(), []);
  const reading = useWorkbarReadingState();
  const [selectedId, setSelectedId] = useState<string | null>(
    reading?.sideConversation?.selectedId ?? null,
  );
  const [drafts, setDrafts] = useState<Record<string, string>>(
    reading?.sideConversation?.drafts ?? {},
  );
  useLayoutEffect(() => {
    if (reading) reading.sideConversation = { selectedId, drafts };
  }, [reading, selectedId, drafts]);
  const draft = drafts[selectedId ?? ""] ?? "";
  const navigation = useRef(0);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [detailRevision, setDetailRevision] = useState(0);
  const [lastStatus, setLastStatus] = useState<
    WebSubagentActivity["status"] | null
  >(null);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  const items = (activity?.items ?? []).filter((item) => item.origin === "btw");
  const selected = items.find((item) => item.id === selectedId);
  const status = selected?.status ?? lastStatus;
  const selectConversation = (id: string | null) => {
    navigation.current++;
    setSelectedId(id);
    setLastStatus(null);
    setError(null);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || busyRef.current) return;
    busyRef.current = true;
    abort.current?.abort();
    const controller = new AbortController();
    const generation = navigation.current;
    const draftKey = selectedId ?? "";
    abort.current = controller;
    setBusy(true);
    setError(null);
    try {
      const response = await client.subagentAction(
        sessionId,
        selectedId
          ? {
              kind: "subagents",
              action: "send-btw",
              id: selectedId,
              text,
            }
          : { kind: "subagents", action: "spawn-btw", prompt: text },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      if (
        response.sessionId !== sessionId ||
        (selectedId && response.detail.id !== selectedId)
      )
        throw new Error(t("inspectionChanged"));
      setDrafts((current) =>
        current[draftKey] === draft ? { ...current, [draftKey]: "" } : current,
      );
      if (generation !== navigation.current) return;
      setSelectedId(response.detail.id);
      setLastStatus(response.detail.status);
      setDetailRevision((value) => value + 1);
    } catch (caught) {
      if (!controller.signal.aborted && generation === navigation.current)
        setError(
          caught instanceof Error ? caught.message : t("inspectionUnavailable"),
        );
    } finally {
      if (!controller.signal.aborted) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  };

  const stop = async () => {
    if (!selectedId || busyRef.current) return;
    busyRef.current = true;
    abort.current?.abort();
    const controller = new AbortController();
    const generation = navigation.current;
    abort.current = controller;
    setBusy(true);
    setError(null);
    try {
      const response = await client.subagentAction(
        sessionId,
        { kind: "subagents", action: "cancel-btw", id: selectedId },
        controller.signal,
      );
      if (controller.signal.aborted || generation !== navigation.current)
        return;
      if (response.sessionId !== sessionId || response.detail.id !== selectedId)
        throw new Error(t("inspectionChanged"));
      setLastStatus(response.detail.status);
      setDetailRevision((value) => value + 1);
    } catch (caught) {
      if (!controller.signal.aborted && generation === navigation.current)
        setError(
          caught instanceof Error ? caught.message : t("inspectionUnavailable"),
        );
    } finally {
      if (!controller.signal.aborted) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  };

  return (
    <div className="side-conversation-body">
      {selectedId ? (
        <>
          <button
            type="button"
            className="workbar-back"
            onClick={() => selectConversation(null)}
          >
            <ArrowLeft aria-hidden="true" /> {t("backToSideConversations")}
          </button>
          <SubagentDetailView
            key={`${sessionId}:${selectedId}`}
            sessionId={sessionId}
            id={selectedId}
            activity={selected}
            client={client}
            liveAvailable
            refreshRevision={detailRevision}
            fullView={false}
            readOnlyNote={false}
          />
        </>
      ) : (
        <div className="side-conversation-list">
          <div className="side-conversation-intro">
            <MessagesSquare aria-hidden="true" />
            <h3>{t("sideConversation")}</h3>
            <p>{t("sideConversationDescription")}</p>
          </div>
          {items.length > 0 && (
            <ul>
              {items.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => selectConversation(item.id)}
                  >
                    <span>
                      <strong>{item.title || item.id}</strong>
                      <small>{t(`subagentState_${item.status}`)}</small>
                    </span>
                    <ChevronRight aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {error && (
        <p className="workbar-error" role="alert">
          {error}
        </p>
      )}
      <form
        className="side-conversation-composer"
        onSubmit={submit}
        aria-busy={busy}
      >
        <textarea
          value={draft}
          disabled={busy}
          placeholder={
            selectedId
              ? t("continueSideConversation")
              : t("startSideConversation")
          }
          onChange={(event) => {
            const value = event.currentTarget.value;
            setDrafts((current) => ({ ...current, [selectedId ?? ""]: value }));
          }}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.altKey &&
              !event.ctrlKey &&
              !event.metaKey &&
              !event.defaultPrevented &&
              !event.nativeEvent.isComposing &&
              event.nativeEvent.keyCode !== 229
            ) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <div>
          {selectedId && status === "running" && (
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => void stop()}
            >
              <StopCircle aria-hidden="true" /> {t("stop")}
            </button>
          )}
          <button type="submit" disabled={busy || !draft.trim()}>
            <Send aria-hidden="true" />
            {t(
              busy ? "sideConversationPending" : selectedId ? "send" : "start",
            )}
          </button>
        </div>
      </form>
    </div>
  );
}

function TerminalPanel({
  sessionId,
  cwd,
  activity,
}: {
  sessionId: string;
  cwd: string;
  activity?: WebCapabilityProjection<WebBackgroundTerminalActivity>;
}) {
  const { t } = useTranslation();
  const items = activity?.items ?? [];
  return (
    <div className="terminal-workspace">
      <InteractiveTerminal sessionId={sessionId} cwd={cwd} />
      {items.length > 0 && (
        <details className="terminal-agent-activity">
          <summary>
            <SquareTerminal aria-hidden="true" />
            <span>{t("backgroundTerminalActivity")}</span>
            <small>{items.length}</small>
            <ChevronRight aria-hidden="true" />
          </summary>
          <ul>
            {items.map((item) => (
              <li key={item.id}>
                <span>
                  <strong>{item.title || item.id}</strong>
                  <small>
                    {t(`execution_${item.status}`, {
                      defaultValue: item.status,
                    })}
                  </small>
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

export function WorkbarPanel({
  visible,
  requestedTool,
  requestRevision,
  sessionId,
  sessionPath,
  cwd,
  capabilities,
  review,
  reviewInitialFilePath,
  reviewTurn,
  onWorkspaceReview,
  conversationCollapsed,
  onRestoreConversation,
  onExpandReview,
  onClose,
  onActiveToolChange,
  canControl = true,
  onActivateSession,
  readingState: cachedReading,
  onReferenceLine,
}: {
  visible: boolean;
  requestedTool: WorkbarTool;
  requestRevision: number;
  sessionId: string;
  sessionPath: string;
  cwd: string;
  capabilities: WebCapabilitySnapshot;
  review: GitReviewViewState;
  reviewInitialFilePath?: string;
  reviewTurn?: { promptEntryId: string; filePath?: string; revision: number };
  onWorkspaceReview?: () => void;
  conversationCollapsed: boolean;
  onRestoreConversation: () => void;
  onExpandReview?: () => void;
  onClose: () => void;
  onActiveToolChange?: (tool: WorkbarTool | null) => void;
  canControl?: boolean;
  onActivateSession?: () => void;
  readingState?: WorkbarReadingState;
  onReferenceLine?: (reference: DiffLineReference) => void;
}) {
  const { t } = useTranslation();
  const localReading = useRef<WorkbarReadingState>({});
  const readingState = cachedReading ?? localReading.current;
  const [tabs, setTabs] = useState(() =>
    readingState?.tabs
      ? readingState.requestRevision === requestRevision
        ? readingState.tabs
        : openWorkbarTool(readingState.tabs, requestedTool)
      : initialWorkbarTabs(requestedTool),
  );
  const browserScope = JSON.stringify([sessionId, sessionPath]);
  const tabButtons = useRef(new Map<WorkbarContentTool, HTMLButtonElement>());
  const openToolsButton = useRef<HTMLButtonElement>(null);
  const tabFocus = useRef<{
    tool: WorkbarContentTool | null;
    scope: string;
    closing?: boolean;
  } | null>(null);
  useLayoutEffect(() => {
    const requested = tabFocus.current;
    tabFocus.current = null;
    if (
      !requested ||
      requested.scope !== browserScope ||
      !visible ||
      (requested.tool
        ? tabs.launcherOpen || tabs.active !== requested.tool
        : !tabs.launcherOpen)
    )
      return;
    // Menu dismissal restores its trigger; closing a tab removes its button.
    // Transfer only after the resulting tab or launcher has committed.
    const frame = requestAnimationFrame(() => {
      const target = requested.tool
        ? tabButtons.current.get(requested.tool)
        : openToolsButton.current;
      if (!target?.isConnected || target.closest("[hidden], [inert]")) return;
      if (
        requested.closing &&
        document.activeElement !== document.body &&
        !target.closest(".workbar-panel")?.contains(document.activeElement)
      )
        return;
      target.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [tabs, browserScope, visible]);
  const browserActive =
    visible && !tabs.launcherOpen && tabs.active === "browser" && canControl;
  const [retainedBrowser, setRetainedBrowser] = useState<string | null>(null);
  useLayoutEffect(() => {
    // Only a page opened in this mounted Session survives a tool switch.
    // Restoring another Session's tab list must not start hidden webpages.
    if (browserActive) setRetainedBrowser(browserScope);
    else if (
      !visible ||
      !canControl ||
      !tabs.tabs.includes("browser") ||
      retainedBrowser !== browserScope
    )
      setRetainedBrowser(null);
  }, [browserActive, browserScope, visible, canControl, tabs, retainedBrowser]);
  useLayoutEffect(() => {
    if (readingState) {
      readingState.tabs = tabs;
      readingState.requestRevision = requestRevision;
    }
  }, [readingState, tabs, requestRevision]);
  const savedReview = useTurnReview(
    sessionId,
    sessionPath,
    cwd,
    reviewTurn?.promptEntryId,
  );
  const handledRequest = useRef(requestRevision);
  useEffect(() => {
    onActiveToolChange?.(
      visible ? (tabs.launcherOpen ? "launcher" : tabs.active) : null,
    );
    return () => onActiveToolChange?.(null);
  }, [visible, tabs.launcherOpen, tabs.active, onActiveToolChange]);
  useEffect(() => {
    if (handledRequest.current === requestRevision) return;
    handledRequest.current = requestRevision;
    setTabs((current) => openWorkbarTool(current, requestedTool));
  }, [requestRevision, requestedTool]);

  const select = (tool: WorkbarTool) => {
    setTabs((current) => openWorkbarTool(current, tool));
  };
  const closeTab = (tool: WorkbarContentTool, focusOwner: HTMLElement) => {
    const next = closeWorkbarTool(tabs, tool);
    if (focusOwner.contains(document.activeElement))
      tabFocus.current = {
        tool: next.launcherOpen ? null : next.active,
        scope: browserScope,
        closing: true,
      };
    setTabs(next);
  };
  const activeLabel = tabs.active
    ? launcherTools.find((tool) => tool.kind === tabs.active)?.title
    : "openTools";
  const menuItems = launcherTools.map((tool) => {
    const Icon = tool.icon;
    return {
      id: tool.kind,
      label: t(tool.title),
      description: t(tool.description),
      icon: <Icon aria-hidden="true" />,
      endContent: tabs.tabs.includes(tool.kind) ? (
        <Check aria-hidden="true" />
      ) : undefined,
      onClick: () => {
        tabFocus.current = { tool: tool.kind, scope: browserScope };
        select(tool.kind);
      },
    };
  });

  return (
    <WorkbarReadingContext.Provider value={readingState}>
      <aside
        className="workbar-panel"
        hidden={!visible}
        aria-label={t(activeLabel ?? "openTools")}
        onKeyDown={(event) => {
          if (
            event.key !== "Escape" ||
            event.defaultPrevented ||
            event.nativeEvent.isComposing
          )
            return;
          event.stopPropagation();
          if (tabs.launcherOpen && tabs.active) {
            event.preventDefault();
            setTabs(dismissWorkbarLauncher);
            return;
          }
          event.preventDefault();
          onClose();
        }}
      >
        <header className="workbar-tabbar">
          <div
            className="workbar-tabs"
            role="toolbar"
            aria-label={t("openTools")}
          >
            {tabs.tabs.length === 0 && (
              <span className="workbar-tab-placeholder">
                <Plus aria-hidden="true" /> {t("openTools")}
              </span>
            )}
            {tabs.tabs.map((tool) => {
              const definition = launcherTools.find(
                (item) => item.kind === tool,
              )!;
              const Icon = definition.icon;
              const active = !tabs.launcherOpen && tabs.active === tool;
              return (
                <div
                  className="workbar-tab"
                  data-active={active || undefined}
                  key={tool}
                >
                  <button
                    type="button"
                    ref={(button) => {
                      if (button) tabButtons.current.set(tool, button);
                      else tabButtons.current.delete(tool);
                    }}
                    aria-pressed={active}
                    title={t(definition.title)}
                    onClick={() =>
                      setTabs((current) => activateWorkbarTool(current, tool))
                    }
                  >
                    <Icon aria-hidden="true" />
                    <span>{t(definition.title)}</span>
                  </button>
                  <button
                    type="button"
                    className="workbar-tab-close"
                    aria-label={`${t("close")} ${t(definition.title)}`}
                    title={t("close")}
                    onClick={(event) => closeTab(tool, event.currentTarget)}
                  >
                    <X aria-hidden="true" />
                  </button>
                </div>
              );
            })}
          </div>
          <div className="workbar-tabbar-actions">
            <button
              type="button"
              className="workbar-back-to-chat"
              onClick={() => {
                if (conversationCollapsed) onRestoreConversation();
                else onClose();
                requestAnimationFrame(() =>
                  document
                    .querySelector<HTMLTextAreaElement>(".composer textarea")
                    ?.focus({ preventScroll: true }),
                );
              }}
            >
              <ArrowLeft aria-hidden="true" />
              <span>{t("workbarBackToChat")}</span>
            </button>
            {!conversationCollapsed &&
              tabs.active === "review" &&
              onExpandReview && (
                <button
                  type="button"
                  className="icon-button review-expand"
                  aria-label={t("gitReviewExpand")}
                  title={t("gitReviewExpand")}
                  onClick={onExpandReview}
                >
                  <PanelLeftOpen
                    aria-hidden="true"
                    style={{ transform: "rotate(180deg)" }}
                  />
                </button>
              )}
            {conversationCollapsed && (
              <button
                type="button"
                className="icon-button"
                aria-label={t("restoreConversation")}
                title={t("restoreConversation")}
                onClick={onRestoreConversation}
              >
                <PanelLeftOpen aria-hidden="true" />
              </button>
            )}
            <DropdownMenu
              button={{
                ref: openToolsButton,
                label: t("openTools"),
                icon: <Plus aria-hidden="true" />,
                isIconOnly: true,
                size: "sm",
                variant: "ghost",
                className: "workbar-add-tab",
              }}
              items={menuItems}
              menuWidth={240}
              placement="below"
              alignment="end"
              hasChevron={false}
            />
            <button
              type="button"
              className="icon-button"
              aria-label={t("close")}
              title={t("close")}
              onClick={onClose}
            >
              <X aria-hidden="true" />
            </button>
          </div>
        </header>
        <div className="workbar-panels">
          <div className="workbar-tool-panel" hidden={!tabs.launcherOpen}>
            <WorkbarLauncher onSelect={select} />
          </div>
          {tabs.tabs.map((tool) => (
            <div
              className="workbar-tool-panel"
              data-tool={tool}
              hidden={tabs.launcherOpen || tabs.active !== tool}
              inert={tabs.launcherOpen || tabs.active !== tool || !visible}
              key={tool}
            >
              {tool === "browser" &&
              visible &&
              canControl &&
              (browserActive || retainedBrowser === browserScope) ? (
                <BrowserPanel key={browserScope} />
              ) : visible && !tabs.launcherOpen && tabs.active === tool ? (
                !canControl &&
                ["side-conversation", "terminal", "browser"].includes(tool) ? (
                  <div className="workbar-empty">
                    <p>{t("toolsRequireCurrentSession")}</p>
                    {onActivateSession && (
                      <button
                        type="button"
                        className="secondary"
                        onClick={onActivateSession}
                      >
                        {t("activateViewedSession")}
                      </button>
                    )}
                  </div>
                ) : tool === "side-conversation" ? (
                  <SideConversationPanel
                    sessionId={sessionId}
                    activity={capabilities.subagents}
                  />
                ) : tool === "review" ? (
                  <ReviewPanel
                    key={
                      reviewTurn
                        ? `${reviewTurn.promptEntryId}:${reviewTurn.revision}`
                        : (review.source ?? "workspace")
                    }
                    review={
                      reviewTurn
                        ? {
                            ...savedReview,
                            setSource: (source) => {
                              review.setSource?.(source);
                              onWorkspaceReview?.();
                            },
                          }
                        : review
                    }
                    initialFilePath={
                      reviewTurn?.filePath ?? reviewInitialFilePath
                    }
                    readingScope={
                      reviewTurn
                        ? `turn:${reviewTurn.promptEntryId}:${reviewTurn.revision}`
                        : `workspace:${review.source ?? "unstaged"}`
                    }
                    onOpenFiles={() => select("files")}
                    onReferenceLine={canControl ? onReferenceLine : undefined}
                    onClose={() =>
                      setTabs((current) => closeWorkbarTool(current, "review"))
                    }
                    embedded
                  />
                ) : tool === "terminal" ? (
                  <TerminalPanel
                    sessionId={sessionId}
                    cwd={cwd}
                    activity={capabilities["background-terminals"]}
                  />
                ) : (
                  <FilesPanel
                    key={JSON.stringify([sessionId, sessionPath, cwd])}
                    sessionId={sessionId}
                    sessionPath={sessionPath}
                    cwd={cwd}
                    active
                    canWrite={canControl}
                  />
                )
              ) : null}
            </div>
          ))}
        </div>
      </aside>
    </WorkbarReadingContext.Provider>
  );
}
