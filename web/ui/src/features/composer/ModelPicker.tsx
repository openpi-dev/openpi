import {
  ComplexSelector,
  type ComplexSelectorHandle,
} from "@astryxdesign/core/ComplexSelector";
import { ArrowLeft, Check, RotateCcw, Search, Settings2 } from "lucide-react";
import { Fragment, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  WebModelSummary,
  WebSnapshot,
} from "../../../../protocol/types.ts";
import { isControlledSession } from "../../lib/session-control.ts";
import type {
  ModelSearchState,
  WebStoreActions,
} from "../../store/web-store.ts";
import { modelIdentity } from "./model-identity.ts";
import { ThinkingPicker } from "./ThinkingPicker.tsx";
import { ProviderIcon } from "../settings/ProviderIcon.tsx";

interface ModelPickerProps {
  openRequest?: number;
  snapshot: WebSnapshot | null;
  currentModel?: WebModelSummary;
  draftModel?: WebModelSummary | null;
  modelSearch: ModelSearchState;
  modelSelectionPending: boolean;
  promptAdmissionPending: boolean;
  sessionSwitching: boolean;
  liveRunning: boolean;
  workspaceDraft: boolean;
  thinkingPendingLevel?: string | null;
  thinkingNeedsSession?: boolean;
  thinkingDisabledReason?: string | null;
  onOpenProviders?: () => void;
  actions: WebStoreActions;
}

const MODEL_SEARCH_DEBOUNCE_MS = 250;

