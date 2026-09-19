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
import type {
  WebLiveMessage,
  WebMessagePart,
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
import type { LiveEntry } from "../../store/web-store.ts";
import { ToolEvidence } from "./ToolEvidence.tsx";

type PersistedEntry = NonNullable<
  WebSnapshot["selectedSession"]
>["entries"][number];
interface DisplayEntry {
  key: string;
  timestamp?: string;
  message: WebLiveMessage;
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
  onResend: (content: string) => Promise<boolean>;
  onInspectSubagent?: (id: string) => void;
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

function useElapsed(start: number | undefined, active: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [active]);
  return start ? formatElapsedMs(start, active ? now : Date.now()) : "";
}

function ThinkingEvidence({
  body,
  start,
  duration,
  active,
  level,
  defaultOpen,
}: {
  body: string;
  start?: number;
  duration?: number;
  active: boolean;
  level?: string;
  defaultOpen: boolean;
}) {
  const { t } = useTranslation();
  const elapsed = useElapsed(start, active);
  const settled = duration ? formatElapsedMs(0, duration) : elapsed;
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
  timestamp,
  onResend,
}: {
  content: string;
  editable: boolean;
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
        title={copied ? t("copiedMessage") : t("copyMessage")}
        disabled={copying}
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
  const details = record(message.details);
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

function buildEntries(
  snapshot: WebSnapshot,
  liveMessages: LiveEntry[],
): DisplayEntry[] {
  const persisted = snapshot.selectedSession?.entries ?? [];
  const entries = persisted.flatMap((entry: PersistedEntry): DisplayEntry[] =>
    entry.type === "message" && entry.message
      ? [{ key: entry.id, timestamp: entry.timestamp, message: entry.message }]
      : [],
  );
  const signature = (message: WebLiveMessage) =>
    JSON.stringify([
      message.role,
      message.content,
      message.parts?.map((part) =>
        part.type === "image"
          ? [part.type, part.mimeType, part.name]
          : part.type,
      ),
      message.stopReason,
      message.errorMessage,
      message.toolCallId,
    ]);
  const signatures = new Set(entries.map((entry) => signature(entry.message)));
  const persistedToolIds = new Set(
    entries.flatMap((entry) =>
      entry.message.role === "toolResult" && entry.message.toolCallId
        ? [entry.message.toolCallId]
        : [],
    ),
  );
  for (const live of liveMessages) {
    if (
      live.message.role === "toolResult" && live.message.toolCallId
        ? persistedToolIds.has(live.message.toolCallId)
        : signatures.has(signature(live.message))
    )
      continue;
    entries.push({
      key: live.key,
      timestamp: new Date().toISOString(),
      message: live.message,
    });
  }
  let setupEpisode = false;
  return entries.filter(({ message }) => {
    if (message.customType === "openpi-setup-request") {
      setupEpisode = true;
      return false;
    }
    if (!setupEpisode) return true;
    if (message.role === "user") {
      setupEpisode = false;
      return true;
    }
    return false;
  });
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
  return blocks.map((block, index) => {
    const blockKey = `${block.process ? "process" : "rows"}-${block.rows[0]?.key}`;
    if (!block.process) {
      return (
        <Fragment key={blockKey}>
          {block.rows.map((row) => (
            <Fragment key={row.key}>{row.content}</Fragment>
          ))}
        </Fragment>
      );
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
}: {
  id: number;
  rows: RenderRow[];
  active: boolean;
  expandProcesses: boolean;
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
    </section>
  );
}

function renderTurns(
  rows: RenderRow[],
  running: boolean,
  expandProcesses: boolean,
) {
  const turns: Array<{ id: number; rows: RenderRow[] }> = [];
  for (const row of rows) {
    const current = turns.at(-1);
    if (current?.id === row.turn) current.rows.push(row);
    else turns.push({ id: row.turn, rows: [row] });
  }
  const lastTurn = turns.at(-1)?.id;
  return turns.map((turn) => (
    <ConversationTurn
      id={turn.id}
      rows={turn.rows}
      active={running && turn.id === lastTurn}
      expandProcesses={expandProcesses}
      key={`turn-group-${turn.id}-${turn.rows[0]?.key}`}
    />
  ));
}

export function Transcript(props: TranscriptProps) {
  const { t } = useTranslation();
  const viewport = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [readingHistory, setReadingHistory] = useState(false);
  const lastPath = useRef<string | undefined>(undefined);
  const lastScrollRequest = useRef(props.scrollToBottom);
  const entries = useMemo(
    () => buildEntries(props.snapshot, props.liveMessages),
    [props.snapshot, props.liveMessages],
  );
  const selected = props.snapshot.selectedSession;
  const active = selected?.id === props.snapshot.currentSessionId;

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
    const liveTools = props.snapshot.runtime.liveTools ?? [];
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
    }
    const lastAssistantByTurn = new Set<number>();
    let assistantCandidate = -1;
    entries.forEach(({ message }, index) => {
      if (message.role === "user") {
        if (assistantCandidate >= 0)
          lastAssistantByTurn.add(assistantCandidate);
        assistantCandidate = -1;
      } else if (message.role === "assistant" && message.content.trim())
        assistantCandidate = index;
    });
    if (assistantCandidate >= 0) lastAssistantByTurn.add(assistantCandidate);

    const rendered = entries.flatMap((entry, index): RenderRow[] => {
      const message = entry.message;
      if (message.role === "custom") {
        return [
          {
            key: entry.key,
            turn,
            kind: "custom",
            content: (
              <article className="message-row assistant detail-only">
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
        return [
          {
            key: entry.key,
            turn,
            kind: "prompt",
            content: (
              <article className="message-row user" id={`turn-${turn}`}>
                <div className="message-content">
                  <UserImageAttachments message={message} />
                  {message.content && (
                    <div className="message-body">{message.content}</div>
                  )}
                </div>
                <MessageActions
                  content={message.content}
                  editable={active && index === lastUserIndex && !hasImages}
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
        message.parts?.forEach((part, partIndex) => {
          if (part.type === "thinking") {
            const isLive =
              active && props.liveRunning && index === entries.length - 1;
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
                      start={props.thinkingStarts[entry.key]}
                      duration={props.thinkingDurations[entry.key]}
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
            const card = isEvidenceTool(part.name) ? (
              <ToolEvidence
                key={`${entry.key}-${part.id || partIndex}-evidence`}
                call={part}
                result={result}
                liveState={persistedResult ? undefined : live?.state}
                cwd={selected?.cwd}
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
              kind: "process",
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
        if (message.content.trim())
          detailRows.push({
            key: `${entry.key}-answer`,
            turn,
            kind: "response",
            content: (
              <article
                className={`message-row assistant response${lastAssistantByTurn.has(index) ? " final-response" : ""}`}
              >
                <div className="message-content">
                  <Markdown>{message.content}</Markdown>
                </div>
                {lastAssistantByTurn.has(index) && (
                  <MessageActions
                    content={message.content}
                    editable={false}
                    timestamp={entry.timestamp}
                    onResend={props.onResend}
                  />
                )}
              </article>
            ),
          });
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
                  canRetry={
                    active &&
                    !props.liveRunning &&
                    props.snapshot.runtime.status !== "running"
                  }
                  onRetry={props.onResend}
                />
              </article>
            ),
          });
        }
        return detailRows;
      }
      if (message.role === "toolResult") {
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
            kind: "process",
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
    entries,
    props.liveRunning,
    props.onResend,
    props.onInspectSubagent,
    props.snapshot.runtime.capabilities.subagents,
    props.snapshot.preferences.expandThinking,
    props.snapshot.runtime.status,
    props.snapshot.thinking?.level,
    props.thinkingDurations,
    props.thinkingStarts,
    props.snapshot.runtime.liveTools,
    selected?.cwd,
    t,
  ]);

  useLayoutEffect(() => {
    // Streamed content can grow without changing message keys.
    void entries;
    const element = viewport.current;
    if (!element || !selected) return;
    const changed = lastPath.current !== selected.path;
    const requested = lastScrollRequest.current !== props.scrollToBottom;
    lastScrollRequest.current = props.scrollToBottom;
    if (changed || requested || pinned.current) {
      pinned.current = true;
      setReadingHistory(false);
      if (typeof element.scrollTo === "function") {
        element.scrollTo({ top: element.scrollHeight, behavior: "instant" });
      } else {
        element.scrollTop = element.scrollHeight;
      }
    }
    lastPath.current = selected.path;
  }, [selected, entries, props.scrollToBottom]);

  const running =
    active &&
    (props.snapshot.runtime.status === "running" || props.liveRunning);
  const runningLabel = props.liveRetry
    ? `${t("modelRetrying")} (${props.liveRetry.attempt}/${props.liveRetry.maxAttempts})`
    : props.livePhase === "preparing"
      ? t("modelPreparing")
      : t("modelRunning");

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
          setReadingHistory(!pinned.current);
        }}
      >
        {renderTurns(
          rows,
          running,
          props.snapshot.preferences.expandThinking === true,
        )}
        {running && (
          <div
            className="conversation-running"
            role="status"
            aria-live="polite"
          >
            <span className="conversation-running-dot" />
            <span>{runningLabel}</span>
          </div>
        )}
      </div>
      {readingHistory && rows.length > 0 && (
        <button
          className="jump-to-latest"
          type="button"
          onClick={() => {
            const element = viewport.current;
            if (!element) return;
            pinned.current = true;
            setReadingHistory(false);
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
