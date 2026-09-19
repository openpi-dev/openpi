import {
  ArrowLeft,
  ChevronRight,
  ExternalLink,
  FileCode2,
  FileDiff,
  FolderOutput,
  Globe2,
  MessagesSquare,
  Plus,
  Send,
  SquareTerminal,
  StopCircle,
  X,
} from "lucide-react";
import {
  type FormEvent,
  type ReactNode,
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
import { SubagentDetailView } from "../subagents/SubagentPanel.tsx";
import { generatedFiles } from "./generated-files.ts";
import { InteractiveTerminal } from "./InteractiveTerminal.tsx";
import type { WorkbarTool } from "./types.ts";

function WorkbarFrame({
  title,
  icon,
  launcher = false,
  onLauncher,
  onClose,
  children,
}: {
  title: string;
  icon: ReactNode;
  launcher?: boolean;
  onLauncher: () => void;
  onClose: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <aside
      className="workbar-panel"
      aria-label={title}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
        event.preventDefault();
        onClose();
      }}
    >
      <header className="workbar-heading">
        <div>
          {icon}
          <h2>{title}</h2>
        </div>
        <div className="workbar-heading-actions">
          {!launcher && (
            <button
              type="button"
              className="icon-button"
              aria-label={t("openTools")}
              title={t("openTools")}
              onClick={onLauncher}
            >
              <Plus aria-hidden="true" />
            </button>
          )}
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
      {children}
    </aside>
  );
}

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
  onClose,
}: {
  onSelect: (tool: WorkbarTool) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <WorkbarFrame
      title={t("openTools")}
      icon={<Plus aria-hidden="true" />}
      launcher
      onLauncher={() => undefined}
      onClose={onClose}
    >
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
    </WorkbarFrame>
  );
}

function SideConversationPanel({
  sessionId,
  activity,
  onLauncher,
  onClose,
}: {
  sessionId: string;
  activity?: WebCapabilityProjection<WebSubagentActivity>;
  onLauncher: () => void;
  onClose: () => void;
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
    <WorkbarFrame
      title={t("sideConversation")}
      icon={<MessagesSquare aria-hidden="true" />}
      onLauncher={onLauncher}
      onClose={onClose}
    >
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
                      onClick={() => setSelectedId(item.id)}
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
        <form className="side-conversation-composer" onSubmit={submit}>
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
              {t(selectedId ? "send" : "start")}
            </button>
          </div>
        </form>
      </div>
    </WorkbarFrame>
  );
}

