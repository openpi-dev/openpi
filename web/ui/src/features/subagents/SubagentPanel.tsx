import { List, ListItem } from "@astryxdesign/core/List";
import { ArrowLeft, Bot, LoaderCircle, RefreshCw, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { formatSubagentSpend } from "../../../../../extensions/shared/context-utilization.ts";
import type {
  WebCapabilityProjection,
  WebSubagentActivity,
  WebSubagentDetail,
  WebWorkflowActivity,
  WebWorkflowAgentActivity,
  WebWorkflowAgentDetail,
} from "../../../../../extensions/shared/web-observer-registry.ts";
import { Markdown } from "../../components/Markdown.tsx";
import { formatElapsedMs } from "../../lib/format.ts";
import { WebApiError, WebClient } from "../../protocol/client.ts";
import { webStore } from "../../store/web-store.ts";
import { ArtifactContext } from "../artifacts/context.ts";
import { Transcript } from "../transcript/Transcript.tsx";
import type { RecordedSubagent } from "./recorded-subagents.ts";
import { SubagentAvatar } from "./SubagentAvatar.tsx";
import { subagentOverview } from "./subagent-overview.ts";
import { subagentTranscriptSnapshot } from "./subagent-transcript.ts";

export function SubagentDetailView({
  sessionId,
  id,
  kind = "subagents",
  activity,
  client,
  saved,
  liveAvailable,
  fullView,
  readOnlyNote = true,
  active = true,
  refreshRevision = 0,
  onDetail,
  showModel = true,
}: {
  sessionId: string;
  id: string;
  kind?: "subagents" | "workflows";
  activity?: WebSubagentActivity | WebWorkflowAgentActivity;
  client: WebClient;
  saved?: RecordedSubagent;
  liveAvailable: boolean;
  fullView: boolean;
  readOnlyNote?: boolean;
  active?: boolean;
  refreshRevision?: number;
  onDetail?: (detail: WebSubagentDetail | WebWorkflowAgentDetail) => void;
  showModel?: boolean;
}) {
  const { t } = useTranslation();
  const [detail, setDetail] = useState<
    WebSubagentDetail | WebWorkflowAgentDetail | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [revision, refresh] = useState(0);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const preferences = useStore(
    webStore,
    (state) => state.snapshot?.preferences,
  );
  const transcript = useMemo(
    () =>
      detail
        ? subagentTranscriptSnapshot(
            sessionId,
            detail,
            preferences ?? { theme: "system" },
            t("subagentThinkingRedacted"),
          )
        : null,
    [sessionId, detail, preferences, t],
  );
  const detailListener = useRef(onDetail);
  detailListener.current = onDetail;

  // biome-ignore lint/correctness/useExhaustiveDependencies: revisions explicitly request a fresh detail projection.
  useEffect(() => {
    if (!active) return;
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
        const response = await (kind === "workflows"
          ? client.workflowAgentDetail(sessionId, id, controller.signal)
          : client.subagentDetail(sessionId, id, controller.signal));
        if (controller.signal.aborted) return;
        if (
          response.sessionId !== sessionId ||
          response.detail.kind !== kind ||
          response.detail.id !== id
        ) {
          setDetail(null);
          running = false;
          throw new Error(t("inspectionChanged"));
        }
        running = response.detail.status === "running";
        setDetail(response.detail);
        detailListener.current?.(response.detail);
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
  }, [
    active,
    client,
    sessionId,
    id,
    kind,
    activity?.status,
    revision,
    refreshRevision,
    liveAvailable,
    t,
  ]);

  const state =
    detail?.outcome === "interrupted" ? "interrupted" : detail?.status;
  const spend = formatSubagentSpend(detail?.spend);
  const SectionHeading = fullView ? "h2" : "h3";
  return (
    <section
      className="subagent-detail"
      aria-label={t("subagentDetails")}
      hidden={!active}
    >
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
      {loading && !detail && (
        <div className="inspection-loading" role="status">
          <p>{t("inspectionLoading")}</p>
          <div aria-hidden="true">
            <i />
            <i />
            <i />
          </div>
        </div>
      )}
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
            {showModel && detail.model && <span>{detail.model}</span>}
            {spend && <span title={t("subagentSpend")}>{spend}</span>}
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
          <div className="subagent-conversation">
            <ArtifactContext.Provider value={null}>
              {transcript && (
                <Transcript
                  snapshot={transcript}
                  label={t("subagentTranscript")}
                  activityObserved={active && !error}
                  liveMessages={[]}
                  liveRunning={detail.status === "running"}
                  livePhase={detail.status === "running" ? "running" : "idle"}
                  liveRetry={null}
                  thinkingStarts={{}}
                  thinkingDurations={{}}
                  scrollToBottom={0}
                  notice={
                    <>
                      {detail.truncated && (
                        <p className="inspection-note">
                          {t(
                            detail.omittedEntries > 0
                              ? "subagentTruncated"
                              : "subagentTextTruncated",
                            { count: detail.omittedEntries },
                          )}
                        </p>
                      )}
                      {detail.kind === "workflows" &&
                      detail.transcriptUnavailable ? (
                        <p className="inspection-note">
                          {t("subagentTranscriptUnavailable")}
                        </p>
                      ) : !detail.transcript.length &&
                        !detail.liveAssistant?.text &&
                        !detail.liveAssistant?.thinking &&
                        !detail.liveTools.length &&
                        !detail.finalText ? (
                        <p className="inspection-note">
                          {t("subagentNoMessages")}
                        </p>
                      ) : null}
                    </>
                  }
                />
              )}
            </ArtifactContext.Provider>
          </div>
          {(readOnlyNote || updatedAt) && (
            <p className="subagent-footnote">
              {readOnlyNote && t("subagentReadOnly")}
              {readOnlyNote && updatedAt && " · "}
              {updatedAt}
            </p>
          )}
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
  initialKind = "subagents",
  activity,
  workflows,
  observed = true,
  records = [],
  liveAvailable = true,
  onClose,
}: {
  sessionId: string;
  initialId?: string;
  initialKind?: "subagents" | "workflows";
  activity?: WebCapabilityProjection<WebSubagentActivity>;
  workflows?: WebCapabilityProjection<WebWorkflowActivity>;
  observed?: boolean;
  records?: readonly RecordedSubagent[];
  liveAvailable?: boolean;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [expandedGroups, setExpandedGroups] = useState<string[]>([]);
  const listViewport = useRef<HTMLElement>(null);
  const listScroll = useRef(0);
  const [selection, setSelection] = useState<{
    id: string;
    kind: "subagents" | "workflows";
  } | null>(initialId ? { id: initialId, kind: initialKind } : null);
  const [detailTarget, setDetailTarget] = useState(selection);
  const [modelIdentity, setModelIdentity] = useState<{
    id: string;
    kind: "subagents" | "workflows";
    model?: string;
  } | null>(null);
  const selectedId = selection?.id;
  useLayoutEffect(() => {
    if (!selectedId && listViewport.current)
      listViewport.current.scrollTop = listScroll.current;
  }, [selectedId]);
  const select = (
    id: string | null,
    kind: "subagents" | "workflows" = "subagents",
  ) => {
    const target = id ? { id, kind } : null;
    if (target) setDetailTarget(target);
    setSelection(target);
  };
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
  const items = liveAvailable ? (activity?.items ?? []) : [];
  const workflowItems = liveAvailable ? (workflows?.items ?? []) : [];
  const allTasks = subagentOverview(items, records, workflowItems, observed);
  const omittedTasks =
    (activity?.omitted ?? 0) +
    workflowItems.reduce((sum, item) => sum + (item.children?.omitted ?? 0), 0);
  const selected = allTasks.find(
    (item) => item.id === selectedId && item.kind === selection?.kind,
  );
  const saved =
    selection?.kind === "subagents"
      ? records.find((item) => item.id === selectedId)
      : undefined;
  const model =
    modelIdentity?.id === selectedId && modelIdentity?.kind === selection?.kind
      ? modelIdentity?.model
      : saved?.model;
  const navigationButton = useRef<HTMLButtonElement>(null);
  const previousFocus = useRef(document.activeElement);
  useEffect(() => {
    // Moving between the overview and a child conversation changes the header.
    void selection;
    navigationButton.current?.focus();
  }, [selection]);
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
  const groups = [
    {
      key: "active",
      label: "subagentActiveGroup",
      items: allTasks.filter((item) => item.state === "running"),
      empty: "subagentNoneRunning",
    },
    {
      key: "done",
      label: "subagentFinishedGroup",
      items: allTasks.filter((item) => item.state === "done"),
      empty: "subagentNoneFinished",
    },
    {
      key: "attention",
      label: "subagentOtherGroup",
      items: allTasks.filter(
        (item) => item.state === "error" || item.state === "interrupted",
      ),
    },
    {
      key: "saved",
      label: "subagentUnconfirmedGroup",
      items: allTasks.filter((item) => !item.state),
    },
  ];
  const relativeTime = (timestamp: number) => {
    const elapsed = Math.max(0, Date.now() - timestamp);
    const unit =
      elapsed < 3_600_000 ? "minute" : elapsed < 86_400_000 ? "hour" : "day";
    const divisor =
      unit === "minute" ? 60_000 : unit === "hour" ? 3_600_000 : 86_400_000;
    return new Intl.RelativeTimeFormat(i18n.language, {
      numeric: "auto",
    }).format(-Math.floor(elapsed / divisor), unit);
  };
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
          {selectedId ? (
            <SubagentAvatar identity={`${sessionId}:${selectedId}`} />
          ) : (
            <Bot aria-hidden="true" />
          )}
          <Heading title={selected?.title || saved?.title || selectedId}>
            {selectedId
              ? selected?.title || saved?.title || selectedId
              : t("subagentDetails")}
          </Heading>
        </div>
        {selectedId && model && (
          <span className="subagent-panel-model" title={model}>
            {model.split("/").at(-1)}
          </span>
        )}
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
      {detailTarget && (
        <SubagentDetailView
          key={`${sessionId}:${detailTarget.kind}:${detailTarget.id}`}
          sessionId={sessionId}
          id={detailTarget.id}
          kind={detailTarget.kind}
          activity={
            detailTarget.kind === "subagents"
              ? items.find((item) => item.id === detailTarget.id)
              : workflowItems
                  .flatMap((item) => item.children?.items ?? [])
                  .find((item) => item.id === detailTarget.id)
          }
          client={client}
          saved={
            detailTarget.kind === "subagents"
              ? records.find((record) => record.id === detailTarget.id)
              : undefined
          }
          liveAvailable={liveAvailable}
          fullView={fullView}
          showModel={false}
          active={Boolean(selectedId)}
          onDetail={(detail) =>
            setModelIdentity((previous) =>
              previous?.id === detail.id &&
              previous.kind === detail.kind &&
              previous.model === detail.model
                ? previous
                : { id: detail.id, kind: detail.kind, model: detail.model },
            )
          }
        />
      )}
      {!selectedId && (
        <nav
          className="subagent-list"
          aria-label={t("subagentTasks")}
          ref={listViewport}
          onScroll={(event) => {
            listScroll.current = event.currentTarget.scrollTop;
          }}
        >
          {groups.map((group) => {
            if (!group.items.length && !group.empty) return null;
            const visible = expandedGroups.includes(group.key)
              ? group.items
              : group.items.slice(0, group.key === "active" ? 4 : 10);
            return (
              <section key={group.key} className="subagent-list-group">
                <GroupHeading>
                  {t(group.label)}
                  <span aria-hidden="true">·</span>
                  <span>{group.items.length}</span>
                </GroupHeading>
                {!group.items.length && group.empty && <p>{t(group.empty)}</p>}
                <List density="compact">
                  {visible.map((item) => (
                    <ListItem
                      key={`${item.kind}:${item.id}`}
                      className={`subagent-task-row ${item.state ?? "unknown"}`}
                      onClick={() => select(item.id, item.kind)}
                      label={
                        <span
                          className="subagent-task-title"
                          title={item.title || item.id}
                        >
                          {item.title || item.id}
                          {item.state === "running" && (
                            <span className="subagent-task-status">
                              {` · ${t("subagentState_running")}`}
                            </span>
                          )}
                        </span>
                      }
                      description={
                        item.state === "running"
                          ? undefined
                          : item.saved
                            ? `${t("subagentSaved")} · ${t(`subagentState_${item.state ?? "unknown"}`)}`
                            : t(`subagentState_${item.state ?? "unknown"}`)
                      }
                      startContent={
                        <SubagentAvatar identity={`${sessionId}:${item.id}`} />
                      }
                      endContent={
                        <span className="subagent-task-end">
                          {item.state === "running" ? (
                            <LoaderCircle
                              className="subagent-running-icon"
                              aria-hidden="true"
                            />
                          ) : item.timestamp ? (
                            <time
                              dateTime={new Date(item.timestamp).toISOString()}
                              title={new Date(item.timestamp).toLocaleString(
                                i18n.language,
                              )}
                            >
                              {relativeTime(item.timestamp)}
                            </time>
                          ) : null}
                        </span>
                      }
                    />
                  ))}
                </List>
                {visible.length < group.items.length && (
                  <button
                    type="button"
                    className="subagent-show-more"
                    onClick={() =>
                      setExpandedGroups((current) => [...current, group.key])
                    }
                  >
                    {t("subagentShowMore", {
                      count: group.items.length - visible.length,
                    })}
                  </button>
                )}
              </section>
            );
          })}
          {omittedTasks > 0 && (
            <p>{t("subagentListTruncated", { count: omittedTasks })}</p>
          )}
          {Boolean(workflows?.omitted) && (
            <p>
              {t("subagentWorkflowsTruncated", { count: workflows?.omitted })}
            </p>
          )}
        </nav>
      )}
    </Surface>
  );
}
