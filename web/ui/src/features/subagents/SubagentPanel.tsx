import { ArrowLeft, Bot, ChevronRight, RefreshCw, X } from "lucide-react";
import { List, ListItem } from "@astryxdesign/core/List";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  WebCapabilityProjection,
  WebSubagentActivity,
  WebSubagentDetail,
} from "../../../../../extensions/shared/web-observer-registry.ts";
import { Markdown } from "../../components/Markdown.tsx";
import { formatElapsedMs } from "../../lib/format.ts";
import { WebApiError, WebClient } from "../../protocol/client.ts";
import type { RecordedSubagent } from "./recorded-subagents.ts";

// Bounded transcript projections have no message IDs and drop older entries.
// Content + duplicate occurrence keeps disclosures on their own message as
// that window advances, without assigning display identity from array indices.
function withContentKeys<T>(items: readonly T[]) {
  const occurrences = new Map<string, number>();
  return items.map((item) => {
    const content = JSON.stringify(item);
    const occurrence = occurrences.get(content) ?? 0;
    occurrences.set(content, occurrence + 1);
    return { item, key: `${content}:${occurrence}` };
  });
}

function ToolStep({
  name,
  args,
  output,
  state,
}: {
  name: string;
  args?: string;
  output?: string;
  state: "running" | "done" | "error" | "unknown";
}) {
  const { t } = useTranslation();
  return (
    <details className="subagent-tool">
      <summary>
        <code>{name}</code>
        <span className={`subagent-state ${state}`}>
          {t(`subagentTool_${state}`)}
        </span>
      </summary>
      {args && (
        <>
          <strong className="subagent-tool-label">
            {t("trajectoryArguments")}
          </strong>
          <pre>{args}</pre>
        </>
      )}
      {output && (
        <>
          <strong className="subagent-tool-label">
            {t("trajectoryOutput")}
          </strong>
          <pre>{output}</pre>
        </>
      )}
    </details>
  );
}

