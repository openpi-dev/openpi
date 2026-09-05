import {
  Bot,
  Check,
  Clipboard,
  FilePenLine,
  FileText,
  Folder,
  Globe,
  Lightbulb,
  Pencil,
  Search,
  Terminal,
  Wrench,
  Workflow,
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
import type {
  WebLiveMessage,
  WebMessagePart,
  WebSnapshot,
} from "../../../../protocol/types.ts";
import { Markdown } from "../../components/Markdown.tsx";
import {
  compactSummary,
  formatElapsedMs,
  formatTurnTime,
  turnTitle,
} from "../../lib/format.ts";
import type { LiveEntry } from "../../store/web-store.ts";

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
}

type Status = "running" | "done" | "error" | "warn" | "unknown";
interface RenderRow {
  key: string;
  content: ReactNode;
  groupable?: boolean;
  error?: boolean;
  icon?: ReactNode;
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

function EvidenceDetails({
  body,
  icon,
  name,
  status,
  summary,
  thinking = false,
}: {
  body: string;
  icon: ReactNode;
  name: string;
  status: Status;
  summary?: string;
  thinking?: boolean;
}) {
  return (
    <details
      className={`message-details tool-line ${status === "error" ? "error" : ""} ${thinking ? "thinking-line" : ""}`}
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
      <pre className="details-body tool-evidence">{body}</pre>
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
) {
  const name = part.name || "";
  const args = parseArguments(part.arguments);
  const details = record(result?.details);
  const status = resultStatus(result);
  if (name === "subagent_spawn") {
    const meta = [args.agent_type, args.model, args.working_dir]
      .filter(Boolean)
      .join(" · ");
    return (
      <ActivityCard
        family="subagent"
        title={`Spawn Subagent · ${String(details.title || args.name || "subagent")}`}
        meta={meta || String(details.cwd || "")}
        body={result?.content || String(args.prompt || part.arguments)}
        status={status}
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
}: {
  body: string;
  start?: number;
  duration?: number;
  active: boolean;
}) {
  const { t } = useTranslation();
  const elapsed = useElapsed(start, active);
  const settled = duration ? formatElapsedMs(0, duration) : elapsed;
  return (
    <EvidenceDetails
      body={body}
      icon={<Lightbulb />}
      name={active ? t("thinkingActive") : t("thinkingDone")}
      status={active ? "running" : "done"}
      summary={settled ? `· ${settled}` : undefined}
      thinking
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
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(content);
  const editInput = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (editing) editInput.current?.focus();
  }, [editing]);
  if (editing) {
    return (
      <div className="message-editor">
        <textarea
          ref={editInput}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") setEditing(false);
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              void onResend(draft.trim()).then(
                (sent) => sent && setEditing(false),
              );
            }
          }}
        />
        <div className="message-edit-actions">
          <button type="button" onClick={() => setEditing(false)}>
            {t("cancel")}
          </button>
          <button
            type="button"
            className="confirm"
            onClick={() =>
              void onResend(draft.trim()).then(
                (sent) => sent && setEditing(false),
              )
            }
          >
            {t("confirmEdit")}
          </button>
        </div>
      </div>
    );
  }
  const time = formatTurnTime(timestamp);
  return (
    <div className="message-actions">
      {time && <time dateTime={timestamp}>{time}</time>}
      {editable && (
        <button
          type="button"
          aria-label={t("editMessage")}
          title={t("editMessage")}
          onClick={() => setEditing(true)}
        >
          <Pencil />
        </button>
      )}
      <button
        type="button"
        aria-label={copied ? t("copiedMessage") : t("copyMessage")}
        title={copied ? t("copiedMessage") : t("copyMessage")}
        onClick={() => {
          void navigator.clipboard.writeText(content).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1_200);
          });
        }}
      >
        {copied ? <Check /> : <Clipboard />}
      </button>
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
  const signatures = new Set(
    entries.map(
      (entry) => `${entry.message.role || ""}:${entry.message.content}`,
    ),
  );
  for (const live of liveMessages) {
    if (signatures.has(`${live.message.role || ""}:${live.message.content}`))
      continue;
    entries.push({
      key: live.key,
      timestamp: new Date().toISOString(),
      message: live.message,
    });
  }
  return entries;
}

