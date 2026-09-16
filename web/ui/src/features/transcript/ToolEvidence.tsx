import type { ReactNode } from "react";
import type {
  WebLiveMessage,
  WebMessagePart,
} from "../../../../protocol/types.ts";
import {
  projectToolEvidence,
  type EvidenceState,
} from "../../../../protocol/evidence.ts";

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
  cwd,
}: {
  call: Extract<WebMessagePart, { type: "toolCall" }>;
  result?: WebLiveMessage;
  liveState?: EvidenceState;
  cwd?: string;
}) {
  const view = projectToolEvidence(call, result, liveState);
  const lines = (view.diff ?? view.output)
    .split("\n")
    .map((text, index) => ({ text, number: view.offset + index }));
  const failures =
    view.tests?.failures.map((text, index) => ({ text, number: index + 1 })) ??
    [];
  return (
    <details className={`tool-evidence-card evidence-${view.kind}`}>
      <summary>
        <strong>{call.name}</strong>
        <span>{view.path || view.command || view.kind}</span>
        <span className="evidence-status">{view.state}</span>
      </summary>
      <div className="evidence-content">
        {view.path && (
          <p>
            <strong>Requested file:</strong>{" "}
            <code>{view.resolvedPath ?? view.path}</code>
            {cwd && (
              <>
                <br />
                <small>Workspace: {cwd}</small>
              </>
            )}
          </p>
        )}
        {view.command && (
          <EvidenceBlock aria-label="Command">{view.command}</EvidenceBlock>
        )}
        {(view.kind === "terminal" || view.kind === "test") && (
          <p>
            Process: {view.processState} ·{" "}
            {view.exitCode !== undefined
              ? `exit ${view.exitCode}`
              : view.signal
                ? `signal ${view.signal}`
                : "exit code unavailable"}
          </p>
        )}
        {view.truncated && (
          <p className="evidence-warning">
            Partial evidence — byte, line or item limit reached. Raw evidence
            below may also be truncated.
          </p>
        )}
        {view.change && (
          <p>
            {view.change === "created"
              ? "File created"
              : view.change === "unchanged"
                ? "No content changes"
                : "File overwritten"}
          </p>
        )}
        {view.kind === "change" && !view.diff && !view.change && (
          <p>
            {view.evidenceUnavailable ??
              "The tool result does not include a change comparison."}
          </p>
        )}
        {view.tests && (
          <figure aria-label="Test evidence">
            <figcaption>
              <strong>Reported test results ({view.tests.format})</strong>
            </figcaption>
            <p>
              {view.tests.tests} tests · {view.tests.passed} passed ·{" "}
              {view.tests.failed} failed · {view.tests.cancelled} cancelled
            </p>
            <p>
              Reported counts are output evidence; execution status is shown
              separately.
            </p>
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
        {view.diff ? (
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
            {view.output || "No output received"}
          </EvidenceBlock>
        )}
        {view.kind === "file" && view.truncated && (
          <p>
            Read another range using the file path and offset. Consult the
            original result for the tool's recovery instructions.
          </p>
        )}
        {view.recovery && (
          <p>
            Full output reference: <code>{view.recovery}</code>
          </p>
        )}
        {view.readRecovery && (
          <p className="evidence-warning">{view.readRecovery}</p>
        )}
        <details>
          <summary>Raw arguments and result (sanitized)</summary>
          <p>
            <strong>Arguments</strong>
          </p>
          <pre>{view.rawArguments}</pre>
          <p>
            <strong>Result</strong>
          </p>
          <pre>{view.rawResult}</pre>
        </details>
      </div>
    </details>
  );
}
