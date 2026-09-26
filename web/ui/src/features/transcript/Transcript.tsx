import { StatusDot } from "@astryxdesign/core/StatusDot";
import {
  ArrowDown,
  Bot,
  Check,
  Clipboard,
  FilePenLine,
  FileText,
  Folder,
  Globe,
  Image as ImageIcon,
  Lightbulb,
  Pencil,
  RotateCcw,
  Search,
  Terminal,
  Workflow,
  Wrench,
  X,
} from "lucide-react";
import {
  Fragment,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import type { WebSubagentActivity } from "../../../../../extensions/shared/web-observer-registry.ts";
import { evidenceText, isEvidenceTool } from "../../../../protocol/evidence.ts";
import type { WebTurnChanges } from "../../../../protocol/turn-changes.ts";
import type { WebTurnTiming } from "../../../../protocol/turn-timing.ts";
import type {
  WebHistoryAnchor,
  WebLiveMessage,
  WebMessagePart,
  WebSessionProjection,
  WebSnapshot,
} from "../../../../protocol/types.ts";
import { Markdown } from "../../components/Markdown.tsx";
import { copyText } from "../../lib/clipboard.ts";
import {
  compactSummary,
  formatElapsedMs,
  formatTurnTime,
  turnTitle,
} from "../../lib/format.ts";
import { isControlledSession } from "../../lib/session-control.ts";
import type { LiveEntry } from "../../store/web-store.ts";
import { FullMessageText } from "./FullMessageText.tsx";
import { PlanCard, planPresentation } from "./PlanCard.tsx";
import {
  rememberSessionReading,
  sessionReadingScope,
  type SessionReadingCache,
} from "./session-reading-state.ts";
import { ToolEvidence } from "./ToolEvidence.tsx";
import { TurnChangesCard } from "./TurnChangesCard.tsx";
import { RunningTurnElapsed, SettledTurnElapsed } from "./TurnElapsed.tsx";
import { useSessionHistory } from "./use-session-history.ts";

type PersistedEntry = NonNullable<
  WebSnapshot["selectedSession"]
>["entries"][number];
interface DisplayEntry {
  key: string;
  entryId?: string;
  timingKey?: string;
  timestamp?: string;
  message: WebLiveMessage;
  timing?: WebTurnTiming;
  optimistic?: LiveEntry["optimistic"];
}

interface TranscriptProps {
  snapshot: WebSnapshot;
  liveMessages: LiveEntry[];
  liveRunning: boolean;
  livePhase: "idle" | "preparing" | "running";
  liveRetry: { attempt: number; maxAttempts: number } | null;
  thinkingStarts: Record<string, number>;
  thinkingDurations: Record<string, number>;
  scrollToBottom: number;
  readingCache?: SessionReadingCache;
  onResend: (content: string) => Promise<boolean>;
  onInspectSubagent?: (id: string) => void;
  onHistoryAnchorChange?: (anchor: WebHistoryAnchor | null) => void;
  onRefreshHistory?: () => Promise<boolean>;
  onPromptProjection?: (
    sessionId: string,
    sessionPath: string,
    pairs: { key: string; entryId: string }[],
  ) => void;
}

function UserImageAttachments({ message }: { message: WebLiveMessage }) {
  const { t } = useTranslation();
  const images =
    message.parts?.filter(
      (part): part is Extract<WebMessagePart, { type: "image" }> =>
        part.type === "image",
    ) ?? [];
  if (images.length === 0) return null;
  const occurrences = new Map<string, number>();
  const keyedImages = images.map((image) => {
    const identity = `${image.mimeType}:${image.name ?? ""}:${image.previewUrl ?? ""}`;
    const occurrence = occurrences.get(identity) ?? 0;
    occurrences.set(identity, occurrence + 1);
    return { image, key: `${identity}:${occurrence}` };
  });
  return (
    <section className="message-attachments" aria-label={t("imageAttachments")}>
      {keyedImages.map(({ image, key }) => (
        <div className="message-attachment" key={key}>
          {image.previewUrl ? (
            <img
              src={image.previewUrl}
              alt={image.name ?? t("attachedImage")}
            />
          ) : (
            <ImageIcon aria-hidden="true" />
          )}
          <span>{image.name ?? t("attachedImage")}</span>
        </div>
      ))}
    </section>
  );
}

type Status = "running" | "done" | "error" | "warn" | "unknown";
interface RenderRow {
  key: string;
  turn: number;
  kind: "prompt" | "process" | "response" | "outcome" | "custom";
  content: ReactNode;
  processType?: "thinking" | "tool" | "activity";
  processPreview?: string;
  processStatus?: Status;
  error?: boolean;
  outcome?: "failed" | "interrupted";
  pendingPrompt?: boolean;
  promptCommandId?: string;
  promptEntryId?: string;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function parseArguments(raw: string) {
  try {
    return record(JSON.parse(raw));
  } catch {
    return {};
  }
}

function canonicalStatus(value: unknown): Status {
  if (value === "running") return "running";
  if (value === "done" || value === "completed") return "done";
  if (
    ["error", "failed", "aborted", "killed", "timed_out"].includes(
      String(value),
    )
  ) {
    return "error";
  }
  if (value === "uncertain") return "warn";
  return "unknown";
}

function resultStatus(message?: WebLiveMessage): Status {
  if (!message) return "running";
  if (message.isError) return "error";
  const status = canonicalStatus(record(message.details).status);
  if (status !== "unknown") return status;
  return message.isError === false ? "done" : "unknown";
}

function StatusMark({ status }: { status: Status }) {
  if (status === "running") {
    return (
      <span className="status-mark running" role="img" aria-label="running">
        <i />
      </span>
    );
  }
  if (status === "done")
    return <Check className="status-mark done" aria-label="completed" />;
  if (status === "error")
    return <X className="status-mark error" aria-label="failed" />;
  if (status === "warn")
    return (
      <span className="status-mark warn" role="img" aria-label="uncertain">
        ?
      </span>
    );
  return null;
}

function ProviderOutcome({
  failed,
  error,
  retryPrompt,
  canRetry,
  onRetry,
}: {
  failed: boolean;
  error?: string;
  retryPrompt?: string;
  canRetry: boolean;
  onRetry: (content: string) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const [retrying, setRetrying] = useState(false);
  return (
    <div
      className={`provider-outcome ${failed ? "failed" : "aborted"}`}
      role={failed ? "alert" : "status"}
    >
      <strong>
        {t(failed ? "modelRequestFailed" : "modelRequestStopped")}
      </strong>
      {failed && <p>{error || t("modelFailureUnknown")}</p>}
      {failed && <small>{t("modelFailureNextStep")}</small>}
      {failed && retryPrompt && (
        <div className="provider-outcome-actions">
          <button
            type="button"
            disabled={!canRetry || retrying}
            onClick={() => {
              setRetrying(true);
              void onRetry(retryPrompt).finally(() => setRetrying(false));
            }}
          >
            <RotateCcw aria-hidden="true" />
            {t(retrying ? "retryingPrompt" : "retryPrompt")}
          </button>
        </div>
      )}
    </div>
  );
}

function iconForTool(name: string) {
  const lowered = name.toLowerCase();
  if (lowered === "bash") return <Terminal />;
  if (lowered === "read") return <FileText />;
  if (lowered === "write" || lowered === "edit") return <FilePenLine />;
  if (lowered === "grep") return <Search />;
  if (lowered === "glob" || lowered === "ls") return <Folder />;
  if (lowered === "webfetch" || lowered === "websearch") return <Globe />;
  return <Wrench />;
}

function toolSummary(name: string, args: Record<string, unknown>) {
  const value =
    name === "bash"
      ? args.command
      : ["read", "write", "edit", "ls"].includes(name)
        ? args.path
        : ["grep", "glob"].includes(name)
          ? args.pattern
          : name === "webfetch"
            ? args.url
            : name === "websearch"
              ? args.query
              : "";
  return typeof value === "string"
    ? compactSummary(value.split("\n").find(Boolean), 90)
    : "";
}

function thinkingPreview(body: string) {
  const line = body
    .split("\n")
    .map((value) => value.trim())
    .find(Boolean);
  if (!line) return "";
  return compactSummary(
    line
      .replace(/^#{1,6}\s+/u, "")
      .replace(/^>\s*/u, "")
      .replace(/[*_~`]+/gu, "")
      .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
      .trim(),
    110,
  );
}

function EvidenceDetails({
  body,
  icon,
  name,
  status,
  summary,
  thinking = false,
  defaultOpen = false,
}: {
  body: string;
  icon: ReactNode;
  name: string;
  status: Status;
  summary?: string;
  thinking?: boolean;
  defaultOpen?: boolean;
}) {
  return (
    <details
      className={`message-details tool-line ${status} ${thinking ? "thinking-line" : ""}`}
      open={defaultOpen || undefined}
    >
      <summary>
        <span className="details-mark" aria-hidden="true" />
        <span className="tool-icon" aria-hidden="true">
          {icon}
        </span>
        <span className="details-title">
          <span className="tool-name">{name}</span>
          {summary && <span className="tool-summary">{summary}</span>}
        </span>
        <StatusMark status={status} />
      </summary>
      <pre className="details-body tool-evidence">
        {evidenceText(body).text}
      </pre>
    </details>
  );
}

function ActivityCard({
  body,
  family,
  meta,
  status,
  title,
}: {
  body: string;
  family: "subagent" | "workflow";
  meta?: string;
  status: Status;
  title: string;
}) {
  return (
    <details className={`message-details activity-card ${family}`}>
      <summary>
        <span className="activity-icon" aria-hidden="true">
          {family === "subagent" ? <Bot /> : <Workflow />}
        </span>
        <span className="activity-main">
          <span className="activity-title">{title}</span>
          {meta && <span className="activity-meta">{meta}</span>}
        </span>
        <StatusMark status={status} />
        <span className="details-mark" aria-hidden="true" />
      </summary>
      <pre className="details-body tool-evidence">{body}</pre>
    </details>
  );
}

function familyCard(
  part: Extract<WebMessagePart, { type: "toolCall" }>,
  result?: WebLiveMessage,
  subagents: readonly WebSubagentActivity[] = [],
  onInspectSubagent?: (id: string) => void,
) {
  const name = part.name || "";
  const args = parseArguments(part.arguments);
  const details = record(result?.details);
  const status = resultStatus(result);
  if (name === "subagent_spawn") {
    const meta = [args.agent_type, details.model || args.model]
      .filter(Boolean)
      .join(" · ");
    return (
      <SubagentCard
        id={typeof details.id === "string" ? details.id : undefined}
        title={String(details.title || args.name || "subagent")}
        meta={meta}
        body={result?.content || String(args.prompt || part.arguments)}
        activity={subagents.find((item) => item.id === details.id)}
        spawnFailed={result?.isError === true}
        onInspect={onInspectSubagent}
      />
    );
  }
  if (name.startsWith("subagent")) {
    const action = name.replaceAll("_", " ").replace(/^subagent /u, "");
    return (
      <ActivityCard
        family="subagent"
        title={`${action[0]?.toUpperCase() || ""}${action.slice(1)} Subagent`}
        meta={String(args.id || "")}
        body={result?.content || part.arguments}
        status={status}
      />
    );
  }
  if (name === "workflow") {
    const script =
      typeof args.script === "string" ? args.script : part.arguments;
    const workflowName = String(
      details.name ||
        script.match(/\bname:\s*["'`]([^"'`]+)["'`]/u)?.[1] ||
        "unnamed",
    );
    const agents = record(details.agents);
    const meta = [
      details.runId,
      details.status,
      agents.total
        ? `${Number(agents.total) - Number(agents.running || 0)}/${agents.total} agents`
        : "",
    ]
      .filter(Boolean)
      .join(" · ");
    return (
      <ActivityCard
        family="workflow"
        title={`Workflow · ${workflowName}`}
        meta={meta}
        body={result?.content || script}
        status={status}
      />
    );
  }
  if (name.startsWith("workflow")) {
    return (
      <ActivityCard
        family="workflow"
        title={name.replaceAll("_", " ")}
        meta={String(args.runId || "")}
        body={result?.content || part.arguments}
        status={status}
      />
    );
  }
  return null;
}

function SubagentCard({
  id,
  title,
  meta,
  body,
  activity,
  spawnFailed,
  onInspect,
}: {
  id?: string;
  title: string;
  meta: string;
  body: string;
  activity?: WebSubagentActivity;
  spawnFailed: boolean;
  onInspect?: (id: string) => void;
}) {
  const { t } = useTranslation();
  const state =
    activity?.outcome === "interrupted" ? "interrupted" : activity?.status;
  const label = state
    ? t(`subagentState_${state}`)
    : spawnFailed
      ? t("subagentSpawnFailed")
      : id
        ? t("subagentStateUnavailable")
        : t("subagentStarting");
  return (
    <section className="message-details activity-card subagent">
      <button
        className="subagent-card-open"
        type="button"
        disabled={!id || !onInspect}
        aria-label={t("inspectSubagent", { name: title })}
        onClick={() => id && onInspect?.(id)}
      >
        <span className="activity-icon" aria-hidden="true">
          <Bot />
        </span>
        <span className="activity-main">
          <strong className="activity-title">{title}</strong>
          {meta && <span className="activity-meta">{meta}</span>}
        </span>
        <span className={`subagent-state ${state ?? "unknown"}`}>{label}</span>
        <span aria-hidden="true">›</span>
      </button>
      <details className="subagent-receipt">
        <summary>{t("subagentSpawnReceipt")}</summary>
        <p>{t("subagentSpawnReceiptHint")}</p>
        <pre className="details-body tool-evidence">{body}</pre>
      </details>
    </section>
  );
}

function ThinkingEvidence({
  body,
  duration,
  active,
  level,
  defaultOpen,
}: {
  body: string;
  duration?: number;
  active: boolean;
  level?: string;
  defaultOpen: boolean;
}) {
  const { t } = useTranslation();
  const settled = duration !== undefined ? formatElapsedMs(0, duration) : "";
  const preview = thinkingPreview(body);
  return (
    <EvidenceDetails
      body={body}
      icon={<Lightbulb />}
      name={
        active
          ? level
            ? t("thinkingActiveLevel", { level })
            : t("thinkingActive")
          : t("thinkingDone")
      }
      status={active ? "running" : "done"}
      summary={[preview, settled].filter(Boolean).join(" · ") || undefined}
      thinking
      defaultOpen={defaultOpen}
    />
  );
}

function MessageActions({
  content,
  editable,
  copyRequiresFull = false,
  timestamp,
  onResend,
}: {
  content: string;
  editable: boolean;
  copyRequiresFull?: boolean;
  timestamp?: string;
  onResend: (value: string) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [copying, setCopying] = useState(false);
  const copyGeneration = useRef(0);
  const copyTimer = useRef<number | undefined>(undefined);
  useEffect(
    () => () => {
      copyGeneration.current += 1;
      window.clearTimeout(copyTimer.current);
    },
    [],
  );
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(content);
  const [submitting, setSubmitting] = useState(false);
  const editInput = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (editing) editInput.current?.focus();
  }, [editing]);
  const submitEdit = async () => {
    if (submitting || !draft.trim() || !editable) return;
    setSubmitting(true);
    try {
      if (await onResend(draft.trim())) setEditing(false);
    } finally {
      setSubmitting(false);
    }
  };
  if (editing) {
    return (
      <div className="message-editor">
        <textarea
          ref={editInput}
          value={draft}
          aria-label={t("editMessage")}
          readOnly={submitting}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || submitting) return;
            if (event.key === "Escape") setEditing(false);
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void submitEdit();
            }
          }}
        />
        <div className="message-edit-actions">
          <button
            type="button"
            disabled={submitting}
            onClick={() => setEditing(false)}
          >
            {t("cancel")}
          </button>
          <button
            type="button"
            className="confirm"
            disabled={submitting || !draft.trim() || !editable}
            onClick={() => void submitEdit()}
          >
            {t("confirmEdit")}
          </button>
        </div>
      </div>
    );
  }
  const time = formatTurnTime(timestamp);
  return (
    <div className={`message-actions${copyFailed ? " copy-failed" : ""}`}>
      {time && <time dateTime={timestamp}>{time}</time>}
      {editable && (
        <button
          type="button"
          aria-label={t("editMessage")}
          title={t("editMessage")}
          onClick={() => {
            setDraft(content);
            setEditing(true);
          }}
        >
          <Pencil />
        </button>
      )}
      <button
        type="button"
        aria-label={copied ? t("copiedMessage") : t("copyMessage")}
        title={
          copyRequiresFull
            ? t("messageCopyRequiresFull")
            : copied
              ? t("copiedMessage")
              : t("copyMessage")
        }
        disabled={copying || copyRequiresFull}
        onClick={() => {
          const generation = ++copyGeneration.current;
          window.clearTimeout(copyTimer.current);
          setCopying(true);
          setCopied(false);
          setCopyFailed(false);
          void copyText(content).then((success) => {
            if (generation !== copyGeneration.current) return;
            setCopying(false);
            setCopied(success);
            setCopyFailed(!success);
            if (success)
              copyTimer.current = window.setTimeout(
                () => setCopied(false),
                1_200,
              );
          });
        }}
      >
        {copied ? <Check /> : <Clipboard />}
      </button>
      {copyFailed && (
        <span className="copy-error" role="status">
          {t("copyFailed")}
        </span>
      )}
    </div>
  );
}

function CustomResult({ message }: { message: WebLiveMessage }) {
  const { t } = useTranslation();
  if (message.customType === "openpi-web-command-feedback")
    return (
      <div className="command-feedback" role="status">
        {message.content}
        {message.truncation?.truncated && (
          <p>{t("commandFeedbackTruncated")}</p>
        )}
      </div>
    );
  const details = record(message.details);
  if (
    message.customType === "openpi-setup-request" ||
    message.customType === "openpi-setup-closed"
  ) {
    return (
      <EvidenceDetails
        body={message.content}
        icon={<Wrench />}
        name={t("configureOpenPi")}
        summary={
          message.customType === "openpi-setup-closed"
            ? compactSummary(message.content)
            : undefined
        }
        status="unknown"
      />
    );
  }
  if (message.customType === "subagent-result") {
    return (
      <ActivityCard
        family="subagent"
        title={`Subagent ${String(details.id || "")} · ${String(details.title || "result")}`}
        meta={[details.outcome, details.elapsed].filter(Boolean).join(" · ")}
        body={message.content}
        status={canonicalStatus(details.status)}
      />
    );
  }
  if (message.customType === "workflow-result") {
    const entries = Array.isArray(details.entries)
      ? details.entries.map(record)
      : [];
    const statuses = entries.map((entry) => canonicalStatus(entry.status));
    const status: Status = statuses.includes("error")
      ? "error"
      : statuses.includes("warn")
        ? "warn"
        : statuses.length > 0 && statuses.every((value) => value === "done")
          ? "done"
          : statuses.includes("running")
            ? "running"
            : "unknown";
    const body = entries.length
      ? entries
          .map(
            (entry) =>
              `${entry.status === "completed" ? "✓" : "✗"} ${String(entry.summary || entry.runId || "run")}${entry.resultPreview ? `\nResult: ${entry.resultPreview}` : ""}`,
          )
          .join("\n")
      : message.content;
    return (
      <ActivityCard
        family="workflow"
        title={
          entries.length > 1
            ? `Workflow results · ${entries.length} runs`
            : `Workflow ${String(entries[0]?.runId || "result")}`
        }
        body={body}
        status={status}
      />
    );
  }
  return null;
}

function isEmptyToolOutput(content: string) {
  return ["", "[]", "{}", "null"].includes(content.trim());
}

function setupDisplayMessage(message: WebLiveMessage) {
  if (
    message.role !== "custom" ||
    message.customType !== "openpi-setup-request" ||
    message.truncation?.details
  )
    return message;
  const details = record(message.details);
  if (
    (details.command !== "openpi-setup" && details.command !== "my-pi-setup") ||
    typeof details.request !== "string"
  )
    return message;
  return {
    ...message,
    role: "user",
    content: `/${details.command}${details.request ? ` ${details.request}` : ""}`,
    parts: undefined,
  };
}

function messageIdentity(message: WebLiveMessage) {
  if (message.role === "toolResult" && message.toolCallId)
    return `tool-result-${message.toolCallId}`;
  if (message.timestamp !== undefined)
    return `message-${message.role}-${message.timestamp}`;
  return undefined;
}

function buildEntries(snapshot: WebSnapshot, liveMessages: LiveEntry[]) {
  const persisted = snapshot.selectedSession?.entries ?? [];
  const nativeById = new Map(persisted.map((entry) => [entry.id, entry]));
  const liveKeys = new Map(
    liveMessages.map((live) => [
      messageIdentity(live.message) ?? live.key,
      live.key,
    ]),
  );
  const entries = persisted.flatMap((entry: PersistedEntry): DisplayEntry[] => {
    if (
      "turnTiming" in entry &&
      entry.turnTiming &&
      entry.turnTiming.sessionId === snapshot.selectedSession?.id
    )
      return [
        {
          key: entry.id,
          timestamp: entry.timestamp,
          timing: entry.turnTiming,
          message: { role: "custom", content: "" },
        },
      ];
    if (entry.type !== "message" || !entry.message) return [];
    const message = setupDisplayMessage(entry.message);
    const parent = entry.parentId
      ? nativeById.get(entry.parentId)?.message
      : undefined;
    // The exact native parent identifies this command episode. Do not collapse
    // separate setup requests merely because their text is the same.
    if (
      entry.message.customType === "openpi-setup-request" &&
      message.role === "user" &&
      parent?.customType === "openpi-web-command-input" &&
      parent.commandId &&
      parent.content === message.content
    )
      return [];
    return [
      {
        key: messageIdentity(entry.message) ?? entry.id,
        entryId: entry.id,
        timingKey: liveKeys.get(messageIdentity(entry.message) ?? entry.id),
        timestamp: entry.timestamp,
        message,
      },
    ];
  });
  const signature = (message: WebLiveMessage) =>
    JSON.stringify([
      message.role,
      message.content,
      (message.parts ?? [])
        .filter((part) => message.role !== "user" || part.type !== "text")
        .map((part) =>
          part.type === "image"
            ? [part.type, part.mimeType, part.name]
            : part.type,
        ),
      message.stopReason,
      message.errorMessage,
      message.toolCallId,
    ]);
  const legacySignature = (message: WebLiveMessage) =>
    message.role === "user"
      ? signature(message)
      : JSON.stringify({ ...message, timestamp: undefined });
  // Preserve the mainline native-identity reconciliation of thinking/tool-only
  // messages. Legacy matching consumes one full message, rather than a Set.
  const nativeMessages = entries.map((entry) => ({
    identity: messageIdentity(entry.message),
    signature: legacySignature(entry.message),
  }));
  const matchedMessages = new Set<number>();
  const persistedPositions = new Map(
    persisted.map((entry, index) => [entry.id, index]),
  );
  const promptCandidates = entries
    .filter((entry) => entry.message.role === "user")
    .map((entry) => ({
      key: entry.entryId ?? entry.key,
      position: persistedPositions.get(entry.entryId ?? entry.key),
      parentId: nativeById.get(entry.entryId ?? entry.key)?.parentId,
      signature: signature(entry.message),
    }));
  const commandInputs = new Map(
    entries.flatMap((entry) =>
      entry.message.role === "user" &&
      entry.message.customType === "openpi-web-command-input" &&
      entry.message.commandId
        ? [[entry.message.commandId, entry.entryId ?? entry.key] as const]
        : [],
    ),
  );
  const acknowledgedPrompts = new Set(
    liveMessages.flatMap((entry) =>
      entry.optimistic?.projectedEntryId
        ? [entry.optimistic.projectedEntryId]
        : [],
    ),
  );
  const projectedPrompts: { key: string; entryId: string }[] = [];
  const pendingPrompts: DisplayEntry[] = [];
  const execution =
    snapshot.selectedExecution?.sessionId === snapshot.selectedSession?.id &&
    snapshot.selectedExecution?.sessionPath === snapshot.selectedSession?.path
      ? snapshot.selectedExecution
      : undefined;
  const queued = execution?.pendingFollowUps ?? 0;
  const mergeLimit = Math.max(
    0,
    liveMessages.filter(
      (entry) =>
        entry.optimistic?.admitted &&
        !entry.optimistic.projectedEntryId &&
        !commandInputs.has(entry.optimistic.commandId),
    ).length - queued,
  );
  let mergedRegularPrompts = 0;
  const suppressedLiveUsers = new Set<string>();
  for (const live of liveMessages) {
    if (live.optimistic?.projectedEntryId) continue;
    const commandId =
      live.optimistic?.commandId ??
      (live.key.startsWith("optimistic-")
        ? live.key.slice("optimistic-".length)
        : undefined);
    const commandEntry = commandId ? commandInputs.get(commandId) : undefined;
    if (commandEntry) {
      if (live.optimistic)
        projectedPrompts.push({ key: live.key, entryId: commandEntry });
      continue;
    }
    const message = setupDisplayMessage(live.message);
    if (message.role === "user" && live.optimistic) {
      // This only merges duplicate presentation; it is not a delivery receipt.
      const after =
        live.optimistic.afterEntryId === null
          ? -1
          : persistedPositions.get(live.optimistic.afterEntryId);
      const acknowledgement =
        !live.optimistic.admitted || mergedRegularPrompts >= mergeLimit
          ? undefined
          : promptCandidates.find(
              (entry) =>
                entry.position !== undefined &&
                (after !== undefined
                  ? entry.position > after
                  : entry.parentId === live.optimistic?.afterEntryId) &&
                !acknowledgedPrompts.has(entry.key) &&
                entry.signature === signature(message),
            );
      if (acknowledgement) {
        acknowledgedPrompts.add(acknowledgement.key);
        projectedPrompts.push({ key: live.key, entryId: acknowledgement.key });
        mergedRegularPrompts++;
        continue;
      }
    } else {
      const admission =
        message.role === "user"
          ? liveMessages.find(
              (pending) =>
                pending.optimistic?.admitted &&
                !pending.optimistic.projectedEntryId &&
                !suppressedLiveUsers.has(pending.key) &&
                !projectedPrompts.some((pair) => pair.key === pending.key) &&
                pending.optimistic.sessionId === snapshot.selectedSession?.id &&
                pending.optimistic.sessionPath ===
                  snapshot.selectedSession?.path &&
                signature(setupDisplayMessage(pending.message)) ===
                  signature(message),
            )
          : undefined;
      if (admission) {
        suppressedLiveUsers.add(admission.key);
        continue;
      }
      const identity = messageIdentity(message);
      const legacy =
        identity === undefined ? legacySignature(message) : undefined;
      const match = nativeMessages.findIndex(
        (candidate, index) =>
          !matchedMessages.has(index) &&
          (identity === undefined
            ? candidate.signature === legacy
            : candidate.identity === identity),
      );
      if (match >= 0) {
        matchedMessages.add(match);
        continue;
      }
    }
    const next: DisplayEntry = {
      key: messageIdentity(message) ?? live.key,
      timingKey: live.key,
      timestamp: live.timestamp ?? new Date().toISOString(),
      message,
      optimistic: live.optimistic,
    };
    if (message.role === "user" && live.optimistic) pendingPrompts.push(next);
    else entries.push(next);
  }
  const queueCounts = new Map<string, number>();
  for (const message of execution?.queuedMessages ?? [])
    queueCounts.set(message, (queueCounts.get(message) ?? 0) + 1);
  const visiblePending = pendingPrompts.filter((entry) => {
    if (
      !entry.optimistic?.admitted ||
      entry.optimistic.commandId === execution?.activeTurn?.commandId
    )
      return true;
    const count = queueCounts.get(entry.message.content) ?? 0;
    if (!count) return true;
    queueCounts.set(entry.message.content, count - 1);
    return false;
  });
  return { entries: [...entries, ...visiblePending], projectedPrompts };
}

function ProcessSequence({
  rows,
  active,
  defaultOpen,
}: {
  rows: RenderRow[];
  active: boolean;
  defaultOpen: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(active || defaultOpen);
  const previous = useRef({ active, defaultOpen });
  useEffect(() => {
    const prior = previous.current;
    if (active && !prior.active) setOpen(true);
    else if (!active && prior.active) setOpen(defaultOpen);
    else if (!active && defaultOpen !== prior.defaultOpen) setOpen(defaultOpen);
    previous.current = { active, defaultOpen };
  }, [active, defaultOpen]);
  const thinking = rows.filter((row) => row.processType === "thinking").length;
  const tools = rows.filter((row) => row.processType === "tool").length;
  const activities = rows.filter(
    (row) => row.processType === "activity",
  ).length;
  const counts = [
    thinking ? t("processThinkingCount", { count: thinking }) : "",
    tools ? t("processToolCount", { count: tools }) : "",
    activities ? t("processActivityCount", { count: activities }) : "",
  ].filter(Boolean);
  const preview = rows.find((row) => row.processPreview)?.processPreview;
  const failed = rows.some((row) => row.error);
  const status: Status = active ? "running" : failed ? "error" : "done";
  return (
    <details
      className={`process-sequence ${status}`}
      open={open}
      data-status={status}
      data-running={active ? "true" : undefined}
      data-history-entry={rows[0]?.key}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <span className="details-mark" aria-hidden="true" />
        <span className="process-sequence-title">
          <strong>{t(active ? "processRunning" : "processDetails")}</strong>
          {counts.length > 0 && <small>{counts.join(" · ")}</small>}
        </span>
        {preview && <span className="process-sequence-preview">{preview}</span>}
        <StatusMark status={status} />
      </summary>
      <div className="process-sequence-body">
        <div>
          {rows.map((row) => (
            <div
              className={`process-step ${row.processStatus ?? "unknown"}`}
              data-status={row.processStatus ?? "unknown"}
              key={row.key}
            >
              {row.content}
            </div>
          ))}
        </div>
      </div>
    </details>
  );
}

function groupRows(rows: RenderRow[], active: boolean, defaultOpen: boolean) {
  const blocks: Array<{ process: boolean; rows: RenderRow[] }> = [];
  for (const row of rows) {
    const last = blocks.at(-1);
    if (row.kind === "process" && last?.process) last.rows.push(row);
    else blocks.push({ process: row.kind === "process", rows: [row] });
  }
  let lastProcess = -1;
  blocks.forEach((block, index) => {
    if (block.process) lastProcess = index;
  });
  return blocks.flatMap((block, index) => {
    const blockKey = `${block.process ? "process" : "rows"}-${block.rows[0]?.key}`;
    if (!block.process) {
      return block.rows.map((row) => (
        <Fragment key={row.key}>{row.content}</Fragment>
      ));
    }
    return (
      <ProcessSequence
        key={blockKey}
        rows={block.rows}
        active={active && index === lastProcess}
        defaultOpen={defaultOpen}
      />
    );
  });
}

function ConversationTurn({
  id,
  rows,
  active,
  expandProcesses,
  changes,
  session,
}: {
  id: number;
  rows: RenderRow[];
  active: boolean;
  expandProcesses: boolean;
  changes?: WebTurnChanges;
  session?: WebSessionProjection;
}) {
  const { t } = useTranslation();
  const failed = rows.some((row) => row.outcome === "failed");
  const interrupted = rows.some((row) => row.outcome === "interrupted");
  const answered = rows.some((row) => row.kind === "response");
  const status = failed
    ? "failed"
    : interrupted
      ? "interrupted"
      : active
        ? "running"
        : answered
          ? "complete"
          : "waiting";
  const variant =
    status === "failed"
      ? "error"
      : status === "interrupted"
        ? "warning"
        : status === "running"
          ? "accent"
          : status === "complete"
            ? "success"
            : "neutral";
  const statusLabel = t(`turnState_${status}`);
  return (
    <section
      className={`conversation-turn${id === 0 ? " prelude" : ""}`}
      data-turn={id}
    >
      {id > 0 && status !== "complete" && (
        <header className="turn-heading">
          <span className="sr-only">{t("turnLabel", { number: id })}</span>
          <span className={`turn-state ${status}`}>
            <StatusDot
              variant={variant}
              label={statusLabel}
              isPulsing={status === "running"}
              icon={
                status === "failed" || status === "interrupted" ? (
                  <X aria-hidden="true" />
                ) : undefined
              }
            />
            {statusLabel}
          </span>
        </header>
      )}
      {groupRows(rows, active, expandProcesses)}
      {changes && session && (
        <TurnChangesCard
          key={`${session.id}:${session.path}:${changes.promptEntryId}`}
          changes={changes}
          sessionId={session.id}
          sessionPath={session.path}
        />
      )}
    </section>
  );
}

function renderTurns(
  rows: RenderRow[],
  running: boolean,
  expandProcesses: boolean,
  activeCommandId?: string,
  changesByPrompt?: Map<string, WebTurnChanges>,
  session?: WebSessionProjection,
) {
  const turns: Array<{ id: number; rows: RenderRow[] }> = [];
  for (const row of rows) {
    const current = turns.at(-1);
    if (current?.id === row.turn) current.rows.push(row);
    else turns.push({ id: row.turn, rows: [row] });
  }
  const confirmedTurn = activeCommandId
    ? turns.find((turn) =>
        turn.rows.some((row) => row.promptCommandId === activeCommandId),
      )
    : undefined;
  let nativeTurnIndex = turns.length - 1;
  while (
    nativeTurnIndex >= 0 &&
    turns[nativeTurnIndex]!.id !== 0 &&
    !turns[nativeTurnIndex]!.rows.some(
      (row) => row.kind === "prompt" && !row.pendingPrompt,
    )
  ) {
    nativeTurnIndex--;
  }
  const activeTurn = confirmedTurn?.id ?? turns[nativeTurnIndex]?.id;
  return turns.map((turn) => (
    <ConversationTurn
      id={turn.id}
      rows={turn.rows}
      active={running && turn.id === activeTurn}
      expandProcesses={expandProcesses}
      changes={changesByPrompt?.get(
        turn.rows.find((row) => row.kind === "prompt" && !row.pendingPrompt)
          ?.promptEntryId ?? "",
      )}
      session={session}
      key={`turn-group-${turn.rows[0]?.key}`}
    />
  ));
}

function captureReadingPosition(element: HTMLElement, pinned: boolean) {
  const top = element.getBoundingClientRect().top;
  const anchor = Array.from(
    element.querySelectorAll<HTMLElement>("[data-history-entry]"),
  ).find((item) => {
    const bounds = item.getBoundingClientRect();
    return bounds.height > 0 && bounds.bottom > top;
  });
  return {
    key: anchor?.dataset.historyEntry,
    offset: (anchor?.getBoundingClientRect().top ?? top) - top,
    scrollTop: element.scrollTop,
    pinned,
  };
}

export function Transcript(props: TranscriptProps) {
  const { t } = useTranslation();
  const viewport = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [readingHistory, setReadingHistory] = useState(false);
  const lastPath = useRef<string | undefined>(undefined);
  const lastScrollRequest = useRef(props.scrollToBottom);
  const prependAnchor = useRef<{
    key?: string;
    offset: number;
    scrollTop: number;
    scrollHeight: number;
  } | null>(null);
  const readingCache = useMemo<SessionReadingCache>(
    () => props.readingCache ?? new Map(),
    [props.readingCache],
  );
  const history = useSessionHistory(
    props.snapshot.selectedSession,
    {
      onAnchorChange: props.onHistoryAnchorChange,
      onRefresh: props.onRefreshHistory,
      beforePrepend: () => {
        const element = viewport.current;
        if (!element) return;
        prependAnchor.current = {
          ...captureReadingPosition(element, false),
          scrollHeight: element.scrollHeight,
        };
        pinned.current = false;
      },
    },
    readingCache,
  );
  const selected = history.session;
  const selectedId = selected?.id;
  const selectedPath = selected?.path;
  const selectedCwd = selected?.cwd;
  const hydrationScope = JSON.stringify([selectedId, selectedPath]);
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element || !selectedId || !selectedPath) return;
    return () =>
      rememberSessionReading(readingCache, hydrationScope, {
        position: captureReadingPosition(element, pinned.current),
      });
  }, [hydrationScope, readingCache, selectedId, selectedPath]);
  const previousHydrationScope = useRef(hydrationScope);
  const [hydratedMessages, setHydratedMessages] = useState<
    Record<string, string>
  >({});
  useLayoutEffect(() => {
    if (previousHydrationScope.current === hydrationScope) return;
    previousHydrationScope.current = hydrationScope;
    setHydratedMessages({});
  }, [hydrationScope]);
  const changesByPrompt = useMemo(
    () =>
      new Map(
        (selected?.entries ?? []).flatMap((entry) =>
          entry.turnChanges && entry.turnChanges.sessionId === selected?.id
            ? [[entry.turnChanges.promptEntryId, entry.turnChanges] as const]
            : [],
        ),
      ),
    [selected?.entries, selected?.id],
  );
  const lastHistoryReset = useRef(history.reset);
  const historyPaused = history.hasNewer || history.verifying;
  const active = isControlledSession(props.snapshot, selected);
  const selectedExecution =
    props.snapshot.selectedExecution?.sessionId === selected?.id &&
    props.snapshot.selectedExecution?.sessionPath === selected?.path
      ? props.snapshot.selectedExecution
      : undefined;
  const running =
    (active && props.liveRunning) ||
    (selectedExecution
      ? selectedExecution.status === "running"
      : active && props.snapshot.runtime.status === "running");
  const { entries, projectedPrompts } = useMemo(
    () =>
      buildEntries(
        { ...props.snapshot, selectedSession: selected },
        historyPaused
          ? []
          : props.liveMessages.filter((entry) =>
              entry.optimistic
                ? entry.optimistic.sessionId === selected?.id &&
                  entry.optimistic.sessionPath === selected?.path
                : active,
            ),
      ),
    [props.snapshot, selected, active, historyPaused, props.liveMessages],
  );
  useEffect(() => {
    if (selected && projectedPrompts.length > 0)
      props.onPromptProjection?.(selected.id, selected.path, projectedPrompts);
  }, [selected, projectedPrompts, props.onPromptProjection]);

  useEffect(() => {
    const element = viewport.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      // Composer growth and window resizing must preserve bottom following.
      // Reading older messages still owns the scroll position.
      if (!pinned.current) return;
      if (typeof element.scrollTo === "function") {
        element.scrollTo({ top: element.scrollHeight, behavior: "instant" });
      } else {
        element.scrollTop = element.scrollHeight;
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const { rows, turns } = useMemo(() => {
    const results = new Map<string, WebLiveMessage>();
    const familyIds = new Set<string>();
    const specializedIds = new Set<string>();
    const liveTools = historyPaused
      ? []
      : (selectedExecution?.liveTools ??
        (active ? (props.snapshot.runtime.liveTools ?? []) : []));
    entries.forEach(({ message }) => {
      if (message.role === "toolResult" && message.toolCallId)
        results.set(message.toolCallId, message);
      message.parts?.forEach((part) => {
        if (part.type === "toolCall" && part.id && isEvidenceTool(part.name))
          specializedIds.add(part.id);
        if (
          part.type === "toolCall" &&
          part.id &&
          /^(subagent|workflow)/u.test(part.name)
        )
          familyIds.add(part.id);
      });
    });
    const planIds = new Set(
      entries.flatMap(({ message }) =>
        (message.parts ?? []).flatMap((part) =>
          part.type === "toolCall" &&
          part.name === "plan_ready" &&
          part.id &&
          planPresentation(
            results.get(part.id) ??
              liveTools.find((item) => item.call.id === part.id)?.result,
          )
            ? [part.id]
            : [],
        ),
      ),
    );
    const turnItems: Array<{ id: number; title: string }> = [];
    let turn = 0;
    let latestUserPrompt: string | undefined;
    let latestUserIndex = -1;
    let lastUserIndex = -1;
    for (let index = entries.length - 1; index >= 0; index--) {
      if (entries[index]?.message.role === "user") {
        lastUserIndex = index;
        break;
      }
      if (
        entries[index]?.message.role === "custom" &&
        entries[index]?.message.customType === "openpi-setup-request"
      )
        break;
    }
    const lastAssistantByTurn = new Set<number>();
    let assistantCandidate = -1;
    entries.forEach(({ message }, index) => {
      if (
        message.role === "user" ||
        (message.role === "custom" &&
          message.customType === "openpi-setup-request")
      ) {
        if (assistantCandidate >= 0)
          lastAssistantByTurn.add(assistantCandidate);
        assistantCandidate = -1;
      } else if (message.role === "assistant" && message.content.trim())
        assistantCandidate = index;
    });
    if (assistantCandidate >= 0) lastAssistantByTurn.add(assistantCandidate);

    // Timing is already settled runtime evidence. Place it beside a final
    // textual response only within its user/timing boundaries.
    const timingBeforeResponse = new Map<number, DisplayEntry>();
    const movedTimings = new Set<string>();
    let timingCandidate = -1;
    entries.forEach((entry, index) => {
      if (entry.timing) {
        if (timingCandidate >= 0) {
          timingBeforeResponse.set(timingCandidate, entry);
          movedTimings.add(entry.key);
        }
        timingCandidate = -1;
      } else if (
        entry.message.role === "user" ||
        (entry.message.role === "custom" &&
          entry.message.customType === "openpi-setup-request") ||
        entry.message.role === "toolResult"
      ) {
        timingCandidate = -1;
      } else if (entry.message.role === "assistant") {
        timingCandidate =
          entry.message.content.trim() &&
          !entry.message.parts?.some((part) => part.type === "toolCall")
            ? index
            : -1;
      }
    });

    const rendered = entries.flatMap((entry, index): RenderRow[] => {
      const message = entry.message;
      if (movedTimings.has(entry.key)) return [];
      if (entry.timing)
        return [
          {
            key: entry.key,
            turn,
            kind: "custom",
            content: <SettledTurnElapsed timing={entry.timing} />,
          },
        ];
      if (message.role === "custom") {
        if (
          message.display === false ||
          ![
            "openpi-web-command-feedback",
            "openpi-setup-request",
            "openpi-setup-closed",
            "subagent-result",
            "workflow-result",
          ].includes(message.customType ?? "")
        )
          return [];
        if (message.customType === "openpi-setup-request") {
          latestUserPrompt = undefined;
          latestUserIndex = -1;
          turn++;
          turnItems.push({ id: turn, title: t("configureOpenPi") });
        }
        return [
          {
            key: entry.key,
            turn,
            kind: "custom",
            content: (
              <article
                className="message-row assistant detail-only"
                data-history-entry={entry.entryId ?? entry.key}
              >
                <div className="message-content">
                  <CustomResult message={message} />
                </div>
              </article>
            ),
          },
        ];
      }
      if (message.role === "user") {
        const hasImages = message.parts?.some((part) => part.type === "image");
        latestUserPrompt = message.content;
        latestUserIndex = index;
        turn++;
        turnItems.push({
          id: turn,
          title: turnTitle(message.content || t("attachedImage")),
        });
        const hydrationKey = entry.entryId
          ? JSON.stringify([selectedId, selectedPath, entry.entryId])
          : "";
        const hydrated = hydratedMessages[hydrationKey];
        const awaitingFull = Boolean(
          message.truncation?.visibleText && hydrated === undefined,
        );
        return [
          {
            key: entry.key,
            turn,
            kind: "prompt",
            pendingPrompt: Boolean(entry.optimistic),
            promptCommandId: entry.optimistic?.commandId ?? message.commandId,
            promptEntryId: entry.entryId,
            content: (
              <article
                className="message-row user"
                id={`turn-${turn}`}
                data-history-entry={entry.entryId ?? entry.key}
              >
                <div className="message-content">
                  <UserImageAttachments message={message} />
                  {(message.content || message.truncation?.visibleText) &&
                    (entry.entryId &&
                    selectedId &&
                    selectedPath &&
                    message.truncation?.visibleText ? (
                      <FullMessageText
                        key={`${selectedId}:${selectedPath}:${entry.entryId}`}
                        preview={message.content}
                        sessionId={selectedId}
                        sessionPath={selectedPath}
                        entryId={entry.entryId}
                        markdown={false}
                        fullText={hydrated}
                        onComplete={(text) =>
                          setHydratedMessages((current) => ({
                            ...current,
                            [hydrationKey]: text,
                          }))
                        }
                      />
                    ) : (
                      <div className="message-body">{message.content}</div>
                    ))}
                </div>
                <MessageActions
                  content={hydrated ?? message.content}
                  editable={
                    active &&
                    !historyPaused &&
                    index === lastUserIndex &&
                    !hasImages &&
                    !awaitingFull
                  }
                  copyRequiresFull={awaitingFull}
                  timestamp={entry.timestamp}
                  onResend={props.onResend}
                />
              </article>
            ),
          },
        ];
      }
      if (message.role === "assistant") {
        const detailRows: RenderRow[] = [];
        const parts = message.parts ?? [];
        const lastTextIndex = parts.reduce(
          (last, part, partIndex) => (part.type === "text" ? partIndex : last),
          -1,
        );
        const recoverable = Boolean(
          entry.entryId &&
            selectedId &&
            selectedPath &&
            message.truncation?.visibleText,
        );
        const fullPreview = message.content;
        const hydrationKey = entry.entryId
          ? JSON.stringify([selectedId, selectedPath, entry.entryId])
          : "";
        const hydrated = hydratedMessages[hydrationKey];
        const awaitingFull = Boolean(
          message.truncation?.visibleText && hydrated === undefined,
        );
        const appendText = (text: string, key: string, actions: boolean) => {
          if (recoverable && !actions) return;
          if (!recoverable && !text.trim()) return;
          const settledTiming = actions
            ? timingBeforeResponse.get(index)
            : undefined;
          if (settledTiming?.timing)
            detailRows.push({
              key: settledTiming.key,
              turn,
              kind: "custom",
              content: <SettledTurnElapsed timing={settledTiming.timing} />,
            });
          detailRows.push({
            key,
            turn,
            kind: "response",
            content: (
              <article
                className={`message-row assistant response${actions && lastAssistantByTurn.has(index) ? " final-response" : ""}`}
                data-history-entry={
                  entry.entryId
                    ? `${entry.entryId}-${key.slice(entry.key.length + 1)}`
                    : key
                }
              >
                <div className="message-content">
                  {recoverable &&
                  selectedId &&
                  selectedPath &&
                  entry.entryId ? (
                    <FullMessageText
                      key={`${selectedId}:${selectedPath}:${entry.entryId}`}
                      preview={fullPreview}
                      sessionId={selectedId}
                      sessionPath={selectedPath}
                      entryId={entry.entryId}
                      markdown
                      fullText={hydrated}
                      onComplete={(text) =>
                        setHydratedMessages((current) => ({
                          ...current,
                          [hydrationKey]: text,
                        }))
                      }
                    />
                  ) : (
                    <Markdown>{text}</Markdown>
                  )}
                </div>
                {actions && lastAssistantByTurn.has(index) && (
                  <MessageActions
                    content={hydrated ?? message.content}
                    editable={false}
                    copyRequiresFull={awaitingFull}
                    timestamp={entry.timestamp}
                    onResend={props.onResend}
                  />
                )}
              </article>
            ),
          });
        };
        message.parts?.forEach((part, partIndex) => {
          if (part.type === "text" && parts[partIndex - 1]?.type !== "text") {
            let text = part.text;
            let end = partIndex + 1;
            while (parts[end]?.type === "text") {
              const next = parts[end];
              if (next?.type === "text") text += next.text;
              end++;
            }
            appendText(
              text,
              `${entry.key}-text-${partIndex}`,
              end > lastTextIndex,
            );
          }
          if (part.type === "thinking") {
            const isLive =
              !historyPaused && running && index === entries.length - 1;
            detailRows.push({
              key: `${entry.key}-thinking-${partIndex}`,
              turn,
              kind: "process",
              processType: "thinking",
              processPreview: thinkingPreview(part.text),
              processStatus: isLive ? "running" : "done",
              content: (
                <article className="message-row assistant detail-only">
                  <div className="message-content">
                    <ThinkingEvidence
                      body={part.text}
                      active={isLive}
                      level={
                        isLive ? props.snapshot.thinking?.level : undefined
                      }
                      duration={
                        props.thinkingDurations[entry.timingKey ?? entry.key]
                      }
                      defaultOpen={
                        props.snapshot.preferences.expandThinking === true
                      }
                    />
                  </div>
                </article>
              ),
            });
          }
          if (part.type === "toolCall") {
            const live = part.id
              ? liveTools.find((item) => item.call.id === part.id)
              : undefined;
            const persistedResult = part.id ? results.get(part.id) : undefined;
            const result = persistedResult ?? live?.result;
            const card =
              part.name === "plan_ready" &&
              result &&
              planPresentation(result) ? (
                <PlanCard
                  key={`${entry.key}-${part.id || partIndex}-plan`}
                  result={result}
                />
              ) : isEvidenceTool(part.name) ? (
                <ToolEvidence
                  key={`${entry.key}-${part.id || partIndex}-evidence`}
                  call={part}
                  result={result}
                  liveState={persistedResult ? undefined : live?.state}
                  cwd={selectedCwd}
                />
              ) : (
                familyCard(
                  part,
                  result,
                  active
                    ? props.snapshot.runtime.capabilities.subagents?.items
                    : undefined,
                  props.onInspectSubagent,
                )
              );
            const args = parseArguments(part.arguments);
            const toolIcon = iconForTool(part.name);
            const status = resultStatus(result);
            detailRows.push({
              key: `${entry.key}-tool-${part.id || partIndex}`,
              turn,
              kind:
                part.name === "plan_ready" && result && planPresentation(result)
                  ? "response"
                  : "process",
              processType: /^(subagent|workflow)/u.test(part.name)
                ? "activity"
                : "tool",
              processStatus: status,
              error: Boolean(result?.isError),
              content: (
                <article className="message-row assistant detail-only">
                  <div className="message-content">
                    {card || (
                      <EvidenceDetails
                        body={
                          part.name === "bash" &&
                          typeof args.command === "string"
                            ? args.command
                            : part.arguments
                        }
                        icon={toolIcon}
                        name={part.name || "tool"}
                        summary={toolSummary(part.name, args)}
                        status={status}
                      />
                    )}
                  </div>
                </article>
              ),
            });
          }
        });
        if (lastTextIndex < 0)
          appendText(message.content, `${entry.key}-answer`, true);
        if (
          message.stopReason === "error" ||
          message.stopReason === "aborted"
        ) {
          const failed = message.stopReason === "error";
          const retryPrompt =
            latestUserIndex === lastUserIndex ? latestUserPrompt : undefined;
          detailRows.push({
            key: `${entry.key}-outcome`,
            turn,
            kind: "outcome",
            error: failed,
            outcome: failed ? "failed" : "interrupted",
            content: (
              <article className="message-row assistant outcome-row">
                <ProviderOutcome
                  failed={failed}
                  error={message.errorMessage}
                  retryPrompt={retryPrompt}
                  canRetry={active && !historyPaused && !running}
                  onRetry={props.onResend}
                />
              </article>
            ),
          });
        }
        return detailRows;
      }
      if (message.role === "toolResult") {
        if (message.toolCallId && planIds.has(message.toolCallId)) return [];
        if (planPresentation(message))
          return [
            {
              key: entry.key,
              turn,
              kind: "response",
              content: (
                <article className="message-row assistant detail-only">
                  <div className="message-content">
                    <PlanCard result={message} />
                  </div>
                </article>
              ),
            },
          ];
        if (message.toolCallId && specializedIds.has(message.toolCallId))
          return [];
        if (message.toolCallId && familyIds.has(message.toolCallId)) return [];
        const family = message.toolName?.startsWith("subagent")
          ? "subagent"
          : message.toolName?.startsWith("workflow")
            ? "workflow"
            : null;
        const status = resultStatus(message);
        const toolName = message.toolName || "tool";
        const icon =
          family === "subagent" ? (
            <Bot key={`${entry.key}-icon`} />
          ) : family === "workflow" ? (
            <Workflow key={`${entry.key}-icon`} />
          ) : (
            iconForTool(toolName)
          );
        const content = family ? (
          <ActivityCard
            key={`${entry.key}-card`}
            family={family}
            title={`${toolName.replaceAll("_", " ")} · ${compactSummary(message.content)}`}
            body={message.content}
            status={status}
          />
        ) : isEmptyToolOutput(message.content) ? (
          <div className="tool-line-empty" key={`${entry.key}-empty`}>
            <span className="tool-icon">{icon}</span>
            <span className="tool-name">{toolName}</span>
            <span className="tool-summary">{t("noOutput")}</span>
            <StatusMark status={status} />
          </div>
        ) : (
          <EvidenceDetails
            key={`${entry.key}-evidence`}
            body={message.content}
            icon={icon}
            name={toolName}
            summary={compactSummary(message.content)}
            status={status}
          />
        );
        return [
          {
            key: entry.key,
            turn,
            // Human answers are settled evidence, outside moving process groups.
            kind:
              toolName === "ask_user" || toolName === "human_handoff"
                ? "response"
                : "process",
            processType: family ? "activity" : "tool",
            processStatus: status,
            error: status === "error",
            content: (
              <article className="message-row assistant detail-only">
                <div className="message-content">{content}</div>
              </article>
            ),
          },
        ];
      }
      return [];
    });
    return { rows: rendered, turns: turnItems };
  }, [
    active,
    running,
    selectedExecution,
    historyPaused,
    entries,
    props.onResend,
    props.onInspectSubagent,
    props.snapshot.runtime.capabilities.subagents,
    props.snapshot.preferences.expandThinking,
    props.snapshot.thinking?.level,
    props.thinkingDurations,
    props.snapshot.runtime.liveTools,
    selectedId,
    selectedPath,
    selectedCwd,
    hydratedMessages,
    t,
  ]);

  useLayoutEffect(() => {
    // Streamed content can grow without changing message keys.
    void entries;
    const element = viewport.current;
    if (!element || !selected) return;
    const identity = sessionReadingScope(selected);
    const identityChanged = lastPath.current !== identity;
    const historyChanged = lastHistoryReset.current !== history.reset;
    const changed = identityChanged || historyChanged;
    lastHistoryReset.current = history.reset;
    const requested = lastScrollRequest.current !== props.scrollToBottom;
    lastScrollRequest.current = props.scrollToBottom;
    if (requested && history.engaged) {
      prependAnchor.current = null;
      history.resetToLatest();
      return;
    }
    const restored =
      identityChanged && !historyChanged && !requested
        ? readingCache.get(identity)?.position
        : undefined;
    const saved =
      prependAnchor.current ??
      (restored && !restored.pinned
        ? { ...restored, scrollHeight: element.scrollHeight }
        : null);
    prependAnchor.current = null;
    if (saved && (!changed || restored) && !requested) {
      const anchor = Array.from(
        element.querySelectorAll<HTMLElement>("[data-history-entry]"),
      ).find(
        (item) =>
          item.dataset.historyEntry === saved.key &&
          item.getBoundingClientRect().height > 0,
      );
      const top = anchor
        ? element.scrollTop +
          anchor.getBoundingClientRect().top -
          element.getBoundingClientRect().top -
          saved.offset
        : saved.scrollTop + element.scrollHeight - saved.scrollHeight;
      if (typeof element.scrollTo === "function")
        element.scrollTo({ top, behavior: "instant" });
      else element.scrollTop = top;
      pinned.current = false;
      setReadingHistory(true);
      lastPath.current = identity;
      return;
    }
    if (changed || requested || pinned.current) {
      pinned.current = true;
      setReadingHistory(false);
      if (typeof element.scrollTo === "function") {
        element.scrollTo({ top: element.scrollHeight, behavior: "instant" });
      } else {
        element.scrollTop = element.scrollHeight;
      }
    }
    lastPath.current = identity;
  }, [
    selected,
    entries,
    history.reset,
    history.engaged,
    history.resetToLatest,
    props.scrollToBottom,
    readingCache,
  ]);

  const runningLabel = !active
    ? t("backgroundSessionRunning")
    : props.liveRetry
      ? `${t("modelRetrying")} (${props.liveRetry.attempt}/${props.liveRetry.maxAttempts})`
      : props.livePhase === "preparing"
        ? t("modelPreparing")
        : t("modelRunning");
  const observedRunningTools = !active
    ? (selectedExecution?.liveTools.filter((tool) => tool.state === "running")
        .length ?? 0)
    : 0;
  const activeTurn = selectedExecution
    ? selectedExecution.activeTurn
    : active
      ? props.snapshot.runtime.activeTurn
      : undefined;
  const timedTurn =
    running &&
    activeTurn &&
    selected &&
    activeTurn.sessionId === selected.id &&
    activeTurn.sessionPath === selected?.path &&
    typeof activeTurn.startedAt === "number" &&
    Number.isFinite(activeTurn.startedAt) &&
    typeof activeTurn.elapsedMs === "number" &&
    Number.isFinite(activeTurn.elapsedMs) &&
    activeTurn.elapsedMs >= 0
      ? activeTurn
      : undefined;

  return (
    <>
      <div
        ref={viewport}
        className="conversation"
        role="log"
        aria-label="Conversation"
        onScroll={(event) => {
          const element = event.currentTarget;
          pinned.current =
            element.scrollTop + element.clientHeight >=
            element.scrollHeight - 48;
          if (!pinned.current) history.retainReading();
          setReadingHistory(!pinned.current);
        }}
      >
        {(history.hasMore || history.error || history.verifying) && (
          <div className="conversation-history">
            {history.error && <p role="alert">{t(history.error)}</p>}
            {history.error &&
              history.error !== "historyChanged" &&
              !history.hasMore && (
                <button
                  type="button"
                  className="secondary"
                  onClick={() => void history.loadOlder()}
                >
                  {t("retryAdmissionCheck")}
                </button>
              )}
            {history.verifying && !history.error && (
              <p role="status">{t("historyVerifying")}</p>
            )}
            {history.hasMore && (
              <>
                <span>
                  {t("historyOmitted", {
                    count: selected?.truncation.entriesOmitted ?? 0,
                  })}
                </span>
                <button
                  type="button"
                  className="secondary"
                  disabled={
                    history.loading || (history.verifying && !history.error)
                  }
                  onClick={() => void history.loadOlder()}
                >
                  {t(history.loading ? "historyLoading" : "historyLoadOlder")}
                </button>
              </>
            )}
          </div>
        )}
        {renderTurns(
          rows,
          running && !historyPaused,
          props.snapshot.preferences.expandThinking === true,
          activeTurn?.commandId,
          changesByPrompt,
          selected,
        )}
        {running && (
          <div
            className="conversation-running"
            role="status"
            aria-live="polite"
          >
            <span className="conversation-running-dot" />
            <span>{runningLabel}</span>
            {observedRunningTools > 0 && (
              <span>
                {t("observedSessionTools", { count: observedRunningTools })}
              </span>
            )}
            {(selectedExecution?.pendingFollowUps ?? 0) > 0 && (
              <span>
                {t("pendingFollowUpsHint", {
                  count: selectedExecution!.pendingFollowUps,
                })}
              </span>
            )}
            {timedTurn && (
              <RunningTurnElapsed
                key={JSON.stringify([
                  timedTurn.sessionId,
                  timedTurn.sessionPath,
                  timedTurn.commandId,
                  timedTurn.epoch,
                  timedTurn.startedAt,
                ])}
                elapsedMs={timedTurn.elapsedMs!}
              />
            )}
          </div>
        )}
      </div>
      {(readingHistory || history.hasNewer) && rows.length > 0 && (
        <button
          className="jump-to-latest"
          type="button"
          aria-label={t("jumpToLatest")}
          title={t("jumpToLatest")}
          onClick={() => {
            const element = viewport.current;
            if (!element) return;
            pinned.current = true;
            setReadingHistory(false);
            history.resetToLatest();
            element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
          }}
        >
          <ArrowDown aria-hidden="true" /> {t("jumpToLatest")}
        </button>
      )}
      {turns.length > 1 && (
        <nav className="turn-rail" aria-label={t("conversationTurns")}>
          {turns.map((item) => (
            <button
              key={item.id}
              className="turn-tick"
              type="button"
              title={item.title}
              onClick={() =>
                document
                  .getElementById(`turn-${item.id}`)
                  ?.scrollIntoView({ block: "start", behavior: "smooth" })
              }
            >
              <span className="turn-tick-mark" />
              <span className="turn-tick-label">{item.title}</span>
            </button>
          ))}
        </nav>
      )}
    </>
  );
}
