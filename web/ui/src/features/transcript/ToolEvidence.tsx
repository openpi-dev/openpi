import { type ReactNode, useContext, useState } from "react";
import { Check, ChevronRight, Clipboard } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  type EvidenceState,
  evidenceText,
  projectToolEvidence,
  toolArguments,
} from "../../../../protocol/evidence.ts";
import type {
  WebLiveMessage,
  WebMessagePart,
} from "../../../../protocol/types.ts";
import { ArtifactContext } from "../artifacts/context.ts";
import { copyText } from "../../lib/clipboard.ts";
import {
  toolActivity,
  toolActivityLabel,
  toolActivityTarget,
} from "./tool-activity.ts";

function EvidenceBlock({
  children,
  className,
  "aria-label": label,
}: {
  children: ReactNode;
  className?: string;
  "aria-label": string;
}) {
  return (
    <figure aria-label={label}>
      <pre className={className}>{children}</pre>
    </figure>
  );
}
export function ToolEvidence({
  call,
  result,
  liveState,
  observed = true,
  cwd,
  defaultOpen = false,
}: {
  call: Extract<WebMessagePart, { type: "toolCall" }>;
  result?: WebLiveMessage;
  liveState?: EvidenceState;
  observed?: boolean;
  cwd?: string;
  defaultOpen?: boolean;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState<{
    source: string;
    status: "copiedCode" | "copyCodeFailed";
  } | null>(null);
  const artifacts = useContext(ArtifactContext);
  const view = projectToolEvidence(call, result, liveState);
  const state = !observed && view.state === "running" ? "unknown" : view.state;
  const fileReference = view.resolvedPath ?? view.path;
  const path = view.path ?? "";
  const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const filename = path.slice(separator + 1) || path;
  const { Icon } = toolActivity(call.name);
  const target = evidenceText(
    view.command ?? toolActivityTarget(call.name, toolArguments(call)),
  ).text;
  const shell = view.kind === "terminal" || view.kind === "test";
  const shellText = [view.command ? `$ ${view.command}` : "", view.output]
    .filter(Boolean)
    .join("\n\n");
  const copySource = `${call.id}:${shellText}`;
  const copyFeedback = copied?.source === copySource ? copied.status : null;
  const lines = (view.diff ?? view.output)
    .split("\n")
    .map((text, index) => ({ text, number: view.offset + index }));
  // These are counts in the displayed result, never guesses from edit arguments.
  const additions = view.diff
    ? lines.filter((line) => /^\+(?!\+\+)/u.test(line.text)).length
    : 0;
  const deletions = view.diff
    ? lines.filter((line) => /^-(?!--)/u.test(line.text)).length
    : 0;
  const failures =
    view.tests?.failures.map((text, index) => ({ text, number: index + 1 })) ??
    [];
  return (
    <details
      className={`tool-evidence-card evidence-${view.kind}`}
      data-state={state}
      data-tool={call.name}
      open={defaultOpen || undefined}
    >
      <summary>
        <span className="evidence-icon" aria-hidden="true">
          <Icon />
        </span>
        {["read", "write", "edit"].includes(call.name) && (
          <strong className="tool-name">{call.name}</strong>
        )}
        <span className="evidence-target" title={view.path || target}>
          <span className="tool-action">
            {toolActivityLabel(t, call.name, state)}
          </span>
          {path ? (
            artifacts && fileReference ? (
              <button
                type="button"
                className="evidence-filename artifact-link"
                title={fileReference}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  artifacts.open(fileReference);
                }}
              >
                {filename}
              </button>
            ) : (
              <span className="evidence-filename">{filename}</span>
            )
          ) : target ? (
            <span className="evidence-command">{target}</span>
          ) : null}
        </span>
        {view.diff && (additions > 0 || deletions > 0) && (
          <span
            className="evidence-summary-meta"
            title={t("toolDiffStatsHelp")}
          >
            <span className="review-additions">
              +{additions.toLocaleString()}
            </span>
            <span className="review-deletions">
              −{deletions.toLocaleString()}
            </span>
            {view.truncated && <span>{t("gitReviewPartialLabel")}</span>}
          </span>
        )}
        <ChevronRight className="evidence-chevron" aria-hidden="true" />
        <span className="evidence-status">{t(`toolState_${state}`)}</span>
      </summary>
      <div className="evidence-content">
        {view.path && (
          <p>
            <strong>{t("toolRequestedFile")}</strong>{" "}
            {artifacts && fileReference ? (
              <button
                className="artifact-link"
                type="button"
                onClick={() => artifacts.open(fileReference)}
              >
                <code>{fileReference}</code>
              </button>
            ) : (
              <code>{fileReference}</code>
            )}
            {cwd && (
              <>
                <br />
                <small>
                  {t("toolWorkspace")}: {cwd}
                </small>
              </>
            )}
          </p>
        )}
        {shell && (
          <figure className="evidence-shell" aria-label={t("toolCallOutput")}>
            <figcaption>
              <span>Shell</span>
              <button
                type="button"
                aria-label={t(
                  copyFeedback === "copiedCode" ? "copiedCode" : "copyCode",
                )}
                title={t(
                  copyFeedback === "copiedCode" ? "copiedCode" : "copyCode",
                )}
                onClick={async () => {
                  const ok = await copyText(shellText);
                  setCopied({
                    source: copySource,
                    status: ok ? "copiedCode" : "copyCodeFailed",
                  });
                }}
              >
                {copyFeedback === "copiedCode" ? <Check /> : <Clipboard />}
              </button>
            </figcaption>
            <pre>{shellText || t("noOutput")}</pre>
            <div className="evidence-process-meta">
              {t(`toolState_${state}`)}
              {view.exitCode !== undefined
                ? ` · exit ${view.exitCode}`
                : view.signal
                  ? ` · ${view.signal}`
                  : ""}
            </div>
            {copyFeedback === "copyCodeFailed" && (
              <p role="status" className="evidence-warning">
                {t(copyFeedback)}
              </p>
            )}
          </figure>
        )}
        {view.truncated && (
          <p className="evidence-warning">{t("toolPartialEvidence")}</p>
        )}
        {view.change && <p>{t(`toolFileChange_${view.change}`)}</p>}
        {view.kind === "change" && !view.diff && !view.change && (
          <p>{view.evidenceUnavailable ?? t("toolChangeUnavailable")}</p>
        )}
        {view.tests && (
          <figure aria-label="Test evidence">
            <figcaption>
              <strong>
                {t("toolTestResults", { format: view.tests.format })}
              </strong>
            </figcaption>
            <p>{t("toolTestCounts", view.tests)}</p>
            <p>{t("toolTestCountsHelp")}</p>
            {failures.map((failure) => (
              <EvidenceBlock
                key={failure.number}
                aria-label={`Failure excerpt ${failure.number}`}
              >
                {failure.text}
              </EvidenceBlock>
            ))}
          </figure>
        )}
        {shell ? null : view.diff ? (
          <EvidenceBlock className="evidence-lines" aria-label="Change diff">
            {lines.map((line) => (
              <span
                className={
                  /^\+/u.test(line.text.trimStart())
                    ? "diff-added"
                    : /^-/u.test(line.text.trimStart())
                      ? "diff-removed"
                      : ""
                }
                key={line.number}
              >
                {line.text}
                {"\n"}
              </span>
            ))}
          </EvidenceBlock>
        ) : view.numberLines ? (
          <EvidenceBlock className="evidence-lines" aria-label="File content">
            {lines.map((line) => (
              <span key={line.number}>
                <span className="evidence-line-number" aria-hidden="true">
                  {line.number}
                </span>
                {line.text}
                {"\n"}
              </span>
            ))}
          </EvidenceBlock>
        ) : (
          <EvidenceBlock className="evidence-log" aria-label="Tool output">
            {view.output || t("noOutput")}
          </EvidenceBlock>
        )}
        {view.kind === "file" && view.truncated && <p>{t("toolReadMore")}</p>}
        {view.recovery && (
          <p>
            {t("toolFullOutputReference")} <code>{view.recovery}</code>
          </p>
        )}
        {view.readRecovery && (
          <p className="evidence-warning">{view.readRecovery}</p>
        )}
        <details>
          <summary>{t("toolRawEvidence")}</summary>
          <p>
            <strong>{t("toolCallArguments")}</strong>
          </p>
          <pre>{view.rawArguments}</pre>
          <p>
            <strong>{t("toolCallOutput")}</strong>
          </p>
          <pre>{view.rawResult}</pre>
        </details>
      </div>
    </details>
  );
}