function TerminalPanel({
  sessionId,
  cwd,
  activity,
  onLauncher,
  onClose,
}: {
  sessionId: string;
  cwd: string;
  activity?: WebCapabilityProjection<WebBackgroundTerminalActivity>;
  onLauncher: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const items = activity?.items ?? [];
  return (
    <WorkbarFrame
      title={t("terminal")}
      icon={<SquareTerminal aria-hidden="true" />}
      onLauncher={onLauncher}
      onClose={onClose}
    >
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
    </WorkbarFrame>
  );
}

function normalizedBrowserUrl(value: string) {
  const candidate = /^https?:\/\//iu.test(value.trim())
    ? value.trim()
    : `https://${value.trim()}`;
  try {
    const url = new URL(candidate);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function BrowserPanel({
  sessionId,
  onLauncher,
  onClose,
}: {
  sessionId: string;
  onLauncher: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const client = useMemo(() => new WebClient(), []);
  const abort = useRef<AbortController | null>(null);
  const storageKey = `openpi.browser.${sessionId}`;
  const initial = (() => {
    try {
      return (
        normalizedBrowserUrl(sessionStorage.getItem(storageKey) ?? "") ?? ""
      );
    } catch {
      return "";
    }
  })();
  const [draft, setDraft] = useState(initial);
  const [current, setCurrent] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [opened, setOpened] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  const launchBrowser = async () => {
    const next = normalizedBrowserUrl(draft);
    if (!next) {
      setError(t("invalidBrowserAddress"));
      return;
    }
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    setDraft(next);
    setCurrent(next);
    setError(null);
    try {
      sessionStorage.setItem(storageKey, next);
    } catch {}
    try {
      await client.openBrowser(sessionId, next, controller.signal);
      if (!controller.signal.aborted) setOpened(true);
    } catch (caught) {
      if (!controller.signal.aborted) {
        setOpened(false);
        setError(
          caught instanceof Error ? caught.message : t("browserOpenFailed"),
        );
      }
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  const navigate = (event: FormEvent) => {
    event.preventDefault();
    void launchBrowser();
  };
  return (
    <WorkbarFrame
      title={t("browser")}
      icon={<Globe2 aria-hidden="true" />}
      onLauncher={onLauncher}
      onClose={onClose}
    >
      <div className="browser-tool">
        <form className="browser-toolbar" onSubmit={navigate}>
          <input
            aria-label={t("browserAddress")}
            value={draft}
            placeholder="https://"
            onChange={(event) => setDraft(event.currentTarget.value)}
          />
          <button
            type="submit"
            aria-label={t("browserGo")}
            title={t("browserGo")}
            disabled={busy || !draft.trim()}
          >
            <ExternalLink aria-hidden="true" />
          </button>
        </form>
        {error && <p className="workbar-error">{error}</p>}
        <div
          className="browser-external-state"
          data-opened={opened || undefined}
        >
          <Globe2 aria-hidden="true" />
          <h3>{t(opened ? "browserOpened" : "browserReady")}</h3>
          <p>{current || t("workbarBrowserDescription")}</p>
          {current && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void launchBrowser()}
            >
              <ExternalLink aria-hidden="true" />
              {t(opened ? "browserOpenAgain" : "openExternalBrowser")}
            </button>
          )}
        </div>
      </div>
    </WorkbarFrame>
  );
}

function GeneratedFilesPanel({
  messages,
  onBeforeOpen,
  onLauncher,
  onClose,
}: {
  messages: readonly WebLiveMessage[];
  onBeforeOpen: () => void;
  onLauncher: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const artifacts = useContext(ArtifactContext);
  const files = useMemo(() => generatedFiles(messages), [messages]);
  return (
    <WorkbarFrame
      title={t("generatedFiles")}
      icon={<FolderOutput aria-hidden="true" />}
      onLauncher={onLauncher}
      onClose={onClose}
    >
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
                    artifacts.open(file.reference);
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
              </li>
            ))}
          </ul>
        )}
      </div>
    </WorkbarFrame>
  );
}

export function WorkbarPanel({
  tool,
  sessionId,
  cwd,
  capabilities,
  messages,
  onSelect,
  onBeforeArtifactOpen,
  onClose,
}: {
  tool: Exclude<WorkbarTool, "review">;
  sessionId: string;
  cwd: string;
  capabilities: WebCapabilitySnapshot;
  messages: readonly WebLiveMessage[];
  onSelect: (tool: WorkbarTool) => void;
  onBeforeArtifactOpen: () => void;
  onClose: () => void;
}) {
  const launcher = () => onSelect("launcher");
  if (tool === "launcher")
    return <WorkbarLauncher onSelect={onSelect} onClose={onClose} />;
  if (tool === "side-conversation")
    return (
      <SideConversationPanel
        sessionId={sessionId}
        activity={capabilities.subagents}
        onLauncher={launcher}
        onClose={onClose}
      />
    );
  if (tool === "terminal")
    return (
      <TerminalPanel
        sessionId={sessionId}
        cwd={cwd}
        activity={capabilities["background-terminals"]}
        onLauncher={launcher}
        onClose={onClose}
      />
    );
  if (tool === "browser")
    return (
      <BrowserPanel
        sessionId={sessionId}
        onLauncher={launcher}
        onClose={onClose}
      />
    );
  return (
    <GeneratedFilesPanel
      messages={messages}
      onBeforeOpen={onBeforeArtifactOpen}
      onLauncher={launcher}
      onClose={onClose}
    />
  );
}
