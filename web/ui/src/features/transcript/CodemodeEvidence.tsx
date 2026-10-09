import { useContext, useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { projectCodemodeEvidence } from "../../../../protocol/codemode.ts";
import {
  evidenceText,
  type EvidenceState,
  type LiveToolEvidence,
} from "../../../../protocol/evidence.ts";
import type {
  WebLiveMessage,
  WebMessagePart,
} from "../../../../protocol/types.ts";
import { ArtifactContext } from "../artifacts/context.ts";
import { CodeBlock } from "../../components/Markdown.tsx";
import {
  toolActivity,
  toolActivityLabel,
  toolActivityTarget,
} from "./tool-activity.ts";
import { ToolEvidence } from "./ToolEvidence.tsx";

function NestedCall({
  item,
}: {
  item: ReturnType<typeof projectCodemodeEvidence>["calls"][number];
}) {
  const { t } = useTranslation();
  const artifacts = useContext(ArtifactContext);
  const { Icon, action } = toolActivity(item.name);
  const path = typeof item.args?.path === "string" ? item.args.path : undefined;
  const target = evidenceText(
    toolActivityTarget(item.name, item.args ?? {}),
  ).text;
  const filename = path?.slice(
    Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1,
  );
  return (
    <div className="codemode-call" data-call-id={item.id}>
      {item.live && ["read", "write", "edit", "bash"].includes(item.name) ? (
        <ToolEvidence
          call={item.live.call}
          result={item.live.result}
          liveState={item.live.state}
        />
      ) : (
        <details
          className="tool-evidence-card"
          data-tool={item.name}
          data-state={item.state}
        >
          <summary>
            <span className="evidence-icon" aria-hidden="true">
              <Icon />
            </span>
            {(["read", "write", "edit"].includes(item.name) ||
              action === "call") && (
              <strong className="tool-name">{item.name}</strong>
            )}
            <span className="evidence-target" title={path ?? target}>
              <span className="tool-action">
                {toolActivityLabel(t, item.name, item.state)}
              </span>
              {path && artifacts ? (
                <button
                  className="evidence-filename artifact-link"
                  title={path}
                  type="button"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    artifacts.open(path);
                  }}
                >
                  {filename}
                </button>
              ) : (
                <span className="evidence-command">
                  {path ? filename : target}
                </span>
              )}
            </span>
            {item.durationMs !== undefined && (
              <span className="evidence-summary-meta">
                {item.durationMs < 1000
                  ? `${Math.round(item.durationMs)}ms`
                  : `${(item.durationMs / 1000).toFixed(1)}s`}
              </span>
            )}
            <ChevronRight className="evidence-chevron" aria-hidden="true" />
            <span className="evidence-status">
              {t(`toolState_${item.state}`)}
            </span>
          </summary>
          <div className="evidence-content">
            <strong>{t("toolCallArguments")}</strong>
            {item.argumentsText ? (
              <pre>{item.argumentsText}</pre>
            ) : (
              <p className="evidence-warning">
                {t("codemodeArgumentsUnavailable")}
              </p>
            )}
            {item.error && <pre className="evidence-warning">{item.error}</pre>}
            <p>{t("codemodeOutputNotSaved")}</p>
          </div>
        </details>
      )}
    </div>
  );
}

export function CodemodeEvidence({
  call,
  result,
  liveState,
  liveTools,
}: {
  call: Extract<WebMessagePart, { type: "toolCall" }>;
  result?: WebLiveMessage;
  liveState?: EvidenceState;
  liveTools?: readonly LiveToolEvidence[];
}) {
  const { t } = useTranslation();
  const view = projectCodemodeEvidence(call, result, liveState, liveTools);
  const running = view.state === "running";
  const [open, setOpen] = useState(running);
  useEffect(() => setOpen(running), [running]);
  const { Icon } = toolActivity("codemode");
  const current = running
    ? [...view.calls].reverse().find((item) => item.state === "running")
    : undefined;
  const preview = current
    ? [current.name, toolActivityTarget(current.name, current.args ?? {})]
        .filter(Boolean)
        .join(" · ")
    : "";
  const failed = view.calls.filter((item) => item.state === "failed").length;
  return (
    <details
      className="tool-evidence-card codemode-evidence"
      data-tool="codemode"
      data-state={view.state}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <span className="evidence-icon" aria-hidden="true">
          <Icon />
        </span>
        <strong className="tool-name">codemode</strong>
        <span className="evidence-target">
          <span className="tool-action">
            {toolActivityLabel(t, "codemode", view.state)}
          </span>
          {preview && (
            <span className="evidence-command" title={preview}>
              {preview}
            </span>
          )}
        </span>
        {view.calls.length > 0 && (
          <span className="evidence-summary-meta">
            {t("codemodeCallCount", { count: view.calls.length })}
          </span>
        )}
        {failed > 0 && (
          <span className="evidence-warning codemode-failure-count">
            {t("codemodeFailedCount", { count: failed })}
          </span>
        )}
        <ChevronRight className="evidence-chevron" aria-hidden="true" />
        <span className="evidence-status">{t(`toolState_${view.state}`)}</span>
      </summary>
      <div className="evidence-content">
        {view.partial && (
          <p className="evidence-warning">{t("codemodePartialCalls")}</p>
        )}
        <section
          className="codemode-calls"
          aria-label={t("codemodeCalls")}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: The bounded call list must support keyboard scrolling.
          tabIndex={0}
        >
          {view.calls.map((item) => (
            <NestedCall key={item.key} item={item} />
          ))}
        </section>
        <details className="codemode-script">
          <summary>{t("codemodeScript")}</summary>
          <CodeBlock>{view.script}</CodeBlock>
        </details>
        {view.output && (
          <figure aria-label={t("codemodeOutput")}>
            <figcaption>{t("codemodeOutput")}</figcaption>
            <CodeBlock>{view.output}</CodeBlock>
          </figure>
        )}
        {view.truncated && (
          <p className="evidence-warning">{t("toolPartialEvidence")}</p>
        )}
        {view.recovery && (
          <p>
            {t("toolFullOutputReference")} <code>{view.recovery}</code>
          </p>
        )}
      </div>
    </details>
  );
}