function groupRows(rows: RenderRow[], stepsLabel: string) {
  const blocks: Array<{ grouped: boolean; rows: RenderRow[] }> = [];
  for (const row of rows) {
    const last = blocks.at(-1);
    if (row.groupable && last?.grouped) last.rows.push(row);
    else blocks.push({ grouped: Boolean(row.groupable), rows: [row] });
  }
  return blocks.map((block) => {
    const blockKey = `${block.grouped ? "group" : "rows"}-${block.rows[0]?.key}`;
    if (!block.grouped || block.rows.length < 4) {
      return (
        <Fragment key={blockKey}>
          {block.rows.map((row) => (
            <Fragment key={row.key}>{row.content}</Fragment>
          ))}
        </Fragment>
      );
    }
    return (
      <details
        className={`tool-group ${block.rows.some((row) => row.error) ? "error" : ""}`}
        key={blockKey}
      >
        <summary>
          <span className="details-mark" aria-hidden="true" />
          <span className="tool-group-icons" aria-hidden="true">
            {block.rows.slice(0, 4).map((row) => (
              <Fragment key={row.key}>{row.icon}</Fragment>
            ))}
          </span>
          <span>
            {block.rows.length} {stepsLabel}
          </span>
        </summary>
        <div className="tool-group-body">
          {block.rows.map((row) => (
            <Fragment key={row.key}>{row.content}</Fragment>
          ))}
        </div>
      </details>
    );
  });
}

export function Transcript(props: TranscriptProps) {
  const { t } = useTranslation();
  const viewport = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const lastPath = useRef<string | undefined>(undefined);
  const entries = useMemo(
    () => buildEntries(props.snapshot, props.liveMessages),
    [props.snapshot, props.liveMessages],
  );
  const selected = props.snapshot.selectedSession;
  const active = selected?.id === props.snapshot.currentSessionId;

  const { rows, turns } = useMemo(() => {
    const results = new Map<string, WebLiveMessage>();
    const familyIds = new Set<string>();
    entries.forEach(({ message }) => {
      if (message.role === "toolResult" && message.toolCallId)
        results.set(message.toolCallId, message);
      message.parts?.forEach((part) => {
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
        turn++;
        turnItems.push({ id: turn, title: turnTitle(message.content) });
        return [
          {
            key: entry.key,
            content: (
              <article className="message-row user" id={`turn-${turn}`}>
                <div className="message-content">
                  <div className="message-body">{message.content}</div>
                </div>
                <MessageActions
                  content={message.content}
                  editable={active && index === lastUserIndex}
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
              icon: <Lightbulb />,
              content: (
                <article className="message-row assistant detail-only">
                  <div className="message-content">
                    <ThinkingEvidence
                      body={part.text}
                      active={isLive}
                      start={props.thinkingStarts[entry.key]}
                      duration={props.thinkingDurations[entry.key]}
                    />
                  </div>
                </article>
              ),
            });
          }
          if (part.type === "toolCall") {
            const result = part.id ? results.get(part.id) : undefined;
            const card = familyCard(part, result);
            const args = parseArguments(part.arguments);
            const toolIcon = iconForTool(part.name);
            detailRows.push({
              key: `${entry.key}-tool-${part.id || partIndex}`,
              groupable: !card,
              error: Boolean(result?.isError),
              icon: toolIcon,
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
                        status={resultStatus(result)}
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
            content: (
              <article className="message-row assistant">
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
        return detailRows;
      }
      if (message.role === "toolResult") {
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
            groupable: !family,
            error: status === "error",
            icon,
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
    props.thinkingDurations,
    props.thinkingStarts,
    t,
  ]);

  const transcriptVersion = `${selected?.path}:${entries.map((entry) => entry.key).join(",")}:${props.scrollToBottom}`;
  useLayoutEffect(() => {
    void transcriptVersion;
    const element = viewport.current;
    if (!element || !selected) return;
    const changed = lastPath.current !== selected.path;
    if (changed || pinned.current) {
      if (typeof element.scrollTo === "function") {
        element.scrollTo({ top: element.scrollHeight, behavior: "instant" });
      } else {
        element.scrollTop = element.scrollHeight;
      }
    }
    lastPath.current = selected.path;
  }, [selected, transcriptVersion]);

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
        }}
      >
        {groupRows(rows, t("stepsLabel"))}
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
