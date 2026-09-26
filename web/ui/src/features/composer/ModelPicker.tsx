import {
  ComplexSelector,
  type ComplexSelectorHandle,
} from "@astryxdesign/core/ComplexSelector";
import { Check, RotateCcw, Search } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  WebModelSummary,
  WebSnapshot,
} from "../../../../protocol/types.ts";
import type {
  ModelSearchState,
  WebStoreActions,
} from "../../store/web-store.ts";
import { isControlledSession } from "../../lib/session-control.ts";
import { modelIdentity } from "./model-identity.ts";

interface ModelPickerProps {
  snapshot: WebSnapshot | null;
  currentModel?: WebModelSummary;
  draftModel?: WebModelSummary | null;
  modelSearch: ModelSearchState;
  modelSelectionPending: boolean;
  promptAdmissionPending: boolean;
  sessionSwitching: boolean;
  liveRunning: boolean;
  workspaceDraft: boolean;
  actions: WebStoreActions;
}

const MODEL_SEARCH_DEBOUNCE_MS = 250;

export function ModelPicker(props: ModelPickerProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const selector = useRef<ComplexSelectorHandle>(null);
  const input = useRef<HTMLInputElement>(null);
  const optionsId = useId();
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const selected = props.draftModel ?? props.currentModel;
  const snapshotModels = props.snapshot?.models ?? [];
  const canSearch = (props.snapshot?.truncation.modelsOmitted ?? 0) > 0;
  const normalizedQuery = query.trim();
  const searchMatchesQuery = props.modelSearch.query === normalizedQuery;
  const searchPending =
    canSearch &&
    Boolean(normalizedQuery) &&
    (!searchMatchesQuery || props.modelSearch.status === "loading");
  const models = normalizedQuery
    ? canSearch
      ? searchMatchesQuery
        ? props.modelSearch.models
        : []
      : snapshotModels.filter((model) =>
          [model.provider, model.id, model.name, model.label].some((value) =>
            value
              .toLocaleLowerCase()
              .includes(normalizedQuery.toLocaleLowerCase()),
          ),
        )
    : snapshotModels;
  const searchModels = props.actions.searchModels;
  const searchQuery = props.modelSearch.query;
  const searchStatus = props.modelSearch.status;

  useEffect(() => {
    if (
      !canSearch ||
      !normalizedQuery ||
      (searchQuery === normalizedQuery && searchStatus !== "idle")
    )
      return;
    const timer = window.setTimeout(() => {
      void searchModels(normalizedQuery);
    }, MODEL_SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [canSearch, normalizedQuery, searchModels, searchQuery, searchStatus]);

  const resetSearch = () => {
    setQuery("");
    props.actions.clearModelSearch();
  };

  const select = (model: WebModelSummary, close: () => void) => {
    void props.actions.selectModel(`${model.provider}/${model.id}`);
    close();
  };

  const triggerLabel = selected ? modelIdentity(selected) : t("noModels");
  const accessibleLabel = selected ? triggerLabel : t("selectModel");
  const disabled =
    props.sessionSwitching ||
    props.modelSelectionPending ||
    props.promptAdmissionPending ||
    (!props.workspaceDraft &&
      Boolean(props.snapshot?.selectedSession) &&
      !isControlledSession(props.snapshot)) ||
    props.liveRunning ||
    (!snapshotModels.length && !canSearch);

  useEffect(() => {
    if (disabled) selector.current?.close();
  }, [disabled]);

  return (
    <ComplexSelector
      className="model-selector model-picker"
      label={accessibleLabel}
      isLabelHidden
      value={selected ? `${selected.provider}/${selected.id}` : ""}
      triggerLabel={<span className="model-picker-label">{triggerLabel}</span>}
      placeholder={t("noModels")}
      variant="ghost"
      size="sm"
      placement="above"
      alignment="end"
      isDisabled={disabled}
      isLoading={props.modelSelectionPending}
      handleRef={selector}
      onOpenChange={(open: boolean) => {
        if (!open) resetSearch();
      }}
    >
      {(
        _value: string,
        _onChange: (value: string) => void,
        close: () => void,
      ) => (
        <div className={`model-search-panel ${canSearch ? "searchable" : ""}`}>
          {canSearch && (
            <p className="model-search-truncation" role="status">
              {t("modelsTruncated", {
                shown: snapshotModels.length,
                omitted: props.snapshot?.truncation.modelsOmitted ?? 0,
              })}
            </p>
          )}
          <label className="model-search-input">
            <Search aria-hidden="true" />
            <span className="sr-only">{t("searchModels")}</span>
            <input
              ref={input}
              aria-controls={optionsId}
              value={query}
              placeholder={t("searchModelsPlaceholder")}
              onChange={(event) => {
                const next = event.currentTarget.value;
                setQuery(next);
                if (!next.trim()) props.actions.clearModelSearch();
              }}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing || event.keyCode === 229)
                  return;
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  close();
                } else if (event.key === "ArrowDown" && models.length) {
                  event.preventDefault();
                  event.stopPropagation();
                  optionRefs.current[0]?.focus();
                }
              }}
            />
          </label>
          {searchPending && (
            <p className="model-search-status" role="status">
              {t("searchingModels")}
            </p>
          )}
          {canSearch &&
            normalizedQuery &&
            searchMatchesQuery &&
            props.modelSearch.status === "error" && (
              <p
                className="model-search-status model-search-error"
                role="alert"
              >
                {props.modelSearch.error ?? t("modelSearchFailed")}
                <button
                  type="button"
                  className="model-search-retry"
                  aria-label={t("retryModelSearch")}
                  title={t("retryModelSearch")}
                  onClick={() => void searchModels(normalizedQuery)}
                >
                  <RotateCcw aria-hidden="true" />
                </button>
              </p>
            )}
          {normalizedQuery &&
            (!canSearch ||
              (searchMatchesQuery && props.modelSearch.status === "ready")) &&
            models.length === 0 && (
              <p className="model-search-status" role="status">
                {t("noMatchingModels")}
              </p>
            )}
          {canSearch &&
            normalizedQuery &&
            searchMatchesQuery &&
            props.modelSearch.status === "ready" &&
            props.modelSearch.matchesOmitted > 0 && (
              <p className="model-search-status" role="status">
                {t("modelSearchTruncated", {
                  omitted: props.modelSearch.matchesOmitted,
                })}
              </p>
            )}
          <div
            className="model-search-options"
            id={optionsId}
            role="listbox"
            aria-label={t("selectModel")}
            aria-busy={searchPending}
          >
            {models.map((model, index) => {
              const isSelected =
                selected?.provider === model.provider &&
                selected.id === model.id;
              return (
                <button
                  className="model-search-option"
                  key={`${model.provider}/${model.id}`}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  ref={(element) => {
                    optionRefs.current[index] = element;
                  }}
                  onClick={() => select(model, close)}
                  onKeyDownCapture={(event) => {
                    if (event.nativeEvent.isComposing || event.keyCode === 229)
                      return;
                    if (event.key === "Escape") {
                      event.preventDefault();
                      event.stopPropagation();
                      close();
                      return;
                    }
                    if (event.key === "ArrowUp" && index === 0) {
                      event.preventDefault();
                      event.stopPropagation();
                      input.current?.focus();
                      return;
                    }
                    const moveTo =
                      event.key === "ArrowDown"
                        ? Math.min(index + 1, models.length - 1)
                        : event.key === "ArrowUp"
                          ? Math.max(index - 1, 0)
                          : event.key === "Home"
                            ? 0
                            : event.key === "End"
                              ? models.length - 1
                              : null;
                    if (moveTo === null || moveTo === index) return;
                    event.preventDefault();
                    event.stopPropagation();
                    optionRefs.current[moveTo]?.focus();
                  }}
                >
                  <span className="model-menu-item-label">
                    {modelIdentity(model)}
                  </span>
                  {isSelected && <Check aria-hidden="true" />}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </ComplexSelector>
  );
}
