import { ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { WebGitReviewSnapshot } from "../../../../protocol/types.ts";

function fileName(path: string) {
  return path.split(/[\\/]/u).at(-1) || path;
}

export function SessionChangesPopover({
  snapshot,
  onOpenReview,
}: {
  snapshot: WebGitReviewSnapshot;
  onOpenReview: (returnFocus?: HTMLElement) => void;
}) {
  const { t } = useTranslation();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [popoverMaxHeight, setPopoverMaxHeight] = useState(320);

  useEffect(() => {
    if (!open) return;
    const fitAboveTrigger = () => {
      const top = trigger.current?.getBoundingClientRect().top ?? 340;
      setPopoverMaxHeight(Math.max(160, Math.min(420, top - 20)));
    };
    const dismiss = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      setOpen(false);
      trigger.current?.focus();
    };
    fitAboveTrigger();
    window.addEventListener("resize", fitAboveTrigger);
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", handleEscape);
    return () => {
      window.removeEventListener("resize", fitAboveTrigger);
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [open]);

  if (snapshot.files.length === 0) return null;
  const popoverId = `session-changes-${snapshot.revision.slice(0, 12)}`;
  return (
    <div className="session-changes" ref={root}>
      {open && (
        <section
          className="session-changes-popover"
          id={popoverId}
          role="dialog"
          aria-label={t("changeEvidence")}
          style={{ maxHeight: popoverMaxHeight }}
        >
          <ul>
            {snapshot.files.map((file) => (
              <li key={file.path}>
                <button
                  type="button"
                  className="session-changes-file"
                  title={file.path}
                  onClick={() => {
                    setOpen(false);
                    onOpenReview(trigger.current ?? undefined);
                  }}
                >
                  <span>{fileName(file.path)}</span>
                  {(file.additions > 0 || file.deletions > 0) && (
                    <span className="session-changes-counts" aria-hidden="true">
                      <span className="review-additions">
                        +{file.additions}
                      </span>
                      <span className="review-deletions">
                        -{file.deletions}
                      </span>
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <button
        ref={trigger}
        className="session-changes-trigger"
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        onClick={() => {
          if (!open) {
            const top = trigger.current?.getBoundingClientRect().top ?? 340;
            setPopoverMaxHeight(Math.max(160, Math.min(420, top - 20)));
          }
          setOpen((value) => !value);
        }}
      >
        <strong>{t("filesChanged", { count: snapshot.files.length })}</strong>
        <span className="session-changes-counts" aria-hidden="true">
          <span className="review-additions">+{snapshot.additions}</span>
          <span className="review-deletions">-{snapshot.deletions}</span>
        </span>
        <ChevronDown aria-hidden="true" />
      </button>
    </div>
  );
}
