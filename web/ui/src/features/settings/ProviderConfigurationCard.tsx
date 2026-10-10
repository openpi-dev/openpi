import { ChevronRight, Plus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { WebModelSummary } from "../../../../protocol/types.ts";
import type {
  WebModelConfiguration,
  WebModelConfigurations,
  WebProviderAuthSummary,
} from "../../../../runtime/types.ts";
import { WebApiError, WebClient } from "../../protocol/client.ts";
import { ProviderModelPicker } from "./ProviderModelPicker.tsx";
import { ProviderAccountLogin } from "./ProviderAccountLogin.tsx";
import { formatModelCapacity, parseModelCapacity } from "./model-capacity.ts";

export function ProviderConfigurationCard({
  sessionId,
  providerId,
  configuration,
  auth,
  isNew,
  custom,
  taken,
  currentModel,
  availableModels,
  busy,
  onDirty,
  onSaving,
  onClose,
  onReload,
}: {
  sessionId: string;
  providerId: string;
  configuration: WebModelConfigurations;
  auth?: WebProviderAuthSummary;
  isNew: boolean;
  custom: boolean;
  taken: string[];
  currentModel?: WebModelSummary;
  availableModels: WebModelSummary[];
  busy: boolean;
  onDirty: (dirty: boolean) => void;
  onSaving: (saving: boolean) => void;
  onClose: (savedName?: string) => void;
  onReload: () => void;
}) {
  const { t } = useTranslation();
  const [baseline] = useState(() => {
    const saved = configuration.providers?.find(
      (provider) => provider.provider === providerId,
    );
    const models = configuration.models
      .filter((model) => model.provider === providerId)
      .map((model) => ({ ...model, rowKey: crypto.randomUUID() }));
    return {
      provider: providerId,
      name: saved?.name || auth?.name || providerId,
      baseUrl: saved?.baseUrl || models[0]?.baseUrl || auth?.baseUrl || "",
      api:
        saved?.api ||
        models[0]?.api ||
        auth?.api ||
        ("openai-completions" as WebModelConfiguration["api"]),
      models,
    };
  });
  const [revision] = useState(configuration.revision);
  const [draft, setDraft] = useState(baseline);
  const [apiKey, setApiKey] = useState("");
  const hasAccount = Boolean(auth?.authMethods.includes("oauth"));
  const hasKey = custom || Boolean(auth?.authMethods.includes("api_key"));
  const [authMethod, setAuthMethod] = useState(
    hasAccount && (!auth?.configured || auth?.subscription || !hasKey)
      ? "oauth"
      : "api_key",
  );
  const [accountSaving, setAccountSaving] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const discoveryButton = useRef<HTMLButtonElement>(null);
  const restorePickerFocus = useRef(false);
  const [expanded, setExpanded] = useState(new Set<string>());
  const [capacityText, setCapacityText] = useState<
    Record<string, Partial<Record<"contextWindow" | "maxTokens", string>>>
  >({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<
    "failed" | "conflict" | "key" | "current" | null
  >(null);
  const [profileSaved, setProfileSaved] = useState(false);
  const operation = useRef<AbortController | null>(null);
  const callbacks = useRef({ onDirty, onSaving });
  callbacks.current = { onDirty, onSaving };
  const changed = JSON.stringify(draft) !== JSON.stringify(baseline);
  const dirty = changed || apiKey.length > 0;
  useEffect(() => {
    callbacks.current.onDirty(dirty);
  }, [dirty]);
  useEffect(() => {
    callbacks.current.onSaving(saving || accountSaving);
  }, [saving, accountSaving]);
  useEffect(() => {
    if (pickerOpen) restorePickerFocus.current = true;
    else if (restorePickerFocus.current) {
      restorePickerFocus.current = false;
      discoveryButton.current?.focus({ preventScroll: true });
    }
  }, [pickerOpen]);
  useEffect(
    () => () => {
      operation.current?.abort();
      callbacks.current.onSaving(false);
      callbacks.current.onDirty(false);
    },
    [],
  );
  const editable =
    configuration.providers?.find(
      (provider) => provider.provider === providerId,
    )?.editable !== false;
  const disabled = busy || saving || accountSaving;
  const profileDisabled = disabled || profileSaved || !editable;
  const idInvalid =
    !/^[a-zA-Z0-9._-]+$/.test(draft.provider) ||
    ["__proto__", "constructor", "prototype"].includes(draft.provider) ||
    (isNew && custom && taken.includes(draft.provider));
  const invalidModel = draft.models.findIndex(
    (model) =>
      !model.id.trim() ||
      [model.contextWindow, model.maxTokens].some(
        (value) => value !== undefined && !Number.isFinite(value),
      ) ||
      draft.models.some(
        (other) =>
          other.rowKey !== model.rowKey && other.id.trim() === model.id.trim(),
      ),
  );
  const modelsInvalid = invalidModel !== -1;
  const needsProfile = (isNew && custom) || changed;
  const ready =
    !idInvalid &&
    !/[\r\n\u0000]/u.test(apiKey) &&
    (profileSaved ||
      !needsProfile ||
      ((!custom || draft.models.length > 0) &&
        !modelsInvalid &&
        Boolean(draft.baseUrl))) &&
    (needsProfile || apiKey.trim().length > 0);
  const update = (patch: Partial<typeof draft>) => {
    setDraft((previous) => ({ ...previous, ...patch }));
    if (error !== "conflict") setError(null);
  };
  const updateModel = (index: number, patch: Partial<WebModelConfiguration>) =>
    update({
      models: draft.models.map((model, at) =>
        at === index ? { ...model, ...patch } : model,
      ),
    });
  const template: WebModelConfiguration = {
    id: "",
    name: "",
    reasoning: false,
    provider: draft.provider,
    baseUrl: draft.baseUrl,
    api: draft.api,
  };
  const save = async () => {
    if (disabled || pickerOpen || !ready || error === "conflict") return;
    const controller = new AbortController();
    operation.current = controller;
    setSaving(true);
    setError(null);
    let written = profileSaved;
    const client = new WebClient();
    try {
      if (needsProfile && !written) {
        await client.changeProviderConfiguration(
          sessionId,
          revision,
          {
            action: "save",
            configuration: {
              ...draft,
              name: draft.name.trim() || draft.provider,
              models: draft.models.map(({ rowKey: _rowKey, ...model }) => ({
                ...model,
                id: model.id.trim(),
                name: model.name.trim() || model.id.trim(),
                provider: draft.provider,
                // Retain per-model connection overrides unless the shared connection was edited.
                baseUrl:
                  draft.baseUrl !== baseline.baseUrl
                    ? draft.baseUrl
                    : model.baseUrl || draft.baseUrl,
                api: draft.api !== baseline.api ? draft.api : model.api,
              })),
            },
          },
          controller.signal,
        );
        if (controller.signal.aborted) return;
        written = true;
        setProfileSaved(true);
      }
      if (apiKey.trim())
        await client.saveProviderKey(
          sessionId,
          draft.provider,
          apiKey.trim(),
          controller.signal,
        );
      if (controller.signal.aborted) return;
      setApiKey("");
      callbacks.current.onDirty(false);
      onClose(draft.name || draft.provider);
    } catch (reason) {
      if (!controller.signal.aborted)
        setError(
          reason instanceof WebApiError &&
            reason.code === "MODEL_CONFIGURATION_CONFLICT"
            ? "conflict"
            : reason instanceof WebApiError &&
                reason.code === "MODEL_NOT_AVAILABLE"
              ? "current"
              : written
                ? "key"
                : "failed",
        );
    } finally {
      if (!controller.signal.aborted) {
        setSaving(false);
      }
    }
  };
  const field = (key: "provider" | "name" | "baseUrl") => (
    <label className="models-field">
      {t(key === "name" ? "providerDisplayName" : `modelConfig_${key}`)}
      <input
        type={key === "baseUrl" ? "url" : "text"}
        value={draft[key]}
        maxLength={key === "baseUrl" ? 2048 : 160}
        autoComplete="off"
        disabled={profileDisabled}
        required={key === "provider" || (key === "baseUrl" && needsProfile)}
        aria-invalid={
          key === "provider" && draft.provider.length > 0 && idInvalid
        }
        placeholder={
          key === "provider"
            ? "my-provider"
            : key === "name"
              ? draft.provider
              : "https://api.example.com/v1"
        }
        onChange={(event) => update({ [key]: event.target.value })}
      />
    </label>
  );
  const apiField = (
    <label className="models-field">
      {t("modelConfig_api")}
      <select
        value={draft.api}
        disabled={profileDisabled}
        onChange={(event) => {
          const api = event.target.value;
          if (
            api === "openai-responses" ||
            api === "openai-completions" ||
            api === "anthropic-messages"
          )
            update({ api });
        }}
      >
        <option value="openai-completions">OpenAI Chat Completions</option>
        <option value="openai-responses">OpenAI Responses</option>
        <option value="anthropic-messages">Anthropic Messages</option>
      </select>
    </label>
  );
  const modelList = (
    <div className="models-catalog">
      <div className="models-list-head">
        <span>{t("modelSettings")}</span>
        <button
          type="button"
          ref={discoveryButton}
          className="models-link"
          disabled={profileDisabled || idInvalid || !draft.baseUrl}
          onClick={() => setPickerOpen(true)}
        >
          {t("providerFetchModels")}
        </button>
      </div>
      {!editable && (
        <p className="models-hint">{t("providerModelsReadOnly")}</p>
      )}
      {draft.models.length === 0 && (
        <p className="models-empty">
          {t(custom ? "providerModelsEmpty" : "providerModelsInherited", {
            count: availableModels.length,
          })}
        </p>
      )}
      <div className="models-entry-list">
        {draft.models.map((model, index) => (
          <div className="models-entry" key={model.rowKey}>
            <div className="models-entry-row">
              <input
                aria-label={t("providerModelId", { number: index + 1 })}
                placeholder={t("modelConfig_id")}
                value={model.id}
                maxLength={256}
                required
                disabled={
                  profileDisabled ||
                  (currentModel?.provider === draft.provider &&
                    currentModel.id === model.id)
                }
                onChange={(event) =>
                  updateModel(index, { id: event.target.value })
                }
              />
              <input
                aria-label={t("providerModelName", { number: index + 1 })}
                placeholder={t("modelConfig_name")}
                value={model.name}
                maxLength={256}
                disabled={profileDisabled}
                onChange={(event) =>
                  updateModel(index, { name: event.target.value })
                }
              />
              <button
                type="button"
                className="models-icon"
                aria-label={t("providerModelDetails", {
                  model: model.name || model.id || index + 1,
                })}
                aria-expanded={expanded.has(model.rowKey)}
                title={t("providerModelOptions")}
                onClick={() =>
                  setExpanded((previous) => {
                    const next = new Set(previous);
                    if (!next.delete(model.rowKey)) next.add(model.rowKey);
                    return next;
                  })
                }
              >
                <ChevronRight />
              </button>
              <button
                type="button"
                className="models-icon danger"
                aria-label={t("providerRemoveModel", {
                  model: model.name || model.id || index + 1,
                })}
                disabled={
                  profileDisabled ||
                  (currentModel?.provider === draft.provider &&
                    currentModel.id === model.id)
                }
                title={
                  currentModel?.provider === draft.provider &&
                  currentModel.id === model.id
                    ? t("providerCurrentRemoval")
                    : t("providerRemoveModel", {
                        model: model.name || model.id || index + 1,
                      })
                }
                onClick={() => {
                  update({
                    models: draft.models.filter((_, at) => at !== index),
                  });
                  setExpanded(
                    (previous) =>
                      new Set(
                        [...previous].filter((key) => key !== model.rowKey),
                      ),
                  );
                  setCapacityText((previous) =>
                    Object.fromEntries(
                      Object.entries(previous).filter(
                        ([key]) => key !== model.rowKey,
                      ),
                    ),
                  );
                }}
              >
                <Trash2 />
              </button>
            </div>
            {expanded.has(model.rowKey) && (
              <div className="models-entry-details">
                {(["contextWindow", "maxTokens"] as const).map((key) => (
                  <label key={key} className="models-field models-capacity">
                    {t(`modelConfig_${key}`)}
                    <input
                      type="text"
                      inputMode="numeric"
                      autoComplete="off"
                      spellCheck={false}
                      aria-label={t("providerCapacityLabel", {
                        field: t(`modelConfig_${key}`),
                        number: index + 1,
                      })}
                      aria-invalid={
                        model[key] !== undefined && !Number.isFinite(model[key])
                      }
                      placeholder={key === "contextWindow" ? "256K" : "32K"}
                      value={
                        capacityText[model.rowKey]?.[key] ??
                        formatModelCapacity(model[key])
                      }
                      disabled={profileDisabled}
                      onChange={(event) => {
                        const text = event.target.value;
                        setCapacityText((previous) => ({
                          ...previous,
                          [model.rowKey]: {
                            ...previous[model.rowKey],
                            [key]: text,
                          },
                        }));
                        updateModel(index, { [key]: parseModelCapacity(text) });
                      }}
                    />
                  </label>
                ))}
                <fieldset
                  className="models-input-types"
                  aria-label={t("providerCapacityLabel", {
                    field: t("providerInputTypes"),
                    number: index + 1,
                  })}
                >
                  <legend>{t("providerInputTypes")}</legend>
                  <div>
                    {(["text", "image"] as const).map((kind) => {
                      const selected = model.input ?? ["text"];
                      return (
                        <label className="models-checkbox" key={kind}>
                          <input
                            type="checkbox"
                            checked={selected.includes(kind)}
                            disabled={
                              profileDisabled ||
                              (selected.length === 1 && selected.includes(kind))
                            }
                            onChange={(event) =>
                              updateModel(index, {
                                input: (["text", "image"] as const).filter(
                                  (value) =>
                                    value === kind
                                      ? event.target.checked
                                      : selected.includes(value),
                                ),
                              })
                            }
                          />
                          {t(
                            kind === "text"
                              ? "providerInputText"
                              : "providerInputImage",
                          )}
                        </label>
                      );
                    })}
                  </div>
                </fieldset>
                <p className="models-hint models-capability-hint">
                  {t("providerImageHint")}
                </p>
                <label className="models-checkbox models-reasoning">
                  <input
                    type="checkbox"
                    checked={model.reasoning}
                    disabled={profileDisabled}
                    onChange={(event) =>
                      updateModel(index, { reasoning: event.target.checked })
                    }
                  />
                  {t("modelConfig_reasoning")}
                </label>
                <p className="models-hint models-capability-hint">
                  {t("providerReasoningHint")}
                </p>
              </div>
            )}
          </div>
        ))}
      </div>
      <button
        type="button"
        className="models-button models-add-model"
        disabled={profileDisabled || draft.models.length >= 100}
        onClick={() => {
          update({
            models: [
              ...draft.models,
              { ...template, rowKey: crypto.randomUUID() },
            ],
          });
        }}
      >
        <Plus aria-hidden="true" />
        {t("addModel")}
      </button>
      {modelsInvalid && (
        <p className="models-error" role="alert">
          {t("providerModelInvalid", { number: invalidModel + 1 })}
        </p>
      )}
    </div>
  );
  return (
    <form
      className="models-editor"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      {!isNew && custom && (
        <div className="models-editor-heading">
          <span>{draft.name || draft.provider}</span>
          {draft.name !== draft.provider && <small>{draft.provider}</small>}
        </div>
      )}
      {isNew && custom && (
        <>
          {field("provider")}
          {draft.provider && idInvalid && (
            <p className="models-error">{t("providerIdInvalid")}</p>
          )}
          {field("name")}
          {field("baseUrl")}
          {apiField}
        </>
      )}
      {hasAccount && hasKey && (
        <fieldset
          className="models-add-modes"
          aria-label={t("accountLoginMethod")}
        >
          <button
            type="button"
            aria-pressed={authMethod === "oauth"}
            disabled={disabled}
            onClick={() => setAuthMethod("oauth")}
          >
            {t("accountLoginTab")}
          </button>
          <button
            type="button"
            aria-pressed={authMethod === "api_key"}
            disabled={disabled}
            onClick={() => setAuthMethod("api_key")}
          >
            {t("accountLoginKeyTab")}
          </button>
        </fieldset>
      )}
      {hasAccount && authMethod === "oauth" && auth && (
        <>
          <ProviderAccountLogin
            sessionId={sessionId}
            auth={auth}
            busy={busy || saving || dirty}
            onSaving={setAccountSaving}
            onAuthenticated={() => onClose(draft.name || draft.provider)}
            onReload={onReload}
          />
          {dirty && <p className="models-hint">{t("accountLoginUnsaved")}</p>}
        </>
      )}
      {hasKey && authMethod === "api_key" ? (
        <label className="models-field">
          {t("providerApiKey")}
          <input
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            maxLength={8192}
            value={apiKey}
            placeholder={t(
              auth?.configured ? "providerKeyKeep" : "providerKeyOptional",
            )}
            disabled={disabled}
            onChange={(event) => {
              setApiKey(event.target.value);
              if (error !== "conflict") setError(null);
            }}
          />
        </label>
      ) : !hasAccount ? (
        <p className="models-hint">{t("providerNativeAuth")}</p>
      ) : null}
      {isNew && custom ? (
        modelList
      ) : (
        <details className="models-customized">
          <summary>{t("providerCustomSettings")}</summary>
          <div>
            {custom && field("name")}
            {field("baseUrl")}
            {custom && apiField}
            {modelList}
          </div>
        </details>
      )}
      {error && (
        <p className="models-error" role="alert">
          {t(
            error === "conflict"
              ? "modelConfigurationConflict"
              : error === "key"
                ? "providerProfileSavedKeyFailed"
                : error === "current"
                  ? "providerCurrentRemoval"
                  : "providerConfigurationFailed",
          )}
        </p>
      )}
      {error === "conflict" && (
        <button type="button" className="models-button" onClick={onReload}>
          {t("providerReload")}
        </button>
      )}
      {!accountSaving && (
        <div className="models-editor-actions">
          <button
            type="button"
            className="models-button"
            disabled={saving}
            onClick={() => (profileSaved ? onReload() : onClose())}
          >
            {t("cancel")}
          </button>
          {(authMethod === "api_key" || changed) && (
            <button
              type="submit"
              className="models-button primary"
              disabled={disabled || !ready || error === "conflict"}
              aria-busy={saving}
            >
              {t(saving ? "savingSettings" : "providerSave")}
            </button>
          )}
        </div>
      )}
      {pickerOpen && (
        <ProviderModelPicker
          sessionId={sessionId}
          template={template}
          existingIds={draft.models.map((model) => model.id)}
          apiKey={apiKey}
          onClose={() => setPickerOpen(false)}
          onAdd={(models) => {
            update({
              models: [
                ...draft.models,
                ...models.map((model) => ({
                  ...template,
                  ...model,
                  rowKey: crypto.randomUUID(),
                })),
              ],
            });
            setPickerOpen(false);
          }}
        />
      )}
    </form>
  );
}
