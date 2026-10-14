import type { TFunction } from "i18next";
import {
  ArrowUpRight,
  Check,
  ChevronRight,
  CircleHelp,
  Clock3,
  Info,
  Lightbulb,
  ListTree,
  MessageSquare,
  Search,
  Settings2,
  X,
} from "lucide-react";
import {
  memo,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { projectToolEvidence } from "../../../../protocol/evidence.ts";
import type { WebSnapshot } from "../../../../protocol/types.ts";
import { compactSummary, formatTurnTime } from "../../lib/format.ts";
import {
  toolActivity,
  toolActivityTarget,
} from "../transcript/tool-activity.ts";
import { useSessionHistory } from "../transcript/use-session-history.ts";
import { TrajectoryPayload } from "./TrajectoryPayload.tsx";
import { TrajectoryTimeline } from "./TrajectoryTimeline.tsx";
import { trajectoryRangeKeys } from "./timeline.ts";
import {
  defaultTrajectoryNode,
  groupTrajectory,
  type TrajectoryNode,
  trajectoryDuration,
  trajectoryRecords,
} from "./trajectory.ts";
import "./trajectory.css";

const EMPTY: NonNullable<WebSnapshot["selectedSession"]>["entries"] = [];

function reasoning(node: TrajectoryNode) {
  if (node.kind === "call" || node.kind === "result") return "";
  return (node.message?.parts ?? [])
    .filter((part) => part.type === "thinking")
    .map((part) => part.text)
    .join("\n\n");
}

function title(node: TrajectoryNode, t: TFunction) {
  if (node.kind === "event")
    return t(`trajectoryEvent_${node.title}`, { defaultValue: node.title });
  if (node.kind === "call" || node.kind === "result") return node.title;
  if (node.kind === "assistant" && !node.message?.content && reasoning(node))
    return t("trajectoryReasoningTitle");
  return t(`trajectory_${node.kind}`);
}

function recordPreview(node: TrajectoryNode) {
  if (node.input) {
    try {
      const args: unknown = JSON.parse(node.input);
      if (args && typeof args === "object" && !Array.isArray(args)) {
        const target = toolActivityTarget(
          node.title,
          args as Record<string, unknown>,
        );
        if (target) return target;
      }
    } catch {
      // Bounded or non-JSON arguments keep their original preview.
    }
  }
  return (
    node.input ||
    node.message?.content ||
    reasoning(node) ||
    node.result?.content ||
    ""
  );
}

function RecordIcon({ node }: { node: TrajectoryNode }) {
  const Icon =
    node.kind === "call" || node.kind === "result"
      ? toolActivity(node.title).Icon
      : node.kind === "user"
        ? ArrowUpRight
        : node.kind === "event"
          ? Settings2
          : !node.message?.content && reasoning(node)
            ? Lightbulb
            : MessageSquare;
  return <Icon aria-hidden="true" />;
}

function Outcome({ node }: { node: TrajectoryNode }) {
  const { t } = useTranslation();
  if (!node.outcome) return null;
  const state =
    node.state ??
    (node.result
      ? projectToolEvidence(
          {
            type: "toolCall",
            name: node.title,
            id: node.callId,
            arguments: node.input ?? "",
          },
          node.result,
        ).state
      : undefined);
  const distinctState =
    state === "cancelled" || state === "timed_out" || state === "running";
  const label = distinctState
    ? t(`toolState_${state}`)
    : t(`trajectory_${node.outcome}`);
  const Icon =
    state === "running" || state === "timed_out"
      ? Clock3
      : node.outcome === "returned"
        ? Check
        : node.outcome === "error"
          ? X
          : CircleHelp;
  return (
    <span className={`trajectory-outcome ${node.outcome}`} title={label}>
      <Icon aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}

function Evidence({ label, value }: { label: string; value: string }) {
  return (
    <section className="trajectory-evidence">
      <h3>{label}</h3>
      <TrajectoryPayload text={value} />
    </section>
  );
}

function Inspector({ node, number }: { node: TrajectoryNode; number: number }) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const [tab, setTab] = useState("summary");
  const output = node.result;
  const message = node.message;
  const thought = reasoning(node);
  const isTool = node.kind === "call" || node.kind === "result";
  const tabs = [
    { key: "summary", label: t("trajectorySummary") },
    ...(node.input !== undefined
      ? [{ key: "input", label: t("trajectoryInputTab") }]
      : []),
    ...(isTool ? [{ key: "output", label: t("trajectoryResultTab") }] : []),
    { key: "timing", label: t("trajectoryTimingTab") },
    ...(!isTool && message?.role === "assistant"
      ? [{ key: "usage", label: t("trajectoryUsageTab") }]
      : []),
  ];
  const date = node.timestamp ? new Date(node.timestamp) : null;
  const recordedAt =
    date && Number.isFinite(date.getTime())
      ? date.toLocaleString(i18n.language, { hour12: false })
      : node.timestamp;
  const result = (
    <>
      {output ? (
        <Evidence
          label={t("trajectoryOutput")}
          value={output.content || t("noOutput")}
        />
      ) : (
        <p className="trajectory-missing">
          {t(
            node.missingOutput
              ? "trajectoryNestedOutputMissing"
              : "trajectoryMissingResult",
          )}
        </p>
      )}
      {tab === "output" && output?.details !== undefined && (
        <details className="trajectory-disclosure">
          <summary>{t("trajectoryStructured")}</summary>
          <pre>{JSON.stringify(output.details, null, 2)}</pre>
        </details>
      )}
    </>
  );
  const content = message && (
    <>
      {message.content && (
        <Evidence
          label={t("trajectoryRecordedContent")}
          value={message.content}
        />
      )}
      {thought && (
        <details className="trajectory-disclosure trajectory-reasoning">
          <summary>
            <Lightbulb aria-hidden="true" />
            {t("trajectoryThinking")}
          </summary>
          <pre>{thought}</pre>
        </details>
      )}
      {!message.content && !thought && <p>{t("noOutput")}</p>}
    </>
  );
  return (
    <section
      className="trajectory-inspector"
      aria-label={t("trajectoryDetails")}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: Scrollable evidence must remain reachable with a keyboard.
      tabIndex={0}
    >
      <header className="trajectory-inspector-heading">
        <span className="trajectory-inspector-icon">
          <RecordIcon node={node} />
        </span>
        <div>
          <p>
            {isTool && <>{t(`trajectory_${node.kind}`)} · </>}
            {t("trajectoryRecordNumber", { number })}
          </p>
          <h2 id={`${id}-title`}>{title(node, t)}</h2>
        </div>
      </header>
      {node.outcome && <Outcome node={node} />}
      {node.error && <p className="trajectory-failure">{node.error}</p>}
      {message?.errorMessage && (
        <p className="trajectory-failure">{message.errorMessage}</p>
      )}
      {tabs.length > 1 && (
        <div
          className="trajectory-tabs"
          role="tablist"
          aria-label={t("trajectoryDetails")}
          onKeyDown={(event) => {
            const index = tabs.findIndex((item) => item.key === tab);
            const next =
              event.key === "ArrowRight"
                ? (index + 1) % tabs.length
                : event.key === "ArrowLeft"
                  ? (index + tabs.length - 1) % tabs.length
                  : event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? tabs.length - 1
                      : undefined;
            if (next === undefined) return;
            event.preventDefault();
            setTab(tabs[next]!.key);
            event.currentTarget.querySelectorAll("button")[next]?.focus();
          }}
        >
          {tabs.map((item) => (
            <button
              type="button"
              role="tab"
              key={item.key}
              id={`${id}-${item.key}`}
              aria-controls={`${id}-panel`}
              aria-selected={tab === item.key}
              tabIndex={tab === item.key ? 0 : -1}
              onClick={() => setTab(item.key)}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
      <section
        className="trajectory-detail-content"
        role={tabs.length > 1 ? "tabpanel" : undefined}
        id={`${id}-panel`}
        aria-labelledby={tabs.length > 1 ? `${id}-${tab}` : `${id}-title`}
      >
        {(message?.truncation || output?.truncation) && (
          <p className="trajectory-warning">
            {t("trajectoryEvidenceTruncated")}
          </p>
        )}
        {(tab === "summary" || tab === "input") && node.input !== undefined && (
          <TrajectoryInput node={node} />
        )}
        {(tab === "summary" || tab === "output") && isTool && result}
        {!isTool && tab === "summary" && content}
        {tab === "timing" && (
          <dl className="trajectory-facts">
            <dt>{t("trajectoryDurationLabel")}</dt>
            <dd>{trajectoryDuration(node.durationMs)}</dd>
            <dt>{t("trajectoryTimingSource")}</dt>
            <dd>
              {t(
                node.durationMs === undefined
                  ? "trajectoryTimingUnknown"
                  : "trajectoryTimingNative",
              )}
            </dd>
            <dt>{t("trajectoryTTFT")}</dt>
            <dd>{t("trajectoryNotRecorded")}</dd>
            <dt>{t("trajectoryGenerationTime")}</dt>
            <dd>{t("trajectoryNotRecorded")}</dd>
            <dt>{t("trajectoryThroughput")}</dt>
            <dd>{t("trajectoryNotRecorded")}</dd>
          </dl>
        )}
        {tab === "usage" && (
          <>
            <Usage message={message} />
            <dl className="trajectory-facts">
              <dt>{t("trajectoryProvider")}</dt>
              <dd>{message?.provider ?? "—"}</dd>
              <dt>{t("trajectoryModel")}</dt>
              <dd>{message?.model ?? "—"}</dd>
            </dl>
          </>
        )}
        {node.kind === "event" && !message && tab === "summary" && (
          <p className="trajectory-missing">{t("trajectoryEventOnly")}</p>
        )}
        <details className="trajectory-disclosure trajectory-metadata">
          <summary>
            <Info aria-hidden="true" />
            {t("trajectoryRecordInfo")}
          </summary>
          <dl>
            {recordedAt && (
              <>
                <dt>{t("trajectoryRecordedAt")}</dt>
                <dd>
                  <time dateTime={node.timestamp}>{recordedAt}</time>
                </dd>
              </>
            )}
            {node.callId && (
              <>
                <dt>{t("trajectoryCallId")}</dt>
                <dd>{node.callId}</dd>
              </>
            )}
            <dt>{t("trajectoryRecordId")}</dt>
            <dd>{node.key}</dd>
            {node.kind === "event" && (
              <>
                <dt>{t("trajectoryEventType")}</dt>
                <dd>{node.title}</dd>
              </>
            )}
          </dl>
        </details>
      </section>
    </section>
  );
}

function Usage({ message }: { message?: TrajectoryNode["message"] }) {
  const { t } = useTranslation();
  const usage = message?.usage;
  if (!usage)
    return <p className="trajectory-missing">{t("trajectoryUsageUnknown")}</p>;
  return (
    <dl className="trajectory-facts">
      {(["input", "cacheRead", "cacheWrite", "output"] as const).map((key) => (
        <div key={key}>
          <dt>{t(`trajectoryUsage_${key}`)}</dt>
          <dd>{usage[key]?.toLocaleString() ?? "—"}</dd>
        </div>
      ))}
    </dl>
  );
}

function TrajectoryInput({ node }: { node: TrajectoryNode }) {
  const { t } = useTranslation();
  const [raw, setRaw] = useState(false);
  let code: string | undefined;
  if (node.title === "codemode") {
    try {
      const args: unknown = JSON.parse(node.input ?? "");
      if (
        args &&
        typeof args === "object" &&
        "code" in args &&
        typeof args.code === "string"
      )
        code = args.code;
    } catch {
      /* Truncated arguments remain raw evidence. */
    }
  }
  return (
    <section className="trajectory-evidence">
      <h3>
        {t(code ? "trajectoryCode" : "trajectoryArguments")}
        {code && (
          <button type="button" aria-pressed={raw} onClick={() => setRaw(!raw)}>
            {t("trajectoryRawArguments")}
          </button>
        )}
      </h3>
      <TrajectoryPayload
        text={code && !raw ? code : (node.input ?? "")}
        code={Boolean(code && !raw)}
      />
    </section>
  );
}

export const Trajectory = memo(function Trajectory({
  snapshot,
  running,
}: {
  snapshot: WebSnapshot;
  running: boolean;
}) {
  const { t } = useTranslation();
  const ledger = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const requestedScroll = useRef(false);
  const beforePrepend = useRef<{ height: number; top: number } | null>(null);
  const history = useSessionHistory(snapshot.selectedSession, {
    beforePrepend: () => {
      if (ledger.current)
        beforePrepend.current = {
          height: ledger.current.scrollHeight,
          top: ledger.current.scrollTop,
        };
    },
  });
  const entries = history.session?.entries ?? EMPTY;
  const liveTools =
    snapshot.currentSessionPath === snapshot.selectedSession?.path
      ? snapshot.runtime.liveTools
      : undefined;
  const nodes = useMemo(
    () => trajectoryRecords(entries, liveTools),
    [entries, liveTools],
  );
  const [selectedKey, select] = useState<string | null>(null);
  const [query, search] = useState("");
  const [limit, setLimit] = useState(50);
  const [collapsed, collapse] = useState<ReadonlySet<string>>(new Set());
  const [callsCollapsed, foldCalls] = useState(false);
  const [showDuration, setShowDuration] = useState(true);
  const [rangeSelection, setRange] = useState<{
    start: number;
    end: number;
    keys: string[];
  } | null>(null);
  const filtered = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    return term
      ? nodes.filter((node) =>
          [
            title(node, t),
            node.title,
            node.callId,
            node.input,
            recordPreview(node),
            node.result?.content,
            reasoning(node),
          ].some((text) => text?.toLocaleLowerCase().includes(term)),
        )
      : nodes;
  }, [nodes, query, t]);
  const selectedIndex = filtered.findIndex((node) => node.key === selectedKey);
  const start = Math.min(
    Math.max(0, filtered.length - limit),
    selectedIndex < 0 ? filtered.length : selectedIndex,
  );
  const visible = filtered.slice(start, start + limit);
  // Sequence coordinates apply only to the exact window the user selected.
  const range =
    rangeSelection?.keys.length === visible.length &&
    rangeSelection.keys.every((key, index) => key === visible[index]?.key)
      ? rangeSelection
      : null;
  const rangeKeys = useMemo(
    () => trajectoryRangeKeys(visible, range),
    [visible, range],
  );
  const selected =
    visible.find((node) => node.key === selectedKey) ??
    defaultTrajectoryNode(visible);
  useLayoutEffect(() => {
    const previous = beforePrepend.current;
    if (previous && ledger.current) {
      ledger.current.scrollTop =
        previous.top + ledger.current.scrollHeight - previous.height;
      beforePrepend.current = null;
    }
  });
  useEffect(() => {
    if (!selected?.key) return;
    if (!following.current && !requestedScroll.current) return;
    requestedScroll.current = false;
    ledger.current
      ?.querySelector<HTMLButtonElement>(
        '.trajectory-record[aria-pressed="true"]',
      )
      ?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [selected?.key]);
  const grouped = useMemo(() => groupTrajectory(nodes), [nodes]);
  const shown = new Set(visible.map((node) => node.key));
  const groups = grouped.flatMap((group) => {
    const runs = group.runs
      .map((run) => run.filter((node) => shown.has(node.key)))
      .filter((run) => run.length > 0);
    return runs.length ? [{ ...group, runs }] : [];
  });
  const numbers = new Map(nodes.map((node, index) => [node.key, index + 1]));
  const truncation = history.session?.truncation;
  const requests = nodes.filter((node) => node.kind === "assistant");
  const tools = nodes.filter((node) => node.kind === "call");
  const latestTiming = entries
    .flatMap((entry) => (entry.turnTiming ? [entry.turnTiming] : []))
    .at(-1);
  function record(node: TrajectoryNode) {
    const preview = recordPreview(node);
    return (
      <li
        key={node.key}
        data-nested={Boolean(node.parentKey) || undefined}
        data-outside-range={
          (rangeKeys && !rangeKeys.has(node.key)) || undefined
        }
        hidden={callsCollapsed && node.kind === "call"}
      >
        <button
          type="button"
          aria-pressed={node.key === selected?.key}
          onClick={() => {
            requestedScroll.current = true;
            select(node.key);
          }}
          className={`trajectory-record ${node.kind}`}
          data-response-error={
            (node.kind === "assistant" &&
              (node.message?.stopReason === "error" ||
                node.message?.stopReason === "aborted")) ||
            undefined
          }
          title={compactSummary(preview, 220)}
        >
          <span className="trajectory-row-number">{numbers.get(node.key)}</span>
          <span className="trajectory-record-icon">
            <RecordIcon node={node} />
          </span>
          <span className="trajectory-record-main">
            <span className="trajectory-record-title">
              <strong>{title(node, t)}</strong>
              <span className="trajectory-kind">
                {t(`trajectory_${node.kind}`)}
              </span>
            </span>
            {preview && (
              <span className="trajectory-preview">
                {compactSummary(preview, 180)}
              </span>
            )}
          </span>
          <span className="trajectory-record-end">
            <Outcome node={node} />
            {showDuration && (
              <span className="trajectory-row-duration">
                {trajectoryDuration(node.durationMs)}
              </span>
            )}
            <time dateTime={node.timestamp} title={t("trajectoryRecordedAt")}>
              {formatTurnTime(node.timestamp)}
            </time>
          </span>
        </button>
      </li>
    );
  }
  return (
    <section className="conversation trajectory" aria-label={t("trajectory")}>
      <header className="trajectory-toolbar">
        <div className="trajectory-context">
          <ListTree aria-hidden="true" />
          <button
            type="button"
            aria-pressed={showDuration}
            onClick={() => setShowDuration(!showDuration)}
          >
            <Clock3 aria-hidden="true" />
            {t("trajectoryDurationLabel")}
          </button>
          <button
            type="button"
            aria-pressed={collapsed.size > 0}
            onClick={() =>
              collapse(
                collapsed.size
                  ? new Set()
                  : new Set(grouped.map((group) => group.key)),
              )
            }
          >
            {t("trajectoryFoldTurns")}
          </button>
          <button
            type="button"
            aria-pressed={callsCollapsed}
            onClick={() => foldCalls(!callsCollapsed)}
          >
            {t("trajectoryFoldCalls")}
          </button>
          <span className="trajectory-count">
            {t(query.trim() ? "trajectoryMatches" : "trajectoryRecordCount", {
              count: filtered.length,
            })}
          </span>
          <details className="trajectory-scope">
            <summary
              aria-label={t("trajectoryScope")}
              title={t("trajectoryScope")}
            >
              <Info aria-hidden="true" />
            </summary>
            <p>{t("trajectoryScope")}</p>
          </details>
        </div>
        <label className="trajectory-search">
          <Search aria-hidden="true" />
          <input
            type="search"
            aria-label={t("trajectorySearch")}
            placeholder={t("trajectorySearch")}
            value={query}
            onChange={(event) => search(event.currentTarget.value)}
          />
        </label>
      </header>
      <section
        className="trajectory-metrics"
        aria-label={t("trajectoryMetrics")}
      >
        <span>{t("trajectoryRequestCount", { count: requests.length })}</span>
        <span>{t("trajectoryToolCount", { count: tools.length })}</span>
        {latestTiming && (
          <span>
            {t("trajectoryLastTurn")}{" "}
            <strong>{trajectoryDuration(latestTiming.elapsedMs)}</strong>
          </span>
        )}
      </section>
      {nodes.length > 0 && (
        <TrajectoryTimeline
          nodes={visible}
          selectedKey={selected?.key}
          range={range}
          onRange={(range) =>
            setRange(
              range
                ? { ...range, keys: visible.map((node) => node.key) }
                : null,
            )
          }
          onSelect={(key) => {
            requestedScroll.current = true;
            select(key);
            collapse(new Set());
            foldCalls(false);
          }}
        />
      )}
      {running && (
        <p className="trajectory-live" role="status">
          {t("trajectoryRunning")}
        </p>
      )}
      {truncation?.truncated && (
        <p className="trajectory-warning">
          {t("trajectoryTruncated", {
            entries: truncation.entriesOmitted,
            parts: truncation.messagePartsOmitted,
            messages: truncation.messagesTruncated,
          })}
        </p>
      )}
      {!visible.length ? (
        <div className="trajectory-empty">
          <ListTree aria-hidden="true" />
          <p>{t(query.trim() ? "trajectoryNoMatches" : "trajectoryEmpty")}</p>
        </div>
      ) : (
        <div className="trajectory-body">
          <div
            className="trajectory-ledger"
            data-range={Boolean(range) || undefined}
            ref={ledger}
            onScroll={(event) => {
              const element = event.currentTarget;
              following.current =
                element.scrollHeight -
                  element.scrollTop -
                  element.clientHeight <
                40;
            }}
          >
            {start + limit < filtered.length && (
              <button
                type="button"
                className="trajectory-load"
                onClick={() => {
                  requestedScroll.current = true;
                  select(null);
                  setLimit(50);
                }}
              >
                {t("trajectoryLatestRecords")}
              </button>
            )}
            <div className="trajectory-column-headings">
              <span>#</span>
              <span>{t("trajectoryEventColumn")}</span>
              <span>{t("trajectoryContentColumn")}</span>
              <span>{t("trajectoryDurationLabel")}</span>
            </div>
            {history.hasMore && (
              <button
                type="button"
                className="trajectory-load"
                disabled={history.loading || history.verifying}
                onClick={() => {
                  void history.loadOlder();
                  setLimit((value) => value + 50);
                }}
              >
                {t(
                  history.loading
                    ? "trajectoryHistoryLoading"
                    : "trajectoryLoadHistory",
                )}
              </button>
            )}
            {history.error && (
              <p className="trajectory-warning" role="alert">
                {t(history.error)}
              </p>
            )}
            {start > 0 && (
              <button
                type="button"
                className="trajectory-load"
                onClick={() => setLimit((value) => value + 50)}
              >
                {t("trajectoryEarlier", { count: start })}
              </button>
            )}
            {groups.map((group, groupIndex) => {
              const open = !collapsed.has(group.key);
              return (
                <section className="trajectory-group" key={group.key}>
                  <button
                    type="button"
                    className="trajectory-group-heading"
                    aria-expanded={open}
                    onClick={() =>
                      collapse((current) => {
                        const next = new Set(current);
                        if (open) next.add(group.key);
                        else next.delete(group.key);
                        return next;
                      })
                    }
                  >
                    <ChevronRight aria-hidden="true" />
                    <span>
                      <span className="trajectory-turn-number">
                        {t("trajectoryTurn", { number: groupIndex + 1 })} ·{" "}
                      </span>
                      {group.prompt
                        ? open && !query.trim()
                          ? t("trajectoryConversationGroup")
                          : compactSummary(
                              group.prompt.message?.content ||
                                t("trajectory_user"),
                              80,
                            )
                        : t("trajectoryEarlierGroup")}
                    </span>
                  </button>
                  {open && (
                    <ol>
                      {group.runs.map((run) =>
                        run.length === 1 ? (
                          record(run[0]!)
                        ) : (
                          <li
                            key={run[0]!.key}
                            className="trajectory-event-group"
                          >
                            <details
                              open={
                                run.some(
                                  (node) => node.key === selected?.key,
                                ) || !!query.trim()
                              }
                            >
                              <summary>
                                <Settings2 aria-hidden="true" />
                                <span>
                                  {t("trajectoryEventCount", {
                                    count: run.length,
                                  })}
                                </span>
                                <ChevronRight aria-hidden="true" />
                              </summary>
                              <ol>{run.map(record)}</ol>
                            </details>
                          </li>
                        ),
                      )}
                    </ol>
                  )}
                </section>
              );
            })}
          </div>
          {selected && (
            <Inspector
              key={selected.key}
              node={selected}
              number={numbers.get(selected.key)!}
            />
          )}
        </div>
      )}
    </section>
  );
});