export function ModelPicker(props: ModelPickerProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [view, setView] = useState<"models" | "thinking" | null>(null);
  const [open, setOpen] = useState(false);
  const preparationStarted = useRef(false);
  const outsideFocus = useRef<HTMLElement | null>(null);
  const selector = useRef<ComplexSelectorHandle>(null);
  const input = useRef<HTMLInputElement>(null);
  const optionsId = useId();
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const selected = props.draftModel ?? props.currentModel;
  const thinking =
    props.thinkingDisabledReason === "thinkingInactiveHint"
      ? undefined
      : props.snapshot?.thinking;
  const supportsThinking = thinking?.supported === true;
  const level = props.thinkingPendingLevel ?? thinking?.level ?? "off";
  const thinkingView =
    (view ?? (supportsThinking ? "thinking" : "models")) === "thinking";
  const snapshotModels = props.snapshot?.models ?? [];
  const canSearch = (props.snapshot?.truncation.modelsOmitted ?? 0) > 0;
  const hasCatalog = snapshotModels.length > 0 || canSearch;
  const normalizedQuery = query.trim();
  const searchMatchesQuery = props.modelSearch.query === normalizedQuery;
  const searchPending =
    canSearch &&
    Boolean(normalizedQuery) &&
    (!searchMatchesQuery || props.modelSearch.status === "loading");
  const matchingModels = normalizedQuery
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
  const groups = new Map<string, WebModelSummary[]>();
  for (const model of matchingModels) {
    const group = groups.get(model.provider);
    if (group) group.push(model);
    else groups.set(model.provider, [model]);
  }
  const models = [...groups.values()].flat();
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

  const triggerLabel = selected
    ? modelIdentity(selected)
    : t(
        !props.snapshot
          ? "loadingModels"
          : hasCatalog
            ? "selectModel"
            : "configureModels",
      );
  const disabled =
    !props.snapshot ||
    props.sessionSwitching ||
    props.modelSelectionPending ||
    props.promptAdmissionPending ||
    (!props.workspaceDraft &&
      Boolean(props.snapshot?.selectedSession) &&
      !isControlledSession(props.snapshot)) ||
    props.liveRunning;

  useEffect(() => {
    if (!open) {
      preparationStarted.current = false;
      return;
    }
    if (
      props.thinkingNeedsSession &&
      (selected || thinkingView) &&
      !preparationStarted.current
    ) {
      preparationStarted.current = true;
      void props.actions.prepareSession();
    }
  }, [open, thinkingView, selected, props.thinkingNeedsSession, props.actions]);
  useEffect(() => {
    if (!open || thinkingView) return;
    const frame = requestAnimationFrame(() => input.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open, thinkingView]);
  useEffect(() => {
    if (!open) return;
    const rememberOutsideClick = (event: PointerEvent) => {
      const target = event.target;
      outsideFocus.current =
        target instanceof Element &&
        !target.closest(".astryx-complex-selector-popup, .model-picker")
          ? target.closest<HTMLElement>(
              "button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex], [contenteditable='true']",
            )
          : null;
    };
    document.addEventListener("pointerdown", rememberOutsideClick, true);
    return () =>
      document.removeEventListener("pointerdown", rememberOutsideClick, true);
  }, [open]);
  const owner = JSON.stringify([
    props.snapshot?.currentSessionId,
    props.snapshot?.currentSessionPath,
    selected?.provider,
    selected?.id,
  ]);
  const previousOwner = useRef(owner);
  useEffect(() => {
    if (
      thinkingView &&
      previousOwner.current !== owner &&
      !preparationStarted.current
    )
      selector.current?.close();
    previousOwner.current = owner;
    if (!props.thinkingNeedsSession) preparationStarted.current = false;
  }, [owner, thinkingView, props.thinkingNeedsSession]);

  useEffect(() => {
    if (disabled && !preparationStarted.current) selector.current?.close();
  }, [disabled]);
  const consumedOpenRequest = useRef(props.openRequest);
  useEffect(() => {
    if (props.openRequest === consumedOpenRequest.current) return;
    consumedOpenRequest.current = props.openRequest;
    if (props.openRequest && !disabled) {
      setView("models");
      selector.current?.open();
    }
  }, [props.openRequest, disabled]);

  return (
    <ComplexSelector
      className="model-selector model-picker"
      label={
        supportsThinking
          ? `${triggerLabel}, ${t("thinkingLevel")}: ${level}`
          : triggerLabel
      }
      isLabelHidden
      value={selected ? `${selected.provider}/${selected.id}` : ""}
      triggerLabel={
        <span className="model-thinking-label" title={triggerLabel}>
          {selected && <ProviderIcon id={selected.provider} />}
          <span className="model-picker-label">
            {selected?.name || selected?.id || triggerLabel}
          </span>
          {supportsThinking && (
            <span className="model-picker-thinking">
              {level[0]!.toUpperCase() + level.slice(1)}
            </span>
          )}
        </span>
      }
      variant="ghost"
      size="sm"
      placement="above"
      alignment="end"
      isDisabled={disabled}
      isLoading={props.modelSelectionPending}
      handleRef={selector}
      onOpenChange={(open: boolean) => {
        setOpen(open);
        if (!open) {
          // ComplexSelector restores its trigger first; preserve an explicit
          // outside click so the user can immediately continue composing.
          if (outsideFocus.current?.isConnected)
            outsideFocus.current.focus({ preventScroll: true });
          outsideFocus.current = null;
          resetSearch();
          setView(null);
        }
      }}
    >
      {(
        _value: string,
        _onChange: (value: string) => void,
        close: () => void,
      ) =>
        open && props.thinkingNeedsSession && (selected || thinkingView) ? (
          <p className="thinking-preparing" role="status">
            {t("switchingSession")}
          </p>
        ) : open && thinkingView ? (
          <ThinkingPicker
            key={owner}
            snapshot={props.snapshot}
            model={selected}
            pending={props.thinkingPendingLevel ?? null}
            disabled={disabled || !!props.thinkingDisabledReason}
            actions={props.actions}
            onClose={close}
            onChooseModel={() => setView("models")}
          />
        ) : (
          <div
            className={`model-search-panel ${canSearch ? "searchable" : ""}`}
          >
            {supportsThinking && (
              <button
                type="button"
                className="model-thinking-back"
                onClick={() => setView("thinking")}
              >
                <ArrowLeft aria-hidden="true" />
                {t("thinkingLevel")}
              </button>
            )}
            {canSearch && (
              <p className="model-search-truncation" role="status">
                {t("modelsTruncated", {
                  shown: snapshotModels.length,
                  omitted: props.snapshot?.truncation.modelsOmitted ?? 0,
                })}
              </p>
            )}
            {props.snapshot && !hasCatalog && (
              <p className="model-search-status" role="status">
                {t("noModels")}
              </p>
            )}
            {hasCatalog && (
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
            )}
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
            {hasCatalog &&
              normalizedQuery &&
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
            {hasCatalog && (
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
                    <Fragment key={`${model.provider}/${model.id}`}>
                      {(index === 0 ||
                        models[index - 1]?.provider !== model.provider) && (
                        <div
                          className="model-provider-heading"
                          aria-hidden="true"
                        >
                          {model.provider}
                        </div>
                      )}
                      <button
                        className="model-search-option"
                        type="button"
                        disabled={props.thinkingPendingLevel != null}
                        role="option"
                        aria-selected={isSelected}
                        aria-label={modelIdentity(model)}
                        title={modelIdentity(model)}
                        ref={(element) => {
                          optionRefs.current[index] = element;
                        }}
                        onClick={() => select(model, close)}
                        onKeyDownCapture={(event) => {
                          if (
                            event.nativeEvent.isComposing ||
                            event.keyCode === 229
                          )
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
                        <ProviderIcon id={model.provider} />
                        <span className="model-menu-item-text">
                          <span className="model-menu-item-label">
                            {model.name || model.id}
                          </span>
                          {model.name && model.name !== model.id && (
                            <span className="model-menu-item-sub">
                              {model.id}
                            </span>
                          )}
                        </span>
                        {isSelected && <Check aria-hidden="true" />}
                      </button>
                    </Fragment>
                  );
                })}
              </div>
            )}
            {props.onOpenProviders && (
              <>
                {selected && thinking && !supportsThinking && (
                  <p className="model-search-status">
                    {t("modelThinkingNotEnabled")}
                  </p>
                )}
                <button
                  className="model-settings-command"
                  type="button"
                  onClick={() => {
                    close();
                    props.onOpenProviders?.();
                  }}
                >
                  <Settings2 aria-hidden="true" />
                  <span>{t("openModelSettings")}</span>
                </button>
              </>
            )}
          </div>
        )
      }
    </ComplexSelector>
  );
}
