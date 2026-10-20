import { Check, ChevronRight, Clipboard, Terminal } from "lucide-react";
import { type ReactNode, useContext, useState } from "react";
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
import { copyText } from "../../lib/clipboard.ts";
import { ArtifactContext } from "../artifacts/context.ts";
import { parseDiffRows } from "../review/DiffCodePreview.tsx";
import {
  toolActivity,
  toolActivityLabel,
  toolActivityTarget,
} from "./tool-activity.ts";

// Pi edit returns numbered lines; confirmed write receipts use unified patches.
// Decode only result evidence, never the requested old/new text in tool arguments.
function toolDiffRows(diff: string) {
  if (/^@@ |^--- .*\n\+\+\+ /mu.test(diff)) return parseDiffRows(diff);
  return diff.split("\n").map((line, id) => {
    const numbered = /^([ +-])\s*(\d+) (.*)$/u.exec(line);
    const marker = numbered?.[1] ?? line[0] ?? "";
    const kind =
      marker === "+" ? "added" : marker === "-" ? "removed" : "context";
    const number = numbered ? Number(numbered[2]) : undefined;
    const validNumber =
      number && Number.isSafeInteger(number) ? number : undefined;
    return {
      id,
      kind,
      oldLine: kind === "removed" ? validNumber : undefined,
      newLine: kind !== "removed" ? validNumber : undefined,
      marker: kind === "context" ? " " : marker,
      code: numbered?.[3] ?? (kind === "context" ? line : line.slice(1)),
    };
  });
}

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
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: File and log evidence need keyboard scrolling without changing their formatting. */}
      <pre className={className} tabIndex={0}>
        {children}
      </pre>
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
  children,
}: {
  call: Extract<WebMessagePart, { type: "toolCall" }>;
  result?: WebLiveMessage;
  liveState?: EvidenceState;
  observed?: boolean;
  cwd?: string;
  defaultOpen?: boolean;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState<{
    source: string;
    status: "copiedCode" | "copyCodeFailed";
  } | null>(null);
  const artifacts = useContext(ArtifactContext);
  const view = projectToolEvidence(call, result, liveState);
  const state = !observed && view.state === "running" ? "unknown" : view.state;
  const statusLabel = result?.forkSnapshotToolResult
    ? t("toolSnapshotMissingResult")
    : t(`toolState_${state}`);
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
  const diffCopySource = `${call.id}:diff:${view.diff}`;
  const diffCopyFeedback =
    copied?.source === diffCopySource ? copied.status : null;
  const lines = view.output
    .split("\n")
    .map((text, index) => ({ text, number: view.offset + index }));
  const diffRows = view.diff ? toolDiffRows(view.diff) : [];
  // These are counts in the displayed result, never guesses from edit arguments.
  const additions = diffRows.filter((line) => line.kind === "added").length;
  const deletions = diffRows.filter((line) => line.kind === "removed").length;
  const stats =
    view.diff || view.change === "created" ? (
      <span className="evidence-summary-meta" title={t("toolDiffStatsHelp")}>
        <span className="review-additions">+{additions.toLocaleString()}</span>
        <span className="review-deletions">−{deletions.toLocaleString()}</span>
        {view.truncated && <span>{t("gitReviewPartialLabel")}</span>}
      </span>
    ) : null;
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
        <span className="evidence-target" title={view.path || target}>
          <span className="tool-action">
            {state === "returned" && view.change === "created"
              ? t("toolFileChange_created")
              : toolActivityLabel(t, call.name, state)}
          </span>
          {path ? (
            <span className="evidence-filename">{filename}</span>
          ) : target ? (
            <span className="evidence-command">{target}</span>
          ) : null}
        </span>
        {stats}
        <ChevronRight className="evidence-chevron" aria-hidden="true" />
        <span className="evidence-status">{statusLabel}</span>
      </summary>
      <div className="evidence-content">
        {view.path && !view.diff && (
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
              <span className="evidence-shell-label">
                <Terminal aria-hidden="true" />
                {call.name === "bash" ? "Bash" : "Shell"}
              </span>
              <span className="evidence-process-meta">
                {statusLabel}
                {view.exitCode !== undefined
                  ? ` · exit ${view.exitCode}`
                  : view.signal
                    ? ` · ${view.signal}`
                    : ""}
              </span>
              <button
                type="button"
                data-copied={copyFeedback === "copiedCode" || undefined}
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
            {view.command && (
              <pre className="evidence-shell-command">$ {view.command}</pre>
            )}
            {(view.output || !view.command) && (
              // biome-ignore lint/a11y/noNoninteractiveTabindex: Terminal output must support keyboard scrolling without changing its formatting.
              <pre className="evidence-shell-output" tabIndex={0}>
                {view.output || t("noOutput")}
              </pre>
            )}
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
        {view.change && !view.diff && (
          <p>{t(`toolFileChange_${view.change}`)}</p>
        )}
        {view.kind === "change" && !view.diff && !view.change && (
          <p>{view.evidenceUnavailable ?? t("toolChangeUnavailable")}</p>
        )}
        {view.tests && (
          <figure className="evidence-test-summary" aria-label="Test evidence">
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
          <figure className="evidence-diff" aria-label="Change diff">
            <figcaption>
              {artifacts && fileReference ? (
                <button
                  className="evidence-diff-file"
                  type="button"
                  title={fileReference}
                  aria-label={fileReference}
                  onClick={() => artifacts.open(fileReference)}
                >
                  {filename}
                </button>
              ) : (
                <span className="evidence-diff-file" title={fileReference}>
                  {filename}
                </span>
              )}
              {stats}
              <button
                className="evidence-copy"
                type="button"
                data-copied={diffCopyFeedback === "copiedCode" || undefined}
                aria-label={t(
                  diffCopyFeedback === "copiedCode" ? "copiedCode" : "copyCode",
                )}
                title={t(
                  diffCopyFeedback === "copiedCode" ? "copiedCode" : "copyCode",
                )}
                onClick={async () => {
                  const ok = await copyText(view.diff ?? "");
                  setCopied({
                    source: diffCopySource,
                    status: ok ? "copiedCode" : "copyCodeFailed",
                  });
                }}
              >
                {diffCopyFeedback === "copiedCode" ? <Check /> : <Clipboard />}
              </button>
            </figcaption>
            <pre className="evidence-diff-lines">
              {diffRows.map((line) => (
                <span
                  className={`evidence-diff-row diff-${line.kind}`}
                  key={line.id}
                >
                  <span className="evidence-line-number" aria-hidden="true">
                    {line.newLine ?? line.oldLine ?? ""}
                  </span>
                  <span className="evidence-diff-marker">{line.marker}</span>
                  <span>{line.code}</span>
                  {"\n"}
                </span>
              ))}
            </pre>
            {diffCopyFeedback === "copyCodeFailed" && (
              <p role="status" className="evidence-warning">
                {t(diffCopyFeedback)}
              </p>
            )}
          </figure>
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
            <code>{call.name}</code>
          </p>
          <p>
            <strong>{t("toolCallArguments")}</strong>
          </p>
          <pre>{view.rawArguments}</pre>
          <p>
            <strong>{t("toolCallOutput")}</strong>
          </p>
          <pre>{view.rawResult}</pre>
        </details>
        {children}
      </div>
    </details>
  );
}
