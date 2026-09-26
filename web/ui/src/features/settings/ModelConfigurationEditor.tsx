import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  WebModelConfiguration,
  WebModelConfigurations,
} from "../../../../runtime/types.ts";
import { WebApiError, WebClient } from "../../protocol/client.ts";

const emptyModel: WebModelConfiguration = {
  provider: "",
  id: "",
  name: "",
  baseUrl: "",
  api: "openai-responses",
  reasoning: true,
  contextWindow: 128000,
  maxTokens: 16384,
};

const modelFields = [
  "provider",
  "id",
  "name",
  "baseUrl",
  "api",
  "reasoning",
  "contextWindow",
  "maxTokens",
] as const;

function sameModel(left: WebModelConfiguration, right: WebModelConfiguration) {
  return modelFields.every((field) => left[field] === right[field]);
}

export function ModelConfigurationEditor({
  sessionId,
  selectedKey,
  selectedModel,
  onSelect,
  onModelsLoaded,
  busy,
  onSaved,
  onDraftChange,
  onSavingChange,
}: {
  sessionId: string;
  selectedKey?: string;
  selectedModel?: { provider: string; id: string; name: string };
  onSelect?: (key: string, provider?: string) => void;
  onModelsLoaded?: (models: WebModelConfiguration[]) => void;
  busy: boolean;
  onSaved: () => Promise<boolean>;
  onDraftChange?: (dirty: boolean) => void;
  onSavingChange?: (saving: boolean) => void;
}) {
  const { t } = useTranslation();
  const client = useMemo(() => new WebClient(), []);
  const [configuration, setConfiguration] =
    useState<WebModelConfigurations | null>(null);
  const [model, setModel] = useState(emptyModel);
  const [localSelection, setLocalSelection] = useState("");
  const selected = selectedKey ?? localSelection;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const onModelsLoadedRef = useRef(onModelsLoaded);
  onModelsLoadedRef.current = onModelsLoaded;
  const drafts = useRef(new Map<string, WebModelConfiguration>());
  const baselines = useRef(
    new Map<string, { model: WebModelConfiguration; configured: boolean }>(),
  );
  const [conflictedDrafts, setConflictedDrafts] = useState(new Set<string>());
  const [dirty, setDirty] = useState(false);
  const [load, reload] = useState<{
    selection?: string;
    source?: string;
    saved?: boolean;
    clearMissing?: boolean;
    discard?: string;
  }>({});
  const [loading, setLoading] = useState(true);
  const [discardSelection, setDiscardSelection] = useState<string | null>(null);
  const saveOperation = useRef<AbortController | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [saveError, setSaveError] = useState<{
    selection: string;
    reason: "failed" | "conflict";
  } | null>(null);
  const currentSaveError = conflictedDrafts.has(selected)
    ? "conflict"
    : saveError?.selection === selected
      ? saveError.reason
      : null;
  const provider = selectedModel?.provider;
  const id = selectedModel?.id;
  const name = selectedModel?.name;
  useEffect(() => {
    if (!configuration) return;
    const configuredModel = configuration.models.find(
      (item) => `${item.provider}/${item.id}` === selected,
    );
    const baseline =
      configuredModel ??
      (provider && id
        ? { ...emptyModel, provider, id, name: name || id }
        : emptyModel);
    if (!drafts.current.has(selected))
      baselines.current.set(selected, {
        model: baseline,
        configured: Boolean(configuredModel),
      });
    setModel(drafts.current.get(selected) ?? baseline);
    setDiscardSelection((current) => (current === selected ? current : null));
  }, [configuration, selected, provider, id, name]);
  useEffect(() => onDraftChange?.(dirty), [dirty, onDraftChange]);
  useEffect(() => onSavingChange?.(saving), [saving, onSavingChange]);
  useEffect(() => () => saveOperation.current?.abort(), []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError(false);
    setSaved(false);
    void client.modelConfigurations(sessionId, controller.signal).then(
      (value) => {
        if (controller.signal.aborted) return;
        setConflictedDrafts((current) => {
          const next = new Set(current);
          for (const [key, draft] of drafts.current) {
            if (key === load.discard) continue;
            const baseline = baselines.current.get(key);
            const latest = value.models.find(
              (item) =>
                `${item.provider}/${item.id}` ===
                (key || `${draft.provider}/${draft.id}`),
            );
            if (
              baseline &&
              (latest
                ? !sameModel(baseline.model, latest)
                : baseline.configured)
            )
              next.add(key);
          }
          if (load.discard !== undefined) next.delete(load.discard);
          return next;
        });
        if (load.discard !== undefined) {
          drafts.current.delete(load.discard);
          baselines.current.delete(load.discard);
          setDirty(drafts.current.size > 0);
          if (selectedRef.current === load.source) setSaveError(null);
        }
        setConfiguration(value);
        onModelsLoadedRef.current?.(value.models);
        if (
          load.selection !== undefined &&
          selectedRef.current === load.source
        ) {
          const latest = value.models.find(
            (item) => `${item.provider}/${item.id}` === load.selection,
          );
          if (load.discard !== undefined) setModel(latest ?? emptyModel);
          if (latest) {
            setLocalSelection(load.selection);
            onSelectRef.current?.(load.selection, latest.provider);
          } else if (load.clearMissing) {
            setLocalSelection("");
            onSelectRef.current?.("");
          }
          setSaved(Boolean(latest && load.saved));
        }
        setLoading(false);
      },
      () => {
        if (!controller.signal.aborted) {
          setLoadError(true);
          setLoading(false);
        }
      },
    );
    return () => controller.abort();
  }, [client, sessionId, load]);

  const editModel = (patch: Partial<WebModelConfiguration>) => {
    const updated = { ...model, ...patch };
    setModel(updated);
    if (
      sameModel(updated, baselines.current.get(selected)?.model ?? emptyModel)
    )
      drafts.current.delete(selected);
    else drafts.current.set(selected, updated);
    setDirty(drafts.current.size > 0);
    setSaved(false);
    if (currentSaveError === "failed") setSaveError(null);
  };

  return (
    <section className="settings-section-block">
      <h2>{t("editModelConfiguration")}</h2>
      <p>{t("modelConfigurationDetail")}</p>
      <form
        className="settings-edit-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (
            saving ||
            busy ||
            loading ||
            !configuration ||
            currentSaveError === "conflict"
          )
            return;
          setSaving(true);
          setSaveError(null);
          setSaved(false);
          const controller = new AbortController();
          saveOperation.current = controller;
          const submittedSelection = selected;
          void client
            .saveModelConfiguration(
              sessionId,
              configuration.revision,
              model,
              controller.signal,
            )
            .then(
              async () => {
                if (controller.signal.aborted) return;
                drafts.current.delete(submittedSelection);
                baselines.current.set(submittedSelection, {
                  model,
                  configured: true,
                });
                setDirty(drafts.current.size > 0);
                reload(
                  selectedRef.current === submittedSelection
                    ? {
                        selection: `${model.provider}/${model.id}`,
                        source: submittedSelection,
                        saved: true,
                        clearMissing: true,
                      }
                    : {},
                );
                await onSaved().catch(() => false);
              },
              (reason) => {
                if (
                  !controller.signal.aborted &&
                  selectedRef.current === submittedSelection
                )
                  setSaveError({
                    selection: submittedSelection,
                    reason:
                      reason instanceof WebApiError &&
                      reason.code === "MODEL_CONFIGURATION_CONFLICT"
                        ? "conflict"
                        : "failed",
                  });
              },
            )
            .finally(() => {
              if (!controller.signal.aborted) setSaving(false);
            });
        }}
      >
        {selectedKey === undefined && (
          <label className="settings-form-field">
            {t("configuredModels")}
            <select
              value={selected}
              disabled={saving || loading || !configuration}
              onChange={(event) => {
                const key = event.target.value;
                setLocalSelection(key);
                onSelect?.(key);
                setSaved(false);
              }}
            >
              <option value="">{t("addModel")}</option>
              {configuration?.models.map((item) => (
                <option
                  key={`${item.provider}/${item.id}`}
                  value={`${item.provider}/${item.id}`}
                >
                  {item.provider}/{item.id}
                </option>
              ))}
            </select>
          </label>
        )}
        {(["provider", "id", "name", "baseUrl"] as const).map((field) => (
          <label key={field} className="settings-form-field">
            {t(`modelConfig_${field}`)}
            <input
              required
              type={field === "baseUrl" ? "url" : "text"}
              value={model[field]}
              autoComplete="off"
              maxLength={
                field === "baseUrl" ? 2048 : field === "provider" ? 160 : 256
              }
              disabled={
                saving ||
                busy ||
                loading ||
                !configuration ||
                (configuration.models.some(
                  (item) => `${item.provider}/${item.id}` === selected,
                ) &&
                  (field === "provider" || field === "id"))
              }
              onChange={(event) => {
                editModel({ [field]: event.target.value });
              }}
            />
          </label>
        ))}
        <label className="settings-form-field">
          {t("modelConfig_api")}
          <select
            value={model.api}
            disabled={saving || busy || loading || !configuration}
            onChange={(event) => {
              const api = event.target.value;
              if (
                api === "openai-responses" ||
                api === "openai-completions" ||
                api === "anthropic-messages"
              )
                editModel({ api });
            }}
          >
            <option value="openai-responses">OpenAI Responses</option>
            <option value="openai-completions">OpenAI Chat Completions</option>
            <option value="anthropic-messages">Anthropic Messages</option>
          </select>
        </label>
        {(["contextWindow", "maxTokens"] as const).map((field) => (
          <label key={field} className="settings-form-field">
            {t(`modelConfig_${field}`)}
            <input
              required
              type="number"
              min={1}
              max={100000000}
              step={1}
              value={model[field]}
              disabled={saving || busy || loading || !configuration}
              onChange={(event) =>
                editModel({ [field]: Number(event.target.value) })
              }
            />
          </label>
        ))}
        <label>
          <input
            type="checkbox"
            checked={model.reasoning}
            disabled={saving || busy || loading || !configuration}
            onChange={(event) => editModel({ reasoning: event.target.checked })}
          />{" "}
          {t("modelConfig_reasoning")}
        </label>
        <button
          type="submit"
          disabled={
            saving ||
            busy ||
            loading ||
            !configuration ||
            currentSaveError === "conflict"
          }
        >
          {t(saving ? "savingSettings" : "saveModelConfiguration")}
        </button>
        {drafts.current.has(selected) && (
          <p className="settings-edit-state" role="status">
            {t("modelConfigurationUnsaved")}
          </p>
        )}
        {saved && load.selection === selected && (
          <p role="status">{t("modelConfigurationSaved")}</p>
        )}
        {loadError && (
          <div role="alert">
            <p>{t("modelConfigurationLoadFailed")}</p>
            <button
              type="button"
              disabled={saving || loading}
              onClick={() => reload({})}
            >
              {t("retryModelConfiguration")}
            </button>
          </div>
        )}
        {currentSaveError && (
          <div role="alert">
            <p>
              {t(
                currentSaveError === "conflict"
                  ? "modelConfigurationConflict"
                  : "modelConfigurationFailed",
              )}
            </p>
            {currentSaveError === "conflict" && (
              <button
                type="button"
                disabled={saving || loading}
                onClick={() => setDiscardSelection(selected)}
              >
                {t("reloadModelConfiguration")}
              </button>
            )}
          </div>
        )}
      </form>
      {discardSelection !== null && (
        <AlertDialog
          isOpen
          onOpenChange={(open: boolean) => !open && setDiscardSelection(null)}
          title={t("discardModelDraftTitle")}
          description={t("discardModelDraftDetail")}
          cancelLabel={t("keepEditing")}
          actionLabel={t("discardAndReload")}
          onAction={() => {
            if (saving || loading) return;
            reload({
              selection: discardSelection || `${model.provider}/${model.id}`,
              source: discardSelection,
              discard: discardSelection,
              clearMissing: Boolean(discardSelection),
            });
            setDiscardSelection(null);
          }}
        />
      )}
    </section>
  );
}
