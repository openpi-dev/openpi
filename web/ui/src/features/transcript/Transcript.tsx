import { StatusDot } from "@astryxdesign/core/StatusDot";
import {
  ArrowDown,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Clipboard,
  GitBranch,
  Pencil,
  RotateCcw,
  Workflow,
  Wrench,
  X,
} from "lucide-react";
import {
  Fragment,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import type { WebSubagentActivity } from "../../../../../extensions/shared/web-observer-registry.ts";
import {
  type EvidenceState,
  evidenceText,
  isEvidenceTool,
} from "../../../../protocol/evidence.ts";
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
} from "../../lib/format.ts";
import { isControlledSession } from "../../lib/session-control.ts";
import type { LiveEntry } from "../../store/web-store.ts";
import { CompactionStatus } from "./CompactionStatus.tsx";
import { FullMessageText } from "./FullMessageText.tsx";
import { PlanCard, planPresentation } from "./PlanCard.tsx";
import {
  rememberSessionReading,
  type ReadingPosition,
  type SessionReadingCache,
  sessionReadingScope,
} from "./session-reading-state.ts";
import { ToolEvidence } from "./ToolEvidence.tsx";
import {
  toolActivity,
  toolActivityLabel,
  toolActivityTarget,
} from "./tool-activity.ts";
import { type OpenTurnReview, TurnChangesCard } from "./TurnChangesCard.tsx";
import { RunningTurnElapsed, SettledTurnElapsed } from "./TurnElapsed.tsx";
import { TurnNavigation, type TurnNavigationItem } from "./TurnNavigation.tsx";
import { UserImageAttachments } from "./UserImageAttachments.tsx";
import { UserMessageContent } from "./UserMessageContent.tsx";
import { useSessionHistory } from "./use-session-history.ts";
import { usePromptNavigation } from "./use-prompt-navigation.ts";
import {
  setupDisplayMessage,
  isSetupPromptEcho,
  setupPromptParent,
} from "../../../../protocol/prompt-navigation.ts";
import "./provider-outcomes.css";
import "./conversation-navigation.css";
import "./message-branch.css";

type PersistedEntry = NonNullable<
  WebSnapshot["selectedSession"]
>["entries"][number];
interface DisplayEntry {
  compaction?: true;
  key: string;
  entryId?: string;
  timingKey?: string;
  timestamp?: string;
  message: WebLiveMessage;
  timing?: WebTurnTiming;
  optimistic?: LiveEntry["optimistic"];
}

export interface CompletedResultExposure {
  sessionId: string;
  sessionPath: string;
  commandId: string;
  finishedAt: number;
  resultEntryId: string;
}

interface TranscriptProps {
  activityObserved?: boolean;
  snapshot: WebSnapshot;
  liveMessages: LiveEntry[];
  liveRunning: boolean;
  livePhase: "idle" | "preparing" | "running";
  liveRetry: { attempt: number; maxAttempts: number } | null;
  thinkingStarts: Record<string, number>;
  thinkingDurations: Record<string, number>;
  scrollToBottom: number;
  readingCache?: SessionReadingCache;
  readingRestorePending?: boolean;
  historyNavigation?:
    | (WebHistoryAnchor & {
        revision: number;
        session: WebSessionProjection;
        restorePosition?: ReadingPosition;
      })
    | null;
  onResend: (content: string) => Promise<boolean>;
  onEdit?: (anchor: WebHistoryAnchor, content: string) => Promise<boolean>;
  onRegenerate?: (anchor: WebHistoryAnchor) => Promise<boolean>;
  onOpenOriginal?: (anchor: WebHistoryAnchor) => Promise<boolean>;
  onFork?: (anchor: WebHistoryAnchor) => Promise<boolean>;
  forkAvailable?: boolean;
  forkPending?: boolean;
  resultExposureEnabled?: boolean;
  onCompletedResultSeen?: (completion: CompletedResultExposure) => void;
  onInspectSubagent?: (id: string) => void;
  onReviewTurn?: OpenTurnReview;
  onHistoryAnchorChange?: (anchor: WebHistoryAnchor | null) => void;
  onRefreshHistory?: () => Promise<boolean>;
  onNavigateToMessage?: (
    anchor: WebHistoryAnchor,
    signal?: AbortSignal,
  ) => Promise<boolean>;
  onPromptProjection?: (
    sessionId: string,
    sessionPath: string,
    pairs: { key: string; entryId: string }[],
  ) => void;
}

type Status = "running" | "done" | "error" | "warn" | "unknown";
interface RenderRow {
  key: string;
  turn: number;
  kind: "prompt" | "process" | "response" | "outcome" | "custom";
  content: ReactNode;
  processType?: "thinking" | "tool" | "activity";
  processPreview?: string;
  processToolName?: string;
  processStatus?: Status;
  error?: boolean;
  outcome?: "completed" | "failed" | "interrupted";
  pendingPrompt?: boolean;
  promptCommandId?: string;
  promptEntryId?: string;
  commandHandledInputId?: string;
  commandHandledCommandId?: string;
  timing?: WebTurnTiming;
}

type ActiveTurn = NonNullable<WebSnapshot["runtime"]["activeTurn"]>;

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

function resultStatus(
  message?: WebLiveMessage,
  liveState?: EvidenceState,
): Status {
  if (liveState === "running") return "running";
  if (liveState === "unknown") return "unknown";
  if (!message) return "unknown";
  if (message.isError) return "error";
  const status = canonicalStatus(record(message.details).status);
  if (status !== "unknown") return status;
  return message.isError === false ? "done" : "unknown";
}