function SubagentDetailView({
  sessionId,
  id,
  activity,
  client,
  saved,
  liveAvailable,
  fullView,
}: {
  sessionId: string;
  id: string;
  activity?: WebSubagentActivity;
  client: WebClient;
  saved?: RecordedSubagent;
  liveAvailable: boolean;
  fullView: boolean;
}) {
  const { t } = useTranslation();
  const [detail, setDetail] = useState<WebSubagentDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [revision, refresh] = useState(0);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  // biome-ignore lint/correctness/useExhaustiveDependencies: revision explicitly requests a fresh detail projection.
  useEffect(() => {
    if (!liveAvailable) {
      setLoading(false);
      setError(t("subagentUnavailable"));
      return;
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight = false;
    const read = async () => {
      if (
        inFlight ||
        controller.signal.aborted ||
        document.visibilityState === "hidden"
      )
        return;
      inFlight = true;
      let running = activity?.status === "running";
      try {
        const response = await client.subagentDetail(
          sessionId,
          id,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        if (
          response.sessionId !== sessionId ||
          response.detail.kind !== "subagents" ||
          response.detail.id !== id
        ) {
          setDetail(null);
          running = false;
          throw new Error(t("inspectionChanged"));
        }
        running = response.detail.status === "running";
        setDetail(response.detail);
        setError(null);
        setUpdatedAt(new Date().toLocaleTimeString());
      } catch (caught) {
        if (controller.signal.aborted) return;
        setError(
          caught instanceof WebApiError && [404, 501].includes(caught.status)
            ? t("subagentUnavailable")
            : caught instanceof Error
              ? caught.message
              : t("inspectionUnavailable"),
        );
      } finally {
        inFlight = false;
        if (!controller.signal.aborted) {
          setLoading(false);
          if (running) timer = setTimeout(() => void read(), 1_000);
        }
      }
    };
    const resume = () => {
      if (document.visibilityState !== "visible") return;
      clearTimeout(timer);
      void read();
    };
    document.addEventListener("visibilitychange", resume);
    void read();
    return () => {
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [client, sessionId, id, activity?.status, revision, liveAvailable, t]);

  useLayoutEffect(() => {
    void detail;
    const element = viewport.current;
    if (element && pinned.current) element.scrollTop = element.scrollHeight;
  }, [detail]);

  const results = new Map(
    detail?.transcript.flatMap((item) =>
      item.kind === "toolResult" ? [[item.toolId, item] as const] : [],
    ),
  );
  const calls = new Set(
    detail?.transcript.flatMap((item) =>
      item.kind === "assistant"
        ? item.parts.flatMap((part) =>
            part.type === "toolCall" ? [part.toolId] : [],
          )
        : [],
    ),
  );
  const state =
    detail?.outcome === "interrupted" ? "interrupted" : detail?.status;
  const finalInTranscript = detail?.transcript.some(
    (item) =>
      item.kind === "assistant" &&
      item.parts
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("\n")
        .trim() === detail.finalText.trim(),
  );
  const SectionHeading = fullView ? "h2" : "h3";
  return (
    <section className="subagent-detail" aria-label={t("subagentDetails")}>
      <header className="subagent-detail-heading">
        <div>
          <span className={`subagent-state ${state ?? "unknown"}`}>
            {state
              ? t(`subagentState_${state}`)
              : saved?.state
                ? `${t("subagentRecordedState")}: ${t(`subagentState_${saved.state}`)}`
                : t("unknownState")}
          </span>
          {detail && (
            <span className="subagent-duration">
              {formatElapsedMs(detail.createdAt, detail.settledAt)}
            </span>
          )}
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label={t("refreshStatus")}
          disabled={loading || !liveAvailable}
          onClick={() => {
            setLoading(true);
            refresh((value) => value + 1);
          }}
        >
          <RefreshCw />
        </button>
      </header>
      {loading && !detail && <p role="status">{t("inspectionLoading")}</p>}
      {error && (
        <div className="inspection-warning" role="alert">
          <p>{detail ? t("subagentStale") : t("subagentUnavailable")}</p>
          {error !== t("subagentUnavailable") && <small>{error}</small>}
        </div>
      )}
      {detail && (
        <>
          <div className="subagent-metadata">
            <code>{detail.id}</code>
            {detail.model && <span>{detail.model}</span>}
            <span title={detail.cwd}>{detail.cwd}</span>
          </div>
          <details className="subagent-task">
            <summary>{t("subagentTask")}</summary>
            <pre>{detail.prompt}</pre>
          </details>
          {detail.errorText && (
            <p className="inspection-warning" role="alert">
              {detail.errorText}
            </p>
          )}
          {detail.truncated && (
            <p className="inspection-note">
              {t("subagentTruncated", { count: detail.omittedEntries })}
            </p>
          )}
          <div
            className="subagent-transcript"
            ref={viewport}
            role="log"
            aria-label={t("subagentTranscript")}
            onScroll={(event) => {
              const el = event.currentTarget;
              pinned.current =
                el.scrollHeight - el.clientHeight - el.scrollTop < 48;
            }}
          >
            {withContentKeys(detail.transcript).map(({ item, key }) => (
              <div className={`subagent-message ${item.kind}`} key={key}>
                {item.kind === "user" ? (
                  <p className="subagent-user-message">{item.text}</p>
                ) : item.kind === "toolResult" ? (
                  calls.has(item.toolId) ? null : (
                    <ToolStep
                      name={item.name}
                      output={item.outputPreview}
                      state={item.isError ? "error" : "done"}
                    />
                  )
                ) : (
                  withContentKeys(item.parts).map(
                    ({ item: part, key: partKey }) =>
                      part.type === "text" ? (
                        <Markdown key={partKey}>{part.text}</Markdown>
                      ) : part.type === "thinking" ? (
                        <details className="subagent-thinking" key={partKey}>
                          <summary>{t("thinkingDone")}</summary>
                          <pre>
                            {part.redacted
                              ? t("subagentThinkingRedacted")
                              : part.text}
                          </pre>
                        </details>
                      ) : (
                        <ToolStep
                          key={part.toolId}
                          name={part.name}
                          args={part.argsPreview}
                          output={
                            results.get(part.toolId)?.outputPreview ??
                            detail.liveTools.find(
                              (tool) => tool.toolId === part.toolId,
                            )?.outputPreview
                          }
                          state={
                            results.has(part.toolId)
                              ? results.get(part.toolId)!.isError
                                ? "error"
                                : "done"
                              : detail.liveTools.some(
                                    (tool) =>
                                      tool.toolId === part.toolId && !tool.done,
                                  )
                                ? "running"
                                : "unknown"
                          }
                        />
                      ),
                  )
                )}
              </div>
            ))}
            {detail.liveAssistant?.thinking && (
              <details className="subagent-thinking">
                <summary>{t("thinkingActive")}</summary>
                <pre>{detail.liveAssistant.thinking}</pre>
              </details>
            )}
            {detail.liveAssistant?.text && (
              <Markdown>{detail.liveAssistant.text}</Markdown>
            )}
            {detail.liveTools
              .filter((tool) => !calls.has(tool.toolId))
              .map((tool) => (
                <ToolStep
                  key={tool.toolId}
                  name={tool.name}
                  args={tool.argsPreview}
                  output={tool.outputPreview}
                  state={
                    tool.done ? (tool.isError ? "error" : "done") : "running"
                  }
                />
              ))}
            {detail.finalText && !finalInTranscript && (
              <section className="subagent-final">
                <SectionHeading>{t("subagentResult")}</SectionHeading>
                <Markdown>{detail.finalText}</Markdown>
              </section>
            )}
            {detail.status === "running" && (
              <p className="subagent-live" role="status">
                {t("subagentLive")}
              </p>
            )}
            {!detail.transcript.length &&
              !detail.liveAssistant?.text &&
              !detail.finalText && <p>{t("subagentNoMessages")}</p>}
          </div>
          <p className="subagent-footnote">
            {t("subagentReadOnly")}
            {updatedAt && ` · ${updatedAt}`}
          </p>
        </>
      )}
      {!detail && !loading && saved && (
        <section
          className="subagent-transcript"
          aria-label={t("subagentSaved")}
        >
          <SectionHeading>{t("subagentSaved")}</SectionHeading>
          <p className="inspection-note">{t("subagentSavedHint")}</p>
          {saved.state && (
            <p>
              {t("subagentRecordedState")}: {t(`subagentState_${saved.state}`)}
            </p>
          )}
          {saved.result && <Markdown>{saved.result}</Markdown>}
          {saved.receipt && (
            <details className="subagent-task">
              <summary>{t("subagentSpawnReceipt")}</summary>
              <pre>{saved.receipt}</pre>
            </details>
          )}
        </section>
      )}
    </section>
  );
}

export function SubagentPanel({
  sessionId,
  initialId,
  activity,
  records = [],
  liveAvailable = true,
  onClose,
}: {
  sessionId: string;
  initialId?: string;
  activity?: WebCapabilityProjection<WebSubagentActivity>;
  records?: readonly RecordedSubagent[];
  liveAvailable?: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [selectedId, select] = useState<string | null>(initialId ?? null);
  const [fullView, setFullView] = useState(
    () => window.matchMedia?.("(max-width: 1100px)").matches ?? false,
  );
  useEffect(() => {
    const media = window.matchMedia?.("(max-width: 1100px)");
    if (!media) return;
    const update = () => setFullView(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const client = useMemo(() => new WebClient(), []);
  const items = activity?.items ?? [];
  const selected = items.find((item) => item.id === selectedId);
  const saved = records.find((item) => item.id === selectedId);
  const navigationButton = useRef<HTMLButtonElement>(null);
  const previousFocus = useRef(document.activeElement);
  useEffect(() => {
    // Moving between the overview and a child conversation changes the header.
    void selectedId;
    navigationButton.current?.focus();
  }, [selectedId]);
  useEffect(
    () => () => {
      queueMicrotask(() => {
        if (
          !document.querySelector(".subagent-panel") &&
          previousFocus.current instanceof HTMLElement &&
          previousFocus.current.isConnected
        )
          previousFocus.current.focus();
      });
    },
    [],
  );
  const allTasks = [
    ...items.map((item) => ({
      id: item.id,
      title: item.title,
      state: item.outcome === "interrupted" ? "interrupted" : item.status,
      elapsed: formatElapsedMs(item.createdAt, item.settledAt),
      saved: false,
    })),
    ...records
      .filter((record) => !items.some((item) => item.id === record.id))
      .map((record) => ({
        id: record.id,
        title: record.title,
        state: record.state,
        elapsed: "",
        saved: true,
      })),
  ];
  const Surface = fullView ? "main" : "aside";
  const Heading = fullView ? "h1" : "h2";
  const GroupHeading = fullView ? "h2" : "h3";
  return (
    <Surface
      className="subagent-panel"
      aria-label={t("subagentDetails")}
      onKeyDown={(event) => {
        if (
          event.key === "Escape" &&
          !event.nativeEvent.isComposing &&
          !event.defaultPrevented
        ) {
          event.preventDefault();
          if (selectedId) select(null);
          else onClose();
        }
      }}
    >
      <header className="subagent-panel-heading">
        <div className="subagent-breadcrumb">
          {selectedId && (
            <button
              ref={navigationButton}
              type="button"
              className="icon-button"
              aria-label={t("backToSubagents")}
              onClick={() => select(null)}
            >
              <ArrowLeft />
            </button>
          )}
          <Bot aria-hidden="true" />
          <Heading>
            {selectedId
              ? selected?.title || saved?.title || selectedId
              : t("subagentDetails")}
          </Heading>
        </div>
        <button
          ref={selectedId ? undefined : navigationButton}
          type="button"
          className="icon-button"
          aria-label={t("close")}
          onClick={onClose}
        >
          <X />
        </button>
      </header>
      {selectedId ? (
        <SubagentDetailView
          key={`${sessionId}:${selectedId}`}
          sessionId={sessionId}
          id={selectedId}
          activity={selected}
          client={client}
          saved={saved}
          liveAvailable={liveAvailable}
          fullView={fullView}
        />
      ) : (
        <nav className="subagent-list" aria-label={t("subagentTasks")}>
          {[true, false].map((running) => {
            const group = allTasks.filter(
              (item) => (item.state === "running" && !item.saved) === running,
            );
            return (
              <section key={String(running)} className="subagent-list-group">
                <GroupHeading>
                  {t(running ? "subagentActiveGroup" : "subagentFinishedGroup")}
                  <span>{group.length}</span>
                </GroupHeading>
                {!group.length && (
                  <p>
                    {t(
                      running ? "subagentNoneRunning" : "subagentNoneFinished",
                    )}
                  </p>
                )}
                <List density="compact">
                  {group.map((item) => (
                    <ListItem
                      key={item.id}
                      className="subagent-task-row"
                      onClick={() => select(item.id)}
                      label={item.title || item.id}
                      description={
                        item.saved
                          ? t("subagentSaved")
                          : t(`subagentState_${item.state}`)
                      }
                      startContent={
                        <StatusDot
                          label={
                            item.saved
                              ? t("subagentSaved")
                              : t(`subagentState_${item.state}`)
                          }
                          variant={
                            item.saved
                              ? "neutral"
                              : item.state === "running"
                                ? "accent"
                                : item.state === "done"
                                  ? "success"
                                  : "error"
                          }
                          isPulsing={!item.saved && item.state === "running"}
                        />
                      }
                      endContent={
                        <span className="subagent-task-end">
                          <span>{item.elapsed}</span>
                          <ChevronRight aria-hidden="true" />
                        </span>
                      }
                    />
                  ))}
                </List>
              </section>
            );
          })}
          {Boolean(activity?.omitted) && (
            <p>{t("subagentListTruncated", { count: activity?.omitted })}</p>
          )}
        </nav>
      )}
    </Surface>
  );
}
