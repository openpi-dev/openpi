import { ComplexSelector } from "@astryxdesign/core/ComplexSelector";
import { Check, Search } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { WebGitReviewBranches } from "../../../../protocol/types.ts";

export function ReviewBasePicker({
  branches,
  value,
  loading,
  onChange,
}: {
  branches: WebGitReviewBranches;
  value?: string;
  loading: boolean;
  onChange: (ref: string) => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const outsideFocus = useRef<HTMLElement | null>(null);
  const listId = useId();
  const matches = branches.options.filter((option) =>
    `${option.label} ${option.ref}`
      .toLocaleLowerCase()
      .includes(query.toLocaleLowerCase()),
  );
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => input.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      const target = event.target;
      outsideFocus.current =
        target instanceof Element &&
        !target.closest(".review-base-picker, .review-base-popup")
          ? target.closest<HTMLElement>(
              "button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex], [contenteditable='true']",
            )
          : null;
    };
    document.addEventListener("pointerdown", onPointer, true);
    return () => document.removeEventListener("pointerdown", onPointer, true);
  }, [open]);
  const label =
    branches.options.find((option) => option.ref === value)?.label ?? value;
  return (
    <ComplexSelector
      className="review-base-picker"
      label={t("gitReviewBaseBranch")}
      isLabelHidden
      value={value ?? ""}
      triggerLabel={
        <span className="review-base-label" title={value}>
          {label || t("gitReviewChooseBase")}
        </span>
      }
      variant="ghost"
      size="sm"
      isDisabled={branches.options.length === 0}
      isLoading={loading}
      onOpenChange={(next: boolean) => {
        setOpen(next);
        if (!next) {
          setQuery("");
          if (outsideFocus.current?.isConnected)
            outsideFocus.current.focus({ preventScroll: true });
          outsideFocus.current = null;
        }
      }}
    >
      {(
        _value: string,
        _onChange: (value: string) => void,
        close: () => void,
      ) => (
        <div className="review-base-popup">
          <label className="review-base-search">
            <Search aria-hidden="true" />
            <span className="sr-only">{t("gitReviewSearchBranches")}</span>
            <input
              ref={input}
              type="search"
              value={query}
              aria-controls={listId}
              placeholder={t("gitReviewSearchBranches")}
              onChange={(event) => setQuery(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing || event.keyCode === 229)
                  return;
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  close();
                } else if (
                  event.key === "ArrowDown" &&
                  matches.length &&
                  !loading
                ) {
                  event.preventDefault();
                  optionRefs.current[0]?.focus();
                }
              }}
            />
          </label>
          {branches.truncated && (
            <p role="status">{t("gitReviewBranchesTruncated")}</p>
          )}
          <div
            id={listId}
            role="listbox"
            aria-label={t("gitReviewBaseBranch")}
            className="review-base-options"
          >
            {matches.map((option, index) => (
              <button
                key={option.ref}
                type="button"
                disabled={loading}
                role="option"
                aria-selected={value === option.ref}
                title={option.ref}
                ref={(element) => {
                  optionRefs.current[index] = element;
                }}
                onClick={() => {
                  onChange(option.ref);
                  close();
                }}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing || event.keyCode === 229)
                    return;
                  if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    close();
                  } else if (
                    event.key === "ArrowDown" ||
                    event.key === "ArrowUp" ||
                    event.key === "Home" ||
                    event.key === "End"
                  ) {
                    event.preventDefault();
                    const next =
                      event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? matches.length - 1
                          : (index +
                              (event.key === "ArrowDown"
                                ? 1
                                : matches.length - 1)) %
                            matches.length;
                    optionRefs.current[next]?.focus();
                  }
                }}
              >
                <span>
                  {option.label}
                  <small>
                    {option.ref.startsWith("refs/heads/")
                      ? t("gitReviewLocalBranch")
                      : t("gitReviewRemoteBranch")}
                  </small>
                </span>
                {value === option.ref && <Check aria-hidden="true" />}
              </button>
            ))}
            {!matches.length && (
              <p role="status">{t("gitReviewNoMatchingBranches")}</p>
            )}
          </div>
        </div>
      )}
    </ComplexSelector>
  );
}
