import { memo, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { WebSnapshot } from "../../../../protocol/types.ts";
import { buildTrajectory } from "./trajectory.ts";

const EMPTY: NonNullable<WebSnapshot["selectedSession"]>["entries"] = [];
export const Trajectory = memo(function Trajectory({
  snapshot,
  running,
}: {
  snapshot: WebSnapshot;
  running: boolean;
}) {
  const { t } = useTranslation();
  const entries = snapshot.selectedSession?.entries ?? EMPTY;
  const nodes = useMemo(() => buildTrajectory(entries), [entries]);
  const [selectedKey, select] = useState<string | null>(null);
  const [limit, setLimit] = useState(50);
  const selectedIndex = nodes.findIndex((node) => node.key === selectedKey);
  const start = Math.min(
    Math.max(0, nodes.length - limit),
    selectedIndex < 0 ? nodes.length : selectedIndex,
  );
  const visible = nodes.slice(start);
  const selected =
    visible.find((node) => node.key === selectedKey) ?? visible.at(-1);
  const truncation = snapshot.selectedSession?.truncation;
  const output = selected?.result;
  const message = selected?.message;
  return (
    <section className="conversation trajectory" aria-label={t("trajectory")}>
      <header className="trajectory-heading">
        <h2>{t("trajectory")}</h2>
        <p>{t("trajectoryScope")}</p>
        {running && <p role="status">{t("trajectoryRunning")}</p>}
        {truncation?.truncated && (
          <p className="trajectory-warning">
            {t("trajectoryTruncated", {
              entries: truncation.entriesOmitted,
              parts: truncation.messagePartsOmitted,
              messages: truncation.messagesTruncated,
            })}
          </p>
        )}
      </header>
      {!nodes.length ? (
        <p>{t("trajectoryEmpty")}</p>
      ) : (
        <>
          <nav
            className="trajectory-overview"
            aria-label={t("trajectoryOverview")}
          >
            {visible.map((node, index) => (
              <button
                key={node.key}
                type="button"
                aria-label={`${t(`trajectory_${node.kind}`)} ${nodes.length - visible.length + index + 1}: ${node.title}`}
                aria-pressed={node.key === selected?.key}
                onClick={() => select(node.key)}
                className={`trajectory-point ${node.kind} ${node.outcome ?? ""}`}
              >
                <span>{nodes.length - visible.length + index + 1}</span>
              </button>
            ))}
          </nav>
          <div className="trajectory-body">
            <div className="trajectory-ledger">
              {start > 0 && (
                <button
                  type="button"
                  className="trajectory-load"
                  onClick={() => setLimit((value) => value + 50)}
                >
                  {t("trajectoryEarlier", { count: start })}
                </button>
              )}
              <ol start={nodes.length - visible.length + 1}>
                {visible.map((node) => (
                  <li key={node.key}>
                    <button
                      type="button"
                      aria-pressed={node.key === selected?.key}
                      onClick={() => select(node.key)}
                      className={`trajectory-record ${node.kind}`}
                    >
                      <span className="trajectory-kind">
                        {t(`trajectory_${node.kind}`)}
                      </span>
                      <strong>{node.title}</strong>
                      <span className="trajectory-preview">
                        {(
                          node.input ??
                          node.message?.content ??
                          node.result?.content ??
                          ""
                        ).slice(0, 110)}
                      </span>
                      {node.outcome && (
                        <span>{t(`trajectory_${node.outcome}`)}</span>
                      )}
                    </button>
                  </li>
                ))}
              </ol>
            </div>
            {selected && (
              <section
                className="trajectory-inspector"
                aria-label={t("trajectoryDetails")}
              >
                <h3>{selected.title}</h3>
                {selected.timestamp && (
                  <p className="trajectory-metadata">
                    {t("trajectoryRecordedAt")}:{" "}
                    <time>{selected.timestamp}</time>
                  </p>
                )}
                {selected.callId && (
                  <p className="trajectory-metadata">
                    Tool call ID: {selected.callId}
                  </p>
                )}
                {(message?.truncation || output?.truncation) && (
                  <p className="trajectory-warning">
                    {t("trajectoryEvidenceTruncated")}
                  </p>
                )}
                {selected.input !== undefined && (
                  <>
                    <h4>{t("trajectoryArguments")}</h4>
                    <pre>{selected.input}</pre>
                  </>
                )}
                {message && selected.kind !== "call" && (
                  <>
                    <h4>{t("trajectoryRecordedContent")}</h4>
                    <pre>{message.content || t("noOutput")}</pre>
                    {message.parts?.some(
                      (part) => part.type === "thinking",
                    ) && (
                      <details key={selected.key}>
                        <summary>{t("trajectoryThinking")}</summary>
                        <pre>
                          {message.parts
                            .filter((part) => part.type === "thinking")
                            .map((part) => part.text)
                            .join("\n\n")}
                        </pre>
                      </details>
                    )}
                  </>
                )}
                {(selected.kind === "call" || selected.kind === "result") && (
                  <>
                    <h4>{t("trajectoryOutput")}</h4>
                    <p>{t(`trajectory_${selected.outcome ?? "unknown"}`)}</p>
                    {output ? (
                      <pre>{output.content || t("noOutput")}</pre>
                    ) : (
                      <p>{t("trajectoryMissingResult")}</p>
                    )}
                    {output?.details !== undefined && (
                      <details>
                        <summary>{t("trajectoryStructured")}</summary>
                        <pre>{JSON.stringify(output.details, null, 2)}</pre>
                      </details>
                    )}
                  </>
                )}
                {selected.kind === "event" && !message && (
                  <p>{t("trajectoryEventOnly")}</p>
                )}
              </section>
            )}
          </div>
        </>
      )}
    </section>
  );
});
