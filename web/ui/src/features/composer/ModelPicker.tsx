import { ComplexSelector } from "@astryxdesign/core/ComplexSelector";
import { Check, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  WebModelSummary,
  WebSnapshot,
} from "../../../../protocol/types.ts";
import type {
  ModelSearchState,
  WebStoreActions,
} from "../../store/web-store.ts";
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
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const selected = props.draftModel ?? props.currentModel;
  const snapshotModels = props.snapshot?.models ?? [];
  const canSearch = (props.snapshot?.truncation.modelsOmitted ?? 0) > 0;
  const normalizedQuery = query.trim();
  const searchMatchesQuery = props.modelSearch.query === normalizedQuery;
  const searchPending =
    Boolean(normalizedQuery) &&
    (!searchMatchesQuery || props.modelSearch.status === "loading");
  const models = normalizedQuery
    ? searchMatchesQuery
      ? props.modelSearch.models
      : []
    : snapshotModels;
  const searchModels = props.actions.searchModels;

  useEffect(() => {
    if (!normalizedQuery) return;
    const timer = window.setTimeout(() => {
      void searchModels(normalizedQuery);
    }, MODEL_SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [normalizedQuery, searchModels]);

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
      props.snapshot?.selectedSession?.id !==
        props.snapshot?.currentSessionId) ||
    props.liveRunning ||
    (!snapshotModels.length && !canSearch);

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
          {canSearch && (
            <label className="model-search-input">
              <Search aria-hidden="true" />
              <span className="sr-only">{t("searchModels")}</span>
              <input
                value={query}
                placeholder={t("searchModelsPlaceholder")}
                onChange={(event) => {
                  const next = event.currentTarget.value;
                  setQuery(next);
                  if (!next.trim()) props.actions.clearModelSearch();
                }}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    close();
                  }
                }}
              />
            </label>
          )}
          {searchPending && (
            <p className="model-search-status" role="status">
              {t("searchingModels")}
            </p>
          )}
          {normalizedQuery &&
            searchMatchesQuery &&
            props.modelSearch.status === "error" && (
              <p
                className="model-search-status model-search-error"
                role="alert"
              >
                {props.modelSearch.error ?? t("modelSearchFailed")}
              </p>
            )}
          {normalizedQuery &&
            searchMatchesQuery &&
            props.modelSearch.status === "ready" &&
            props.modelSearch.totalMatches === 0 && (
              <p className="model-search-status" role="status">
                {t("noMatchingModels")}
              </p>
            )}
          {normalizedQuery &&
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