function StatusMark({ status }: { status: Status }) {
  const { t } = useTranslation();
  if (status === "running") {
    return (
      <span
        className="status-mark running"
        role="img"
        aria-label={t("toolState_running")}
      >
        <i />
      </span>
    );
  }
  if (status === "done")
    return (
      <Check className="status-mark done" aria-label={t("execution_done")} />
    );
  if (status === "error")
    return (
      <X className="status-mark error" aria-label={t("toolState_failed")} />
    );
  if (status === "warn")
    return (
      <span
        className="status-mark warn"
        role="img"
        aria-label={t("toolState_unknown")}
      >
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

type ProviderAttemptState =
  | "recovered"
  | "retrying"
  | "interrupted"
  | "earlier";

function ProviderAttempts({
  attempts,
  state,
}: {
  attempts: { entry: DisplayEntry; content?: RenderRow[] }[];
  state: ProviderAttemptState;
}) {
  const { t } = useTranslation();
  return (
    <details className={`provider-outcome provider-attempts ${state}`}>
      <summary>
        <ChevronRight aria-hidden="true" />
        {state !== "earlier" && (
          <strong>
            {t(
              state === "recovered"
                ? "modelRequestRecovered"
                : state === "retrying"
                  ? "modelRetrying"
                  : "modelRequestStopped",
            )}
          </strong>
        )}
        <span>{t("modelFailedAttempts", { count: attempts.length })}</span>
      </summary>
      <ol>
        {attempts.map(({ entry, content }) => (
          <li key={entry.key} data-history-entry={entry.entryId ?? entry.key}>
            <p>{entry.message.errorMessage || t("modelFailureUnknown")}</p>
            {content?.map((row) => (
              <Fragment key={row.key}>{row.content}</Fragment>
            ))}
          </li>
        ))}
      </ol>
    </details>
  );
}

/** A Pi run keeps failed attempts in history even after a later response. */
function providerFailures(entries: DisplayEntry[], running: boolean) {
  const finalErrors = new Set<number>();
  const groups = new Map<
    number,
    {
      attempts: DisplayEntry[];
      state: ProviderAttemptState;
    }
  >();
  let failures: number[] = [];
  let lastAssistant = -1;
  const finishRun = (timing?: WebTurnTiming, live = false) => {
    if (failures.length > 0) {
      const terminal = entries[lastAssistant]?.message.stopReason;
      const interrupted =
        timing?.outcome === "cancelled" || terminal === "aborted";
      const finalError =
        terminal === "error" && !interrupted && !(live && running);
      if (finalError) finalErrors.add(lastAssistant);
      const collapsed = finalError ? failures.slice(0, -1) : failures;
      const groupIndex = collapsed.at(-1);
      if (groupIndex !== undefined) {
        groups.set(groupIndex, {
          attempts: collapsed.map((index) => entries[index]!),
          state: interrupted
            ? "interrupted"
            : terminal === "stop" ||
                terminal === "length" ||
                terminal === "toolUse"
              ? "recovered"
              : live && running
                ? "retrying"
                : "earlier",
        });
      }
    }
    failures = [];
    lastAssistant = -1;
  };
  entries.forEach((entry, index) => {
    if (entry.optimistic) return;
    if (entry.timing) finishRun(entry.timing);
    else if (
      entry.message.role === "user" ||
      (entry.message.role === "custom" &&
        entry.message.customType === "openpi-setup-request")
    )
      finishRun();
    else if (entry.message.role === "assistant") {
      lastAssistant = index;
      if (entry.message.stopReason === "error") failures.push(index);
    }
  });
  finishRun(undefined, true);
  return { finalErrors, groups };
}

function toolSummary(name: string, args: Record<string, unknown>) {
  return compactSummary(
    toolActivityTarget(name, args).split("\n").find(Boolean),
    120,
  );
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
    600,
  );
}

function EvidenceDetails({
  body,
  icon,
  name,
  status,
  summary,
  output,
  thinking = false,
  defaultOpen = false,
}: {
  body: string;
  icon?: ReactNode;
  name: string;
  status: Status;
  summary?: string;
  output?: string;
  thinking?: boolean;
  defaultOpen?: boolean;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(defaultOpen);
  useEffect(() => setExpanded(defaultOpen), [defaultOpen]);
  const state =
    status === "done"
      ? "returned"
      : status === "error"
        ? "failed"
        : status === "running"
          ? "running"
          : "unknown";
  const showName =
    !thinking &&
    (["read", "write", "edit"].includes(name) ||
      toolActivity(name).action === "call");
  return (
    <details
      className={`message-details tool-line ${status} ${thinking ? "thinking-line" : ""}`}
      data-tool={name}
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary
        aria-label={
          thinking ? [name, summary].filter(Boolean).join(" · ") : undefined
        }
        title={thinking ? summary : undefined}
      >
        {!thinking && (
          <span className="tool-icon" aria-hidden="true">
            {icon}
          </span>
        )}
        <span className="details-title">
          {showName && <span className="tool-name">{name}</span>}
          {!thinking && (
            <span className="tool-action">
              {toolActivityLabel(t, name, state)}
            </span>
          )}
          {summary && <span className="tool-summary">{summary}</span>}
        </span>
        {thinking ? (
          <ChevronDown className="tool-disclosure" aria-hidden="true" />
        ) : (
          <ChevronRight className="tool-disclosure" aria-hidden="true" />
        )}
        {!thinking && <StatusMark status={status} />}
      </summary>
      {thinking ? (
        <div className="details-body thinking-evidence">
          {expanded && <Markdown>{evidenceText(body).text}</Markdown>}
        </div>
      ) : output === undefined ? (
        <pre className="details-body tool-evidence">
          {evidenceText(body).text}
        </pre>
      ) : (
        <>
          <figure aria-label={t("toolCallArguments")} style={{ margin: 0 }}>
            <pre className="details-body tool-evidence">
              {evidenceText(body).text}
            </pre>
          </figure>
          <figure aria-label={t("toolCallOutput")} style={{ margin: 0 }}>
            <pre className="details-body tool-evidence">
              {evidenceText(output).text || t("noOutput")}
            </pre>
          </figure>
        </>
      )}
    </details>
  );
}

function ActivityCard({
  body,
  family,
  meta,
  status,
  title,
  defaultOpen = false,
}: {
  body: string;
  family: "subagent" | "workflow";
  meta?: string;
  status: Status;
  title: string;
  defaultOpen?: boolean;
}) {
  return (
    <details
      className={`message-details activity-card ${family}`}
      open={defaultOpen || undefined}
    >
      <summary>
        <span className="activity-icon" aria-hidden="true">
          {family === "subagent" ? <Bot /> : <Workflow />}
        </span>
        <span className="activity-main">
          <span className="activity-title">{title}</span>
          {meta && <span className="activity-meta">{meta}</span>}
        </span>
        <StatusMark status={status} />
        <ChevronRight className="tool-disclosure" aria-hidden="true" />
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
  liveState?: EvidenceState,
  defaultOpen = false,
) {
  const name = part.name || "";
  const args = parseArguments(part.arguments);
  const details = record(result?.details);
  const status = resultStatus(result, liveState);
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
        defaultOpen={defaultOpen}
        onInspect={onInspectSubagent}
      />
    );
  }
  if (name.startsWith("subagent")) {
    const action = name.replaceAll("_", " ").replace(/^subagent /u, "");
    return (
      <ActivityCard
        family="subagent"
        defaultOpen={defaultOpen}
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
  defaultOpen = false,
}: {
  id?: string;
  title: string;
  meta: string;
  body: string;
  activity?: WebSubagentActivity;
  spawnFailed: boolean;
  onInspect?: (id: string) => void;
  defaultOpen?: boolean;
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
      <details className="subagent-receipt" open={defaultOpen || undefined}>
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
      name={[
        active
          ? level
            ? t("thinkingActiveLevel", { level })
            : t("thinkingActive")
          : t("thinkingDone"),
        settled,
      ]
        .filter(Boolean)
        .join(" · ")}
      status={active ? "running" : "done"}
      summary={preview || undefined}
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
  onRegenerate,
  onFork,
  canFork = false,
  forkPending = false,
}: {
  content: string;
  editable: boolean;
  copyRequiresFull?: boolean;
  timestamp?: string;
  onResend: (value: string) => Promise<boolean>;
  onRegenerate?: () => Promise<boolean>;
  onFork?: () => Promise<boolean>;
  canFork?: boolean;
  forkPending?: boolean;
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
  const editHintId = useId();
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
          aria-describedby={editHintId}
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
        <p className="message-edit-hint" id={editHintId}>
          {t("editMessageHint")}
        </p>
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
      {onFork && (
        <button
          type="button"
          aria-label={t("forkMessage")}
          title={t(
            forkPending
              ? "forkSessionPending"
              : canFork
                ? "forkMessageHint"
                : "forkSessionUnavailable",
          )}
          disabled={!canFork || forkPending}
          onClick={() => void onFork()}
        >
          <GitBranch aria-hidden="true" />
        </button>
      )}
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
      {onRegenerate && (
        <button
          type="button"
          aria-label={t("regenerateMessage")}
          title={t("regenerateMessageHint")}
          disabled={!canFork || forkPending}
          onClick={() => void onRegenerate()}
        >
          <RotateCcw aria-hidden="true" />
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

function CustomResult({
  message,
  fullSubagent = false,
}: {
  message: WebLiveMessage;
  fullSubagent?: boolean;
}) {
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
    const results = Array.isArray(details.results)
      ? details.results.map(record)
      : [details];
    const statuses = results.map((result) =>
      result.outcome === "interrupted"
        ? "warn"
        : canonicalStatus(result.status),
    );
    const status: Status = statuses.includes("error")
      ? "error"
      : statuses.includes("warn")
        ? "warn"
        : statuses.includes("running")
          ? "running"
          : statuses.length > 0 && statuses.every((value) => value === "done")
            ? "done"
            : "unknown";
    return (
      <ActivityCard
        family="subagent"
        title={t("subagentBackgroundResult", { count: results.length })}
        defaultOpen={fullSubagent}
        meta={results
          .map((result) =>
            [
              String(result.title || result.id || ""),
              result.outcome === "interrupted"
                ? t("subagentState_interrupted")
                : ["running", "done", "error"].includes(String(result.status))
                  ? t(`subagentState_${result.status}`)
                  : t("unknownState"),
            ]
              .filter(Boolean)
              .join(" · "),
          )
          .join(" / ")}
        body={
          !fullSubagent && typeof details.displayContent === "string"
            ? details.displayContent
            : message.content
        }
        status={status}
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

function messageIdentity(message: WebLiveMessage) {
  if (message.role === "toolResult" && message.toolCallId)
    return `tool-result-${message.toolCallId}`;
  if (message.timestamp !== undefined)
    return `message-${message.role}-${message.timestamp}`;
  return undefined;
}

function buildEntries(
  snapshot: WebSnapshot,
  liveMessages: LiveEntry[],
  nativeRowKeys: Map<string, string>,
) {
  const persisted = snapshot.selectedSession?.entries ?? [];
  const nativeById = new Map(persisted.map((entry) => [entry.id, entry]));
  for (const id of nativeRowKeys.keys())
    if (!nativeById.has(id)) nativeRowKeys.delete(id);
  // Native IDs own historic rows. A live disclosure can keep its existing DOM
  // only when both sides contain exactly one complete, equal projected payload.
  const exactNative = new Map<string, PersistedEntry[]>();
  const exactLive = new Map<string, LiveEntry[]>();
  const disclosureSignature = (message: WebLiveMessage) =>
    ["assistant", "toolResult"].includes(message.role ?? "") &&
    !message.truncation?.truncated
      ? JSON.stringify(message)
      : null;
  for (const entry of persisted) {
    const signature = entry.message && disclosureSignature(entry.message);
    if (!signature) continue;
    const group = exactNative.get(signature) ?? [];
    group.push(entry);
    exactNative.set(signature, group);
  }
  for (const live of liveMessages) {
    if (live.optimistic) continue;
    const signature = disclosureSignature(live.message);
    if (!signature) continue;
    const group = exactLive.get(signature) ?? [];
    group.push(live);
    exactLive.set(signature, group);
  }
  const aliasedKeys = new Set(nativeRowKeys.values());
  for (const [signature, native] of exactNative) {
    const live = exactLive.get(signature);
    if (native.length !== 1 || live?.length !== 1) continue;
    const id = native[0]!.id;
    const key = live[0]!.key;
    if (nativeRowKeys.has(id) || aliasedKeys.has(key) || nativeById.has(key))
      continue;
    nativeRowKeys.set(id, key);
    aliasedKeys.add(key);
  }
  const liveKeys = new Map(
    liveMessages.map((live) => [
      messageIdentity(live.message) ?? live.key,
      live.key,
    ]),
  );
  const entries = persisted.flatMap((entry: PersistedEntry): DisplayEntry[] => {
    if (entry.type === "compaction")
      return [
        {
          key: entry.id,
          entryId: entry.id,
          timestamp: entry.timestamp,
          compaction: true,
          message: {
            role: "custom",
            content: "",
          },
        },
      ];
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
    const parent = setupPromptParent(entry, (id) => nativeById.get(id));
    // The exact command ancestry identifies this episode. Do not collapse
    // separate setup requests merely because their text is the same.
    if (isSetupPromptEcho(entry.message, parent)) return [];
    return [
      {
        // Provider timestamps can repeat across distinct native messages. Live
        // reconciliation and timing remain separate from persisted row identity.
        key: nativeRowKeys.get(entry.id) ?? entry.id,
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
  // Pi persists custom messages without their live timestamp. Reconcile the
  // complete native payload before turning setup instructions into user text,
  // including setup echoes whose native parent already renders the command.
  const customMessages = persisted.flatMap((entry) =>
    entry.message?.role === "custom" && !entry.message.truncation?.truncated
      ? [legacySignature(entry.message)]
      : [],
  );
  const matchedCustomMessages = new Set<number>();
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
    if (live.message.role === "custom" && !live.message.truncation?.truncated) {
      const match = customMessages.findIndex(
        (signature, index) =>
          !matchedCustomMessages.has(index) &&
          signature === legacySignature(live.message),
      );
      if (match >= 0) {
        matchedCustomMessages.add(match);
        continue;
      }
    }
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
            : candidate.identity === identity &&
              candidate.signature === legacySignature(message)),
      );
      if (match >= 0) {
        matchedMessages.add(match);
        continue;
      }
    }
    const next: DisplayEntry = {
      key: live.key,
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
  // The existing projection receipt also keeps the user row's presentation
  // identity stable while its optimistic input becomes a native Session entry.
  // Native entry IDs, order and action targets remain canonical.
  const promptKeys = new Map(
    liveMessages.flatMap((live) =>
      live.optimistic?.projectedEntryId
        ? [[live.optimistic.projectedEntryId, live.key] as const]
        : [],
    ),
  );
  for (const pair of projectedPrompts) promptKeys.set(pair.entryId, pair.key);
  return {
    entries: [
      ...entries.map((entry) => {
        const key = entry.entryId && promptKeys.get(entry.entryId);
        return key ? { ...entry, key } : entry;
      }),
      ...visiblePending,
    ],
    projectedPrompts,
  };
}

function ProcessSequence({
  rows,
  active,
}: {
  rows: RenderRow[];
  active: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(active);
  useEffect(() => setOpen(active), [active]);
  const tools = rows.filter((row) => row.processType === "tool").length;
  const activities = rows.filter(
    (row) => row.processType === "activity",
  ).length;
  const counts = [
    tools ? t("processToolCount", { count: tools }) : "",
    activities ? t("processActivityCount", { count: activities }) : "",
  ].filter(Boolean);
  const preview = (active ? [...rows].reverse() : rows).find(
    (row) => row.processPreview,
  )?.processPreview;
  const failed = rows.some((row) => row.error || row.processStatus === "error");
  const status: Status = active
    ? "running"
    : failed
      ? "error"
      : rows.some((row) => row.processStatus === "warn")
        ? "warn"
        : rows.every((row) => row.processStatus === "done")
          ? "done"
          : "unknown";
  const toolNames = rows.flatMap((row) =>
    row.processToolName ? [row.processToolName] : [],
  );
  const actions = [
    ...new Set(toolNames.map((name) => toolActivity(name).action)),
  ];
  const actionLabels = actions.map((action) => t(`toolActionGroup_${action}`));
  const title = actions.length
    ? t(
        `toolGroup_${status === "done" ? "done" : active ? "running" : "unknown"}`,
        {
          actions: actionLabels.join(t("toolGroupSeparator")),
        },
      )
    : t(active ? "processRunning" : "processDetails");
  const representative =
    toolNames.find((name) => toolActivity(name).action === "web") ??
    toolNames.find((name) => name === "edit" || name === "write") ??
    toolNames[0];
  const Icon = representative ? toolActivity(representative).Icon : Wrench;
  return (
    <details
      className={`process-sequence ${status}`}
      open={open}
      data-status={status}
      data-running={active ? "true" : undefined}
      data-history-entry={rows[0]?.key}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary aria-label={[title, ...counts].join(" · ")}>
        <span className="tool-icon" aria-hidden="true">
          <Icon />
        </span>
        <span
          className="process-sequence-title"
          title={[actionLabels.join(t("toolGroupSeparator")), ...counts]
            .filter(Boolean)
            .join(" · ")}
        >
          <strong>{title}</strong>
        </span>
        <ChevronRight className="tool-disclosure" aria-hidden="true" />
        {preview && (active || !actions.length) && (
          <span className="process-sequence-preview">{preview}</span>
        )}
        <StatusMark status={status} />
      </summary>
      <div className="process-sequence-body">
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
    </details>
  );
}

function groupRows(rows: RenderRow[], active: boolean) {
  const blocks: Array<{ process: boolean; rows: RenderRow[] }> = [];
  for (const row of rows) {
    const last = blocks.at(-1);
    const process = row.kind === "process" && row.processType !== "thinking";
    if (process && last?.process) last.rows.push(row);
    else blocks.push({ process, rows: [row] });
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
      />
    );
  });
}

/** One native run, bounded by its settled timing record, within a user turn. */
function TurnRun({
  rows,
  timing,
  active,
  timedTurn,
}: {
  rows: RenderRow[];
  timing?: WebTurnTiming;
  active: boolean;
  timedTurn?: ActiveTurn;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [open, setOpen] = useState(true);
  const hasTiming = Boolean(timing || timedTurn);
  const elapsed = timing ? (
    <SettledTurnElapsed timing={timing} />
  ) : timedTurn ? (
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
  ) : null;
  return (
    <>
      {hasTiming && (
        <header className="turn-duration" data-outcome={timing?.outcome}>
          {rows.length > 0 ? (
            <button
              type="button"
              className="turn-duration-toggle"
              aria-expanded={open}
              aria-controls={id}
              onClick={() => setOpen((value) => !value)}
            >
              {elapsed}
              <ChevronRight aria-hidden="true" />
            </button>
          ) : (
            elapsed
          )}
          {timing && timing.outcome !== "completed" && (
            <span className="turn-duration-outcome">
              {t(`turnElapsedOutcome_${timing.outcome}`)}
            </span>
          )}
        </header>
      )}
      {hasTiming ? (
        <div className="turn-response-body" id={id} hidden={!open}>
          {groupRows(rows, active)}
        </div>
      ) : (
        groupRows(rows, active)
      )}
    </>
  );
}

function ConversationTurn({
  id,
  rows,
  active,
  changes,
  session,
  timedTurn,
  onReviewTurn,
}: {
  id: number;
  rows: RenderRow[];
  active: boolean;
  changes?: WebTurnChanges;
  session?: WebSessionProjection;
  timedTurn?: ActiveTurn;
  onReviewTurn?: OpenTurnReview;
}) {
  const { t } = useTranslation();
  const lastOutcome = [...rows]
    .reverse()
    .find((row) => row.outcome || row.timing);
  const outcome = lastOutcome?.timing?.outcome ?? lastOutcome?.outcome;
  const answered = rows.some((row) => row.kind === "response");
  const prompt = rows.find((row) => row.kind === "prompt");
  const commandHandled = Boolean(
    prompt?.promptEntryId &&
      rows.some(
        (row) =>
          row.commandHandledInputId === prompt.promptEntryId &&
          row.commandHandledCommandId === prompt.promptCommandId,
      ),
  );
  const status = active
    ? "running"
    : outcome === "failed"
      ? "failed"
      : outcome === "interrupted" || outcome === "cancelled"
        ? "interrupted"
        : outcome === "completed" || answered || commandHandled
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
  // A settled snapshot can arrive before the run-status notification.
  const currentTimedTurn = rows.some(
    (row) =>
      row.timing &&
      row.timing.commandId === timedTurn?.commandId &&
      row.timing.epoch === timedTurn?.epoch,
  )
    ? undefined
    : timedTurn;
  const content: ReactNode[] = [];
  let runRows: RenderRow[] = [];
  let runIndex = 0;
  const appendRun = (timing?: WebTurnTiming, current = false) => {
    content.push(
      <TurnRun
        key={`run-${runIndex++}`}
        rows={runRows}
        timing={timing}
        active={active && current}
        timedTurn={current ? currentTimedTurn : undefined}
      />,
    );
    runRows = [];
  };
  for (const row of rows) {
    if (row.kind === "prompt") {
      if (runRows.length) appendRun();
      content.push(<Fragment key={row.key}>{row.content}</Fragment>);
    } else if (row.timing) appendRun(row.timing);
    else runRows.push(row);
  }
  if (runRows.length || currentTimedTurn) appendRun(undefined, true);
  const hasTiming = Boolean(timedTurn || rows.some((row) => row.timing));
  return (
    <section
      className={`conversation-turn${id === 0 ? " prelude" : ""}`}
      data-turn={id}
    >
      {id > 0 && status !== "complete" && !hasTiming && (
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
      {content}
      {changes && session && (
        <TurnChangesCard
          key={`${session.id}:${session.path}:${changes.promptEntryId}`}
          changes={changes}
          onReview={onReviewTurn}
        />
      )}
    </section>
  );
}

function renderTurns(
  rows: RenderRow[],
  running: boolean,
  activeCommandId?: string,
  changesByPrompt?: Map<string, WebTurnChanges>,
  session?: WebSessionProjection,
  timedTurn?: ActiveTurn,
  onReviewTurn?: OpenTurnReview,
) {
  const turns: Array<{ id: number; rows: RenderRow[] }> = [];
  for (const row of rows) {
    const current = turns.at(-1);
    if (current?.id === row.turn) current.rows.push(row);
    else turns.push({ id: row.turn, rows: [row] });
  }
  if (turns.length === 0 && running) turns.push({ id: 0, rows: [] });
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
      changes={changesByPrompt?.get(
        turn.rows.find((row) => row.kind === "prompt" && !row.pendingPrompt)
          ?.promptEntryId ?? "",
      )}
      session={session}
      timedTurn={running && turn.id === activeTurn ? timedTurn : undefined}
      onReviewTurn={onReviewTurn}
      key={`turn-group-${turn.rows[0]?.key}`}
    />
  ));
}

function captureReadingPosition(
  element: HTMLElement,
  pinned: boolean,
  session?: WebSessionProjection,
) {
  const top = element.getBoundingClientRect().top;
  const anchor = Array.from(
    element.querySelectorAll<HTMLElement>(
      "[data-history-entry], [data-history-message], [data-history-result]",
    ),
  ).find((item) => {
    const bounds = item.getBoundingClientRect();
    return bounds.height > 0 && bounds.bottom > top;
  });
  const key =
    anchor?.dataset.historyEntry ??
    anchor?.dataset.historyMessage ??
    anchor?.dataset.historyResult;
  const owner = anchor?.dataset.historyMessage ?? anchor?.dataset.historyResult;
  let entryId = session?.entries.find(
    (entry) => entry.id === owner || entry.id === key,
  )?.id;
  if (!entryId && key)
    for (const entry of session?.entries ?? []) {
      if (
        key.startsWith(`${entry.id}-`) &&
        (!entryId || entry.id.length > entryId.length)
      )
        entryId = entry.id;
    }
  return {
    key: entryId ? key : undefined,
    entryId,
    offset: (anchor?.getBoundingClientRect().top ?? top) - top,
    scrollTop: element.scrollTop,
    pinned,
  };
}

function upwardInputReachesConversation(event: Event, root: HTMLElement) {
  for (const node of event.composedPath()) {
    if (node === root) return true;
    if (!(node instanceof HTMLElement)) continue;
    const style = getComputedStyle(node);
    if (!/^(auto|scroll|overlay)$/.test(style.overflowY)) continue;
    if (
      node.scrollTop > 0 ||
      /^(contain|none)$/.test(style.overscrollBehaviorY)
    )
      return false;
  }
  return false;
}

export function Transcript(props: TranscriptProps) {
  const { t } = useTranslation();
  const viewport = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const lastScrollTop = useRef(0);
  const savePositionTimer = useRef(0);
  const restorePending = useRef(props.readingRestorePending);
  restorePending.current = props.readingRestorePending;
  const [readingHistory, setReadingHistory] = useState(false);
  const reveal = useRef<AbortController | null>(null);
  const navigationObserved =
    props.activityObserved !== false && props.resultExposureEnabled !== false;
  const cancelReveal = useCallback(() => {
    reveal.current?.abort();
    reveal.current = null;
  }, []);
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
  const navigation = props.historyNavigation;
  const navigationKey = navigation
    ? JSON.stringify([
        navigation.sessionId,
        navigation.sessionPath,
        navigation.entryId,
        navigation.revision,
      ])
    : null;
  const lastNavigation = useRef<string | null>(null);
  const [highlightedNavigation, setHighlightedNavigation] =
    useState<WebHistoryAnchor | null>(null);
  const history = useSessionHistory(
    props.snapshot.selectedSession,
    {
      onAnchorChange: props.onHistoryAnchorChange,
      onRefresh: props.onRefreshHistory,
      preload:
        props.activityObserved !== false &&
        props.resultExposureEnabled !== false,
      beforePrepend: () => {
        const element = viewport.current;
        if (!element) return;
        prependAnchor.current = {
          ...captureReadingPosition(element, false, readingSession.current),
          scrollHeight: element.scrollHeight,
        };
        pinned.current = false;
      },
    },
    readingCache,
    navigation,
  );
  const selected = history.session;
  const readingSession = useRef(selected);
  readingSession.current = selected;
  const selectedId = selected?.id;
  const selectedPath = selected?.path;
  const selectedCwd = selected?.cwd;
  const highlightedEntry =
    highlightedNavigation &&
    highlightedNavigation.sessionId === selectedId &&
    highlightedNavigation.sessionPath === selectedPath
      ? highlightedNavigation.entryId
      : undefined;
  const hydrationScope = JSON.stringify([selectedId, selectedPath]);
  const promptScope = JSON.stringify([
    props.snapshot.selectedSession?.id,
    props.snapshot.selectedSession?.path,
    props.snapshot.selectedSession?.history?.leafEntryId ??
      props.snapshot.selectedSession?.entries.at(-1)?.id,
  ]);
  useLayoutEffect(() => {
    void promptScope;
    void navigationKey;
    if (!navigationObserved) cancelReveal();
    return cancelReveal;
  }, [promptScope, navigationKey, navigationObserved, cancelReveal]);
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element || !selectedId || !selectedPath) return;
    const save = () => {
      if (restorePending.current) return;
      rememberSessionReading(readingCache, hydrationScope, {
        position: captureReadingPosition(
          element,
          pinned.current,
          readingSession.current,
        ),
      });
    };
    window.addEventListener("pagehide", save);
    const onVisibility = () => {
      if (document.visibilityState === "hidden") save();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearTimeout(savePositionTimer.current);
      window.removeEventListener("pagehide", save);
      document.removeEventListener("visibilitychange", onVisibility);
      save();
    };
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
  const nativeRowKeys = useRef({
    scope: hydrationScope,
    keys: new Map<string, string>(),
  });
  if (nativeRowKeys.current.scope !== hydrationScope)
    nativeRowKeys.current = { scope: hydrationScope, keys: new Map() };
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
        nativeRowKeys.current.keys,
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
    const failures = providerFailures(entries, running && !historyPaused);
    const lastFinalError = [...failures.finalErrors].at(-1);
    const attemptContents = new Map<string, RenderRow[]>();
    const results = new Map<string, DisplayEntry>();
    const pairedToolIds = new Set<string>();
    const liveTools = historyPaused
      ? []
      : (selectedExecution?.liveTools ??
        (active ? (props.snapshot.runtime.liveTools ?? []) : []));
    entries.forEach((entry) => {
      const { message } = entry;
      if (message.role === "toolResult" && message.toolCallId)
        results.set(message.toolCallId, entry);
      message.parts?.forEach((part) => {
        if (
          part.type === "toolCall" &&
          part.id &&
          !["ask_user", "human_handoff"].includes(part.name)
        )
          pairedToolIds.add(part.id);
      });
    });
    const turnItems: TurnNavigationItem[] = [];
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

    const rendered = entries.flatMap((entry, index): RenderRow[] => {
      const message = entry.message;
      if (entry.timing)
        return [
          {
            key: entry.key,
            turn,
            kind: "custom",
            timing: entry.timing,
            content: null,
          },
        ];
      if (entry.compaction)
        return [
          {
            key: entry.key,
            turn,
            kind: "custom",
            content: <CompactionStatus compaction={{ state: "completed" }} />,
          },
        ];
      if (message.role === "custom") {
        if (message.customType === "openpi-web-command-handled") {
          const details = message.details;
          if (
            details &&
            typeof details === "object" &&
            "inputEntryId" in details &&
            typeof details.inputEntryId === "string"
          ) {
            return [
              {
                key: entry.key,
                turn,
                kind: "custom",
                commandHandledInputId: details.inputEntryId,
                commandHandledCommandId:
                  "commandId" in details &&
                  typeof details.commandId === "string"
                    ? details.commandId
                    : undefined,
                content: null,
              },
            ];
          }
          return [];
        }
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
                tabIndex={-1}
              >
                <div className="message-content">
                  <CustomResult
                    message={message}
                    fullSubagent={
                      props.snapshot.preferences.subagentResultDisplay ===
                      "full"
                    }
                  />
                </div>
              </article>
            ),
          },
        ];
      }
      if (message.role === "user") {
        latestUserPrompt = message.content;
        latestUserIndex = index;
        turn++;
        turnItems.push({
          entryId: entry.entryId ?? entry.key,
          title: Array.from(
            (message.content || t("attachedImage")).replace(/\s+/g, " ").trim(),
          )
            .slice(0, 240)
            .join(""),
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
                data-history-highlighted={
                  (highlightedEntry && entry.entryId === highlightedEntry) ||
                  undefined
                }
                tabIndex={-1}
              >
                <div className="message-content">
                  <UserImageAttachments
                    message={message}
                    sessionId={selectedId}
                    path={selectedPath}
                    entryId={entry.entryId}
                  />
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
                      <UserMessageContent content={message.content} />
                    ))}
                </div>
                <MessageActions
                  content={hydrated ?? message.content}
                  editable={
                    active &&
                    !running &&
                    Boolean(
                      props.forkAvailable &&
                        props.onEdit &&
                        entry.entryId &&
                        selectedId &&
                        selectedPath &&
                        !entry.optimistic,
                    ) &&
                    !awaitingFull
                  }
                  copyRequiresFull={awaitingFull}
                  timestamp={entry.timestamp}
                  onResend={(content) =>
                    props.onEdit && entry.entryId && selectedId && selectedPath
                      ? props.onEdit(
                          {
                            sessionId: selectedId,
                            sessionPath: selectedPath,
                            entryId: entry.entryId,
                          },
                          content,
                        )
                      : Promise.resolve(false)
                  }
                  onFork={
                    entry.entryId &&
                    selectedId &&
                    selectedPath &&
                    props.onFork &&
                    !entry.optimistic
                      ? () =>
                          props.onFork!({
                            sessionId: selectedId,
                            sessionPath: selectedPath,
                            entryId: entry.entryId!,
                          })
                      : undefined
                  }
                  canFork={active && !running && props.forkAvailable}
                  forkPending={props.forkPending}
                />
              </article>
            ),
          },
        ];
      }
      if (message.role === "assistant") {
        const landmark = turnItems.at(-1);
        if (landmark && message.content.trim())
          landmark.reply = Array.from(
            message.content.replace(/\s+/g, " ").trim(),
          )
            .slice(0, 240)
            .join("");
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
          detailRows.push({
            key,
            turn,
            kind: "response",
            content: (
              <article
                className={`message-row assistant response${actions && lastAssistantByTurn.has(index) ? " final-response" : ""}`}
                data-history-message={entry.entryId ?? entry.key}
                data-history-highlighted={
                  (highlightedEntry && entry.entryId === highlightedEntry) ||
                  undefined
                }
                tabIndex={-1}
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
                    onRegenerate={
                      landmark?.entryId &&
                      selectedId &&
                      selectedPath &&
                      props.onRegenerate &&
                      !entry.optimistic &&
                      !message.isError &&
                      (message.stopReason === "stop" ||
                        message.stopReason === "length")
                        ? () =>
                            props.onRegenerate!({
                              sessionId: selectedId,
                              sessionPath: selectedPath,
                              entryId: landmark.entryId,
                            })
                        : undefined
                    }
                    onFork={
                      entry.entryId &&
                      selectedId &&
                      selectedPath &&
                      props.onFork
                        ? () =>
                            props.onFork!({
                              sessionId: selectedId,
                              sessionPath: selectedPath,
                              entryId: entry.entryId!,
                            })
                        : undefined
                    }
                    canFork={active && !running && props.forkAvailable}
                    forkPending={props.forkPending}
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
          // Some providers return only an opaque reasoning signature. An
          // empty part is not a visible reasoning note or disclosure body.
          if (part.type === "thinking" && part.text.trim()) {
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
                <article
                  className="message-row assistant detail-only"
                  data-history-message={entry.entryId ?? entry.key}
                  data-history-highlighted={
                    (highlightedEntry && entry.entryId === highlightedEntry) ||
                    undefined
                  }
                  tabIndex={-1}
                >
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
            const defaultOpen = part.name.startsWith("subagent")
              ? props.snapshot.preferences.subagentResultDisplay === "full"
              : part.name === "bash"
                ? props.snapshot.preferences.bashToolDisplay === "full"
                : part.name === "write" || part.name === "edit"
                  ? props.snapshot.preferences.fileMutationDisplay === "full"
                  : false;
            const live = part.id
              ? liveTools.find((item) => item.call.id === part.id)
              : undefined;
            const persistedResultEntry = part.id
              ? results.get(part.id)
              : undefined;
            const persistedResult = persistedResultEntry?.message;
            const result = persistedResult ?? live?.result;
            const card =
              part.name === "plan_ready" &&
              result &&
              planPresentation(result) ? (
                <PlanCard
                  key={`${entry.key}-${part.id || partIndex}-plan`}
                  result={result}
                  sessionId={selectedId}
                  sessionPath={selectedPath}
                  entryId={persistedResultEntry?.entryId}
                />
              ) : isEvidenceTool(part.name) ? (
                <ToolEvidence
                  key={`${entry.key}-${part.id || partIndex}-evidence`}
                  call={part}
                  result={result}
                  liveState={persistedResult ? undefined : live?.state}
                  cwd={selectedCwd}
                  defaultOpen={defaultOpen}
                />
              ) : (
                familyCard(
                  part,
                  result,
                  active
                    ? props.snapshot.runtime.capabilities.subagents?.items
                    : undefined,
                  props.onInspectSubagent,
                  persistedResult ? undefined : live?.state,
                  defaultOpen,
                )
              );
            const args = parseArguments(part.arguments);
            const { Icon, action } = toolActivity(part.name);
            const toolIcon = (
              <Icon key={`${entry.key}-${part.id || partIndex}-icon`} />
            );
            const status = resultStatus(
              result,
              persistedResult ? undefined : live?.state,
            );
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
              processToolName: part.name,
              processPreview: toolSummary(part.name, args),
              processStatus: status,
              error: Boolean(result?.isError),
              content: (
                <article
                  className="message-row assistant detail-only"
                  data-history-message={entry.entryId ?? entry.key}
                  data-history-result={persistedResultEntry?.entryId}
                  data-history-highlighted={
                    (highlightedEntry &&
                      (entry.entryId === highlightedEntry ||
                        persistedResultEntry?.entryId === highlightedEntry)) ||
                    undefined
                  }
                  tabIndex={-1}
                >
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
                        summary={
                          action === "search" && typeof args.path === "string"
                            ? t("toolSearchTarget", {
                                path: args.path,
                                pattern: toolSummary(part.name, args),
                              })
                            : toolSummary(part.name, args)
                        }
                        output={
                          part.id && pairedToolIds.has(part.id)
                            ? result?.content
                            : undefined
                        }
                        status={status}
                        defaultOpen={defaultOpen}
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
          message.stopReason === "error" &&
          !failures.finalErrors.has(index)
        ) {
          attemptContents.set(entry.key, [...detailRows]);
          detailRows.length = 0;
        }
        const attempts = failures.groups.get(index);
        if (attempts) {
          detailRows.push({
            key: `${entry.key}-attempts`,
            turn,
            kind: "outcome",
            outcome:
              attempts.state === "interrupted" ? "interrupted" : undefined,
            content: (
              <article className="message-row assistant outcome-row">
                <ProviderAttempts
                  state={attempts.state}
                  attempts={attempts.attempts.map((attempt) => ({
                    entry: attempt,
                    content: attemptContents.get(attempt.key),
                  }))}
                />
              </article>
            ),
          });
        }
        if (
          failures.finalErrors.has(index) ||
          message.stopReason === "aborted"
        ) {
          const failed = message.stopReason === "error";
          const retryPrompt =
            latestUserIndex === lastUserIndex && index === lastFinalError
              ? latestUserPrompt
              : undefined;
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
        } else if (
          message.stopReason === "stop" ||
          message.stopReason === "length"
        ) {
          detailRows.push({
            key: `${entry.key}-completed`,
            turn,
            kind: "outcome",
            outcome: "completed",
            content: null,
          });
        }
        return detailRows;
      }
      if (message.role === "toolResult") {
        if (message.toolCallId && pairedToolIds.has(message.toolCallId))
          return [];
        if (planPresentation(message))
          return [
            {
              key: entry.key,
              turn,
              kind: "response",
              content: (
                <article
                  className="message-row assistant detail-only"
                  data-history-message={entry.entryId ?? entry.key}
                  data-history-highlighted={
                    (highlightedEntry && entry.entryId === highlightedEntry) ||
                    undefined
                  }
                  tabIndex={-1}
                >
                  <div className="message-content">
                    <PlanCard
                      result={message}
                      sessionId={selectedId}
                      sessionPath={selectedPath}
                      entryId={entry.entryId}
                    />
                  </div>
                </article>
              ),
            },
          ];
        const family = message.toolName?.startsWith("subagent")
          ? "subagent"
          : message.toolName?.startsWith("workflow")
            ? "workflow"
            : null;
        const status = resultStatus(message);
        const toolName = message.toolName || "tool";
        const defaultOpen =
          family === "subagent"
            ? props.snapshot.preferences.subagentResultDisplay === "full"
            : toolName === "bash"
              ? props.snapshot.preferences.bashToolDisplay === "full"
              : toolName === "write" || toolName === "edit"
                ? props.snapshot.preferences.fileMutationDisplay === "full"
                : false;
        const { Icon } = toolActivity(toolName);
        const icon = <Icon key={`${entry.key}-icon`} />;
        const content = family ? (
          <ActivityCard
            key={`${entry.key}-card`}
            family={family}
            title={`${toolName.replaceAll("_", " ")} · ${compactSummary(message.content)}`}
            body={message.content}
            status={status}
            defaultOpen={defaultOpen}
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
            defaultOpen={defaultOpen}
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
            processToolName: toolName,
            processStatus: status,
            error: status === "error",
            content: (
              <article
                className="message-row assistant detail-only"
                data-history-message={entry.entryId ?? entry.key}
                data-history-highlighted={
                  (highlightedEntry && entry.entryId === highlightedEntry) ||
                  undefined
                }
                tabIndex={-1}
              >
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
    props.onEdit,
    props.onRegenerate,
    props.onFork,
    props.forkAvailable,
    props.forkPending,
    props.onInspectSubagent,
    props.snapshot.runtime.capabilities.subagents,
    props.snapshot.preferences.expandThinking,
    props.snapshot.preferences.subagentResultDisplay,
    props.snapshot.preferences.bashToolDisplay,
    props.snapshot.preferences.fileMutationDisplay,
    props.snapshot.thinking?.level,
    props.thinkingDurations,
    props.snapshot.runtime.liveTools,
    selectedId,
    selectedPath,
    selectedCwd,
    hydratedMessages,
    highlightedEntry,
    t,
  ]);

  const promptNavigation = usePromptNavigation(
    props.snapshot.selectedSession,
    turns,
    navigationObserved,
  );
  const navigateTurn = useCallback(
    async (entryId: string, scrub = false) => {
      cancelReveal();
      if (!navigationObserved || !selectedId || !selectedPath) return false;
      const element = viewport.current;
      const target = Array.from(
        element?.querySelectorAll<HTMLElement>("[data-history-entry]") ?? [],
      ).find((item) => item.dataset.historyEntry === entryId);
      if (element && target) {
        pinned.current = false;
        setReadingHistory(true);
        setHighlightedNavigation({
          sessionId: selectedId,
          sessionPath: selectedPath,
          entryId,
        });
        const top = Math.max(
          0,
          element.scrollTop +
            target.getBoundingClientRect().top -
            element.getBoundingClientRect().top -
            16,
        );
        const reducedMotion = window.matchMedia?.(
          "(prefers-reduced-motion: reduce)",
        ).matches;
        element.scrollTo?.({
          top,
          behavior: scrub || reducedMotion ? "instant" : "smooth",
        });
        if (typeof element.scrollTo !== "function") element.scrollTop = top;
        lastScrollTop.current = element.scrollTop;
        target.focus({ preventScroll: true });
        return true;
      }
      if (scrub) return;
      if (!props.onNavigateToMessage) return false;
      const controller = new AbortController();
      reveal.current = controller;
      const result = await props.onNavigateToMessage(
        { sessionId: selectedId, sessionPath: selectedPath, entryId },
        controller.signal,
      );
      if (controller.signal.aborted || reveal.current !== controller) return;
      reveal.current = null;
      return result;
    },
    [
      cancelReveal,
      navigationObserved,
      selectedId,
      selectedPath,
      props.onNavigateToMessage,
    ],
  );

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
    if (
      navigation &&
      navigationKey !== lastNavigation.current &&
      navigation.sessionId === selected.id &&
      navigation.sessionPath === selected.path
    ) {
      pinned.current = false;
      prependAnchor.current = null;
      lastPath.current = identity;
      return;
    }
    if (requested && history.engaged) {
      prependAnchor.current = null;
      history.resetToLatest();
      return;
    }
    const restored =
      identityChanged && !historyChanged && !requested
        ? readingCache.get(identity)?.position
        : undefined;
    const restoredInWindow =
      restored?.key &&
      Array.from(
        element.querySelectorAll<HTMLElement>(
          "[data-history-entry], [data-history-message], [data-history-result]",
        ),
      ).some(
        (item) =>
          item.dataset.historyEntry === restored.key ||
          item.dataset.historyMessage === restored.key ||
          item.dataset.historyResult === restored.key,
      );
    const saved =
      prependAnchor.current ??
      (restored &&
      !restored.pinned &&
      (!restorePending.current || restoredInWindow)
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
      lastScrollTop.current = element.scrollTop;
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
      lastScrollTop.current = element.scrollTop;
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
    navigation,
    navigationKey,
  ]);

  useLayoutEffect(() => {
    const element = viewport.current;
    if (
      !element ||
      !selected ||
      !navigation ||
      navigationKey === lastNavigation.current ||
      navigation.sessionId !== selected.id ||
      navigation.sessionPath !== selected.path
    )
      return;
    const candidates = Array.from(
      element.querySelectorAll<HTMLElement>(
        "[data-history-entry], [data-history-message], [data-history-result]",
      ),
    );
    const matches = candidates.filter(
      (item) =>
        item.dataset.historyEntry === navigation.entryId ||
        item.dataset.historyMessage === navigation.entryId ||
        item.dataset.historyResult === navigation.entryId,
    );
    const restoredTarget = navigation.restorePosition?.key
      ? candidates.find(
          (item) =>
            item.dataset.historyEntry === navigation.restorePosition!.key ||
            item.dataset.historyMessage === navigation.restorePosition!.key ||
            item.dataset.historyResult === navigation.restorePosition!.key,
        )
      : undefined;
    const target =
      restoredTarget ??
      matches.find((item) => item.classList.contains("response")) ??
      matches[0];
    if (!target) return;
    // Native details retain their disclosure state; reveal only the ancestors
    // needed to make this particular message reachable.
    for (
      let parent = target.parentElement;
      parent && parent !== element;
      parent = parent.parentElement
    ) {
      if (parent instanceof HTMLDetailsElement) parent.open = true;
      if (parent.classList.contains("turn-response-body") && parent.hidden) {
        const toggle = Array.from(
          element.querySelectorAll<HTMLButtonElement>("button[aria-controls]"),
        ).find((button) =>
          button.getAttribute("aria-controls")?.split(" ").includes(parent!.id),
        );
        toggle?.click();
      }
    }
    const locate = () => {
      if (
        !element.contains(target) ||
        (navigation.restorePosition && lastNavigation.current === navigationKey)
      )
        return;
      const top = Math.max(
        0,
        element.scrollTop +
          target.getBoundingClientRect().top -
          element.getBoundingClientRect().top -
          (navigation.restorePosition &&
          (target.dataset.historyEntry === navigation.restorePosition.key ||
            target.dataset.historyMessage === navigation.restorePosition.key ||
            target.dataset.historyResult === navigation.restorePosition.key)
            ? navigation.restorePosition.offset
            : 24),
      );
      element.scrollTo?.({ top, behavior: "instant" });
      if (typeof element.scrollTo !== "function") element.scrollTop = top;
      lastScrollTop.current = element.scrollTop;
      if (!navigation.restorePosition) target.focus({ preventScroll: true });
      pinned.current = false;
      setReadingHistory(true);
      if (!navigation.restorePosition) setHighlightedNavigation(navigation);
      lastNavigation.current = navigationKey;
      rememberSessionReading(readingCache, sessionReadingScope(selected), {
        position: captureReadingPosition(element, false, selected),
      });
    };
    // The message can render before the search promise closes its native modal.
    // A modal makes the transcript inert, so wait for its close event before
    // moving focus; its own opener restoration completes before the next frame.
    const dialog = document.querySelector<HTMLDialogElement>("dialog[open]");
    let frame: number | undefined;
    const schedule = () => {
      frame = requestAnimationFrame(locate);
    };
    if (dialog) dialog.addEventListener("close", schedule, { once: true });
    else schedule();
    return () => {
      dialog?.removeEventListener("close", schedule);
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [selected, navigation, navigationKey, readingCache]);

  const reportedCompletion = useRef<string | null>(null);
  useEffect(() => {
    const element = viewport.current;
    const turn = props.snapshot.sessions.find(
      (session) =>
        session.id === selected?.id && session.path === selected?.path,
    )?.execution?.lastTurn;
    if (
      !element ||
      !selected ||
      !props.onCompletedResultSeen ||
      props.resultExposureEnabled === false ||
      props.activityObserved === false ||
      historyPaused ||
      turn?.outcome !== "completed" ||
      !turn.resultEntryId
    )
      return;
    const resultIndex = selected.entries.findIndex(
      (entry) => entry.id === turn.resultEntryId,
    );
    const result = selected.entries[resultIndex]?.message;
    const timingIndex = selected.entries.findIndex(
      (entry) =>
        entry.turnTiming?.sessionId === selected.id &&
        entry.turnTiming.commandId === turn.commandId &&
        entry.turnTiming.finishedAt === turn.finishedAt &&
        entry.turnTiming.outcome === "completed" &&
        (!entry.turnTiming.resultEntryId ||
          entry.turnTiming.resultEntryId === turn.resultEntryId),
    );
    if (
      resultIndex < 0 ||
      timingIndex <= resultIndex ||
      result?.role !== "assistant" ||
      !["stop", "length"].includes(result.stopReason ?? "")
    )
      return;
    const exposure: CompletedResultExposure = {
      sessionId: selected.id,
      sessionPath: selected.path,
      commandId: turn.commandId,
      finishedAt: turn.finishedAt,
      resultEntryId: turn.resultEntryId,
    };
    const key = JSON.stringify(exposure);
    let frame: number | undefined;
    const check = () => {
      frame = undefined;
      if (
        reportedCompletion.current === key ||
        document.visibilityState !== "visible" ||
        !element.isConnected ||
        element.closest("[hidden], [inert], [aria-hidden='true']") ||
        document.querySelector("dialog[open]")
      )
        return;
      const bounds = element.getBoundingClientRect();
      const top = Math.max(0, bounds.top);
      const bottom = Math.min(window.innerHeight, bounds.bottom);
      const left = Math.max(0, bounds.left);
      const right = Math.min(window.innerWidth, bounds.right);
      if (
        bottom <= top ||
        right <= left ||
        element.checkVisibility?.() === false
      )
        return;
      const exposed = Array.from(
        element.querySelectorAll<HTMLElement>(
          ".message-row.assistant.response[data-history-message]",
        ),
      ).some((article) => {
        if (
          article.dataset.historyMessage !== exposure.resultEntryId ||
          article.closest(
            "details:not([open]), [hidden], [inert], [aria-hidden='true']",
          )
        )
          return false;
        const content = article.querySelector<HTMLElement>(".message-content");
        if (!content || !content.textContent?.trim()) return false;
        const style = getComputedStyle(content);
        if (
          style.display === "none" ||
          style.visibility === "hidden" ||
          article.checkVisibility?.() === false
        )
          return false;
        const resultBounds = content.getBoundingClientRect();
        return (
          resultBounds.height > 0 &&
          resultBounds.width > 0 &&
          resultBounds.bottom > top &&
          resultBounds.top < bottom &&
          resultBounds.right > left &&
          resultBounds.left < right
        );
      });
      if (!exposed) return;
      reportedCompletion.current = key;
      props.onCompletedResultSeen?.(exposure);
    };
    const schedule = () => {
      if (frame === undefined) frame = requestAnimationFrame(check);
    };
    schedule();
    element.addEventListener("scroll", schedule);
    document.addEventListener("visibilitychange", schedule);
    document.addEventListener("close", schedule, true);
    window.addEventListener("resize", schedule);
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(schedule);
    observer?.observe(element);
    for (const content of element.querySelectorAll<HTMLElement>(
      ".message-content",
    ))
      observer?.observe(content);
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      observer?.disconnect();
      element.removeEventListener("scroll", schedule);
      document.removeEventListener("visibilitychange", schedule);
      document.removeEventListener("close", schedule, true);
      window.removeEventListener("resize", schedule);
    };
  }, [
    selected,
    props.snapshot.sessions,
    props.onCompletedResultSeen,
    props.resultExposureEnabled,
    props.activityObserved,
    historyPaused,
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

  const readEarlierNearTop = (element: HTMLElement) => {
    if (
      history.hasMore &&
      !history.error &&
      !history.verifying &&
      props.activityObserved !== false &&
      props.resultExposureEnabled !== false &&
      element.scrollTop <= Math.max(element.clientHeight, 160)
    )
      void history.loadOlder();
  };

  return (
    <>
      <div
        ref={viewport}
        className="conversation"
        role="log"
        aria-label="Conversation"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: The scrollport needs keyboard reading with automatic pagination.
        tabIndex={0}
        onPointerDownCapture={() => {
          if (navigation?.restorePosition)
            lastNavigation.current = navigationKey;
        }}
        onTouchStartCapture={() => {
          if (navigation?.restorePosition)
            lastNavigation.current = navigationKey;
        }}
        onScroll={(event) => {
          const element = event.currentTarget;
          const upward = element.scrollTop < lastScrollTop.current;
          const downward = element.scrollTop > lastScrollTop.current;
          lastScrollTop.current = element.scrollTop;
          // Keep an explicit reveal unpinned through its first smooth frames.
          // An older page restored at the bottom may resume normal following.
          pinned.current =
            (!highlightedEntry || pinned.current || downward) &&
            element.scrollTop + element.clientHeight >=
              element.scrollHeight - 48;
          if (!pinned.current) history.retainReading();
          setReadingHistory(!pinned.current);
          window.clearTimeout(savePositionTimer.current);
          savePositionTimer.current = window.setTimeout(() => {
            if (
              !restorePending.current &&
              selectedId &&
              selectedPath &&
              element.isConnected
            )
              rememberSessionReading(readingCache, hydrationScope, {
                position: captureReadingPosition(
                  element,
                  pinned.current,
                  readingSession.current,
                ),
              });
          }, 200);
          if (upward) readEarlierNearTop(element);
        }}
        onWheel={(event) => {
          if (navigation?.restorePosition)
            lastNavigation.current = navigationKey;
          if (
            !event.defaultPrevented &&
            !event.ctrlKey &&
            !event.metaKey &&
            event.deltaY < 0 &&
            upwardInputReachesConversation(
              event.nativeEvent,
              event.currentTarget,
            )
          )
            readEarlierNearTop(event.currentTarget);
        }}
        onKeyDown={(event) => {
          if (
            navigation?.restorePosition &&
            [
              "ArrowUp",
              "ArrowDown",
              "PageUp",
              "PageDown",
              "Home",
              "End",
              " ",
            ].includes(event.key)
          )
            lastNavigation.current = navigationKey;
          const target = event.target;
          if (
            !event.defaultPrevented &&
            !event.altKey &&
            !event.metaKey &&
            (!event.ctrlKey || event.key === "Home") &&
            (["ArrowUp", "PageUp", "Home"].includes(event.key) ||
              (event.key === " " && event.shiftKey)) &&
            target instanceof HTMLElement &&
            !target.isContentEditable &&
            !target.closest("input, textarea, select, button, summary") &&
            upwardInputReachesConversation(
              event.nativeEvent,
              event.currentTarget,
            )
          )
            readEarlierNearTop(event.currentTarget);
        }}
      >
        {selected?.rerun && props.onOpenOriginal && (
          <div className="message-branch-origin">
            <button
              type="button"
              onClick={() => void props.onOpenOriginal!(selected.rerun!.source)}
            >
              <GitBranch aria-hidden="true" /> {t("openOriginalConversation")}
            </button>
            <span>{t("messageRerunWorkspaceHint")}</span>
          </div>
        )}
        {(history.hasMore || history.error || history.verifying) && (
          <div className="conversation-history">
            {history.error && <p role="alert">{t(history.error)}</p>}
            {history.error && history.error !== "historyChanged" && (
              <button
                type="button"
                className="secondary"
                disabled={history.loading}
                onClick={() => void history.loadOlder()}
              >
                {t("retryAdmissionCheck")}
              </button>
            )}
            {history.loading && <p role="status">{t("historyLoading")}</p>}
            {history.verifying && !history.error && !history.loading && (
              <p role="status">{t("historyVerifying")}</p>
            )}
            {history.hasMore && (
              <span>
                {t("historyOmitted", {
                  count: selected?.truncation.entriesOmitted ?? 0,
                })}
              </span>
            )}
          </div>
        )}
        {renderTurns(
          rows,
          running &&
            !historyPaused &&
            selectedExecution?.compaction?.state !== "running",
          activeTurn?.commandId,
          changesByPrompt,
          selected,
          props.activityObserved !== false && !historyPaused
            ? timedTurn
            : undefined,
          props.onReviewTurn,
        )}
        {selectedExecution?.compaction &&
          selectedExecution.compaction.state !== "completed" && (
            <CompactionStatus
              key={JSON.stringify([
                selected?.id,
                selected?.path,
                selectedExecution.compaction.startedAt,
              ])}
              compaction={selectedExecution.compaction}
              observed={
                props.activityObserved !== false &&
                selectedExecution.status !== "unknown"
              }
            />
          )}
        {running && selectedExecution?.compaction?.state !== "running" && (
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
            setHighlightedNavigation(null);
            history.resetToLatest();
            element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
          }}
        >
          <ArrowDown aria-hidden="true" /> {t("jumpToLatest")}
        </button>
      )}
      <TurnNavigation
        key={promptScope}
        items={promptNavigation.items}
        viewport={viewport}
        enabled={navigationObserved}
        onHidden={cancelReveal}
        onRequestPreview={promptNavigation.requestPreview}
        readingHistory={readingHistory || history.hasNewer}
        onNavigate={navigateTurn}
      />
    </>
  );
}
