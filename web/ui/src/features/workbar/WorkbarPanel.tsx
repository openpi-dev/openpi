import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import {
  ArrowLeft,
  Check,
  ChevronRight,
  FileCode2,
  FileDiff,
  FolderOutput,
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
  useContext,
  useEffect,
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
import type { WebLiveMessage } from "../../../../protocol/types.ts";
import { WebClient } from "../../protocol/client.ts";
import { ArtifactContext } from "../artifacts/context.ts";
import {
  type GitReviewViewState,
  ReviewPanel,
} from "../review/ReviewPanel.tsx";
import { SubagentDetailView } from "../subagents/SubagentPanel.tsx";
import { EmbeddedBrowserPanel } from "./EmbeddedBrowserPanel.tsx";
import { generatedFiles } from "./generated-files.ts";
import { InteractiveTerminal } from "./InteractiveTerminal.tsx";
import type { WorkbarTool } from "./types.ts";
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
    icon: FolderOutput,
    title: "generatedFiles",
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
  active,
}: {
  sessionId: string;
  activity?: WebCapabilityProjection<WebSubagentActivity>;
  active: boolean;
}) {
  const { t } = useTranslation();
  const client = useMemo(() => new WebClient(), []);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
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

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || busy) return;
    abort.current?.abort();
    const controller = new AbortController();
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
      if (response.sessionId !== sessionId)
        throw new Error(t("inspectionChanged"));
      setSelectedId(response.detail.id);
      setLastStatus(response.detail.status);
      setDraft("");
      setDetailRevision((value) => value + 1);
    } catch (caught) {
      if (!controller.signal.aborted)
        setError(
          caught instanceof Error ? caught.message : t("inspectionUnavailable"),
        );
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };

  const stop = async () => {
    if (!selectedId || busy) return;
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    setError(null);
    try {
      const response = await client.subagentAction(
        sessionId,
        { kind: "subagents", action: "cancel-btw", id: selectedId },
        controller.signal,
      );
      setLastStatus(response.detail.status);
      setDetailRevision((value) => value + 1);
    } catch (caught) {
      if (!controller.signal.aborted)
        setError(
          caught instanceof Error ? caught.message : t("inspectionUnavailable"),
        );
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };

  return (
    <div className="side-conversation-body">
      {selectedId ? (
        <>
          <button
            type="button"
            className="workbar-back"
            onClick={() => {
              setSelectedId(null);
              setLastStatus(null);
              setError(null);
            }}
          >
            <ArrowLeft aria-hidden="true" /> {t("backToSideConversations")}
          </button>
          <SubagentDetailView
            key={`${sessionId}:${selectedId}:${detailRevision}`}
            sessionId={sessionId}
            id={selectedId}
            activity={selected}
            client={client}
            liveAvailable
            active={active}
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
                  <button type="button" onClick={() => setSelectedId(item.id)}>
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
          onChange={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
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

function GeneratedFilesPanel({
  active,
  messages,
  onBeforeOpen,
}: {
  active: boolean;
  messages: readonly WebLiveMessage[];
  onBeforeOpen: () => void;
}) {
  const { t } = useTranslation();
  const artifacts = useContext(ArtifactContext);
  const files = useMemo(
    () => (active ? generatedFiles(messages) : []),
    [active, messages],
  );
  return (
    <div className="workbar-resource-list generated-files-list">
      {files.length === 0 ? (
        <div className="workbar-empty">
          <FolderOutput aria-hidden="true" />
          <h3>{t("noGeneratedFiles")}</h3>
          <p>{t("workbarFilesDescription")}</p>
        </div>
      ) : (
        <ul>
          {files.map((file) => (
            <li key={file.reference}>
              <button
                type="button"
                disabled={!artifacts}
                title={file.reference}
                onClick={() => {
                  if (!artifacts) return;
                  onBeforeOpen();
                  artifacts.open(encodeURI(file.reference));
                }}
              >
                <FileCode2 aria-hidden="true" />
                <span>
                  <strong>
                    {file.path.split(/[\\/]/u).at(-1) ?? file.path}
                  </strong>
                  <small>{file.path}</small>
                </span>
                <em>{t(`fileChange_${file.change ?? file.tool}`)}</em>
                <ChevronRight aria-hidden="true" />
              </button>
              {file.diff && (
                <details className="generated-file-edit">
                  <summary>{t("recordedFileEdit")}</summary>
                  {file.diffTruncated && <p>{t("artifactPreviewTruncated")}</p>}
                  <pre>{file.diff}</pre>
                </details>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function WorkbarPanel({
  visible,
  requestedTool,
  requestRevision,
  sessionId,
  cwd,
  capabilities,
  messages,
  review,
  reviewInitialFilePath,
  conversationCollapsed,
  onRestoreConversation,
  onBeforeArtifactOpen,
  onClose,
  onActiveToolChange,
}: {
  visible: boolean;
  requestedTool: WorkbarTool;
  requestRevision: number;
  sessionId: string;
  cwd: string;
  capabilities: WebCapabilitySnapshot;
  messages: readonly WebLiveMessage[];
  review: GitReviewViewState;
  reviewInitialFilePath?: string;
  conversationCollapsed: boolean;
  onRestoreConversation: () => void;
  onBeforeArtifactOpen: () => void;
  onClose: () => void;
  onActiveToolChange?: (tool: WorkbarTool | null) => void;
}) {
  const { t } = useTranslation();
  const [tabs, setTabs] = useState(() => initialWorkbarTabs(requestedTool));
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
      onClick: () => select(tool.kind),
    };
  });

  return (
    <aside
      className="workbar-panel"
      hidden={!visible}
      aria-label={t(activeLabel ?? "openTools")}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
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
                  onClick={() =>
                    setTabs((current) => closeWorkbarTool(current, tool))
                  }
                >
                  <X aria-hidden="true" />
                </button>
              </div>
            );
          })}
        </div>
        <div className="workbar-tabbar-actions">
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
            key={tool}
          >
            {tool === "side-conversation" ? (
              <SideConversationPanel
                sessionId={sessionId}
                active={visible && !tabs.launcherOpen && tabs.active === tool}
                activity={capabilities.subagents}
              />
            ) : tool === "review" ? (
              <ReviewPanel
                active={visible && !tabs.launcherOpen && tabs.active === tool}
                review={review}
                initialFilePath={reviewInitialFilePath}
                onOpenFiles={() => select("files")}
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
            ) : tool === "browser" ? (
              <EmbeddedBrowserPanel
                sessionId={sessionId}
                active={
                  visible && !tabs.launcherOpen && tabs.active === "browser"
                }
              />
            ) : (
              <GeneratedFilesPanel
                active={
                  visible && !tabs.launcherOpen && tabs.active === "files"
                }
                messages={messages}
                onBeforeOpen={onBeforeArtifactOpen}
              />
            )}
          </div>
        ))}
      </div>
    </aside>
  );
}
