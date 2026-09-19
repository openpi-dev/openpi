import { FileDiff, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { projectToolEvidence } from "../../../../protocol/evidence.ts";
import type { WebSessionProjection } from "../../../../protocol/types.ts";
import { ArtifactProvider } from "../artifacts/Artifacts.tsx";
import { ToolEvidence } from "../transcript/ToolEvidence.tsx";

export function changeCalls(session: WebSessionProjection) {
  const results = new Map<
    string,
    NonNullable<(typeof session.entries)[number]["message"]>[]
  >();
  for (const entry of session.entries) {
    const message = entry.message;
    if (message?.role !== "toolResult" || !message.toolCallId) continue;
    const matches = results.get(message.toolCallId) ?? [];
    matches.push(message);
    results.set(message.toolCallId, matches);
  }
  const calls = session.entries.flatMap((entry) =>
    entry.message?.role === "assistant"
      ? (entry.message.parts ?? []).flatMap((part, index) =>
          part.type === "toolCall" && ["write", "edit"].includes(part.name)
            ? [
                {
                  key: `${entry.id}:${index}`,
                  call: part,
                },
              ]
            : [],
        )
      : [],
  );
  const counts = new Map<string, number>();
  for (const { call } of calls)
    if (call.id) counts.set(call.id, (counts.get(call.id) ?? 0) + 1);
  return calls.map((row) => ({
    ...row,
    result:
      row.call.id &&
      !row.call.id.includes("[truncated]") &&
      counts.get(row.call.id) === 1 &&
      results.get(row.call.id)?.length === 1
        ? results.get(row.call.id)?.[0]
        : undefined,
  }));
}

export function changeLineCounts(
  call: ReturnType<typeof changeCalls>[number]["call"],
  result: ReturnType<typeof changeCalls>[number]["result"],
) {
  const diff = projectToolEvidence(call, result).diff;
  if (!diff) return undefined;
  let additions = 0;
  let deletions = 0;
  const lines = diff.split("\n");
  const hasHunks = lines.some((line) => line.startsWith("@@"));
  let inHunk = !hasHunks;
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      inHunk = false;
      continue;
    }
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("+")) additions++;
    else if (line.startsWith("-")) deletions++;
  }
  return additions || deletions ? { additions, deletions } : undefined;
}

export function ReviewPanel({
  session,
  onClose,
}: {
  session: WebSessionProjection;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const closeButton = useRef<HTMLButtonElement>(null);
  const [narrow, setNarrow] = useState(
    () => window.matchMedia?.("(max-width: 1100px)").matches ?? false,
  );
  useEffect(() => {
    const media = window.matchMedia?.("(max-width: 1100px)");
    if (!media) return;
    const update = () => setNarrow(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => closeButton.current?.focus(), []);
  const rows = changeCalls(session);
  const Surface = narrow ? "main" : "aside";
  const Heading = narrow ? "h1" : "h2";
  return (
    <ArtifactProvider sessionId={session.id}>
      <Surface
        className="review-panel"
        aria-label={t("changeEvidence")}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            onClose();
          }
        }}
      >
        <header className="review-heading">
          <div>
            <Heading>
              <FileDiff aria-hidden="true" /> {t("changeEvidence")}
            </Heading>
            <small>{t("changeEvidenceScope")}</small>
          </div>
          <button
            ref={closeButton}
            type="button"
            className="icon-button"
            aria-label={t("close")}
            onClick={onClose}
          >
            <X aria-hidden="true" />
          </button>
        </header>
        <div className="review-body">
          <p className="review-source" title={session.cwd}>
            {session.cwd}
          </p>
          {session.truncation.truncated && (
            <p className="inspection-warning">{t("changeEvidenceBounded")}</p>
          )}
          {rows.length === 0 ? (
            <p>{t("changeEvidenceEmpty")}</p>
          ) : (
            rows.map(({ key, call, result }, index) => {
              const counts = changeLineCounts(call, result);
              return (
                <section
                  key={key}
                  className="review-entry"
                  aria-label={t("changeEvidenceItem", { number: index + 1 })}
                >
                  <span className="review-order">{index + 1}</span>
                  <ToolEvidence
                    call={call}
                    result={result || undefined}
                    cwd={session.cwd}
                    summaryMeta={
                      counts ? (
                        <span className="evidence-summary-meta">
                          <span className="sr-only">
                            {t("changeEvidenceDelta", {
                              additions: counts.additions,
                              deletions: counts.deletions,
                            })}
                          </span>
                          <span className="review-additions" aria-hidden="true">
                            +{counts.additions}
                          </span>
                          <span className="review-deletions" aria-hidden="true">
                            -{counts.deletions}
                          </span>
                        </span>
                      ) : undefined
                    }
                  />
                </section>
              );
            })
          )}
        </div>
      </Surface>
    </ArtifactProvider>
  );
}
