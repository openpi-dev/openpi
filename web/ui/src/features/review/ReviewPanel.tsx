import { FileDiff, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { WebSessionProjection } from "../../../../protocol/types.ts";
import { ArtifactProvider } from "../artifacts/Artifacts.tsx";
import { ToolEvidence } from "../transcript/ToolEvidence.tsx";
import { changeCalls, changeLineCounts } from "./change-evidence.ts";

export { changeCalls, changeLineCounts } from "./change-evidence.ts";

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
