import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  WebModelConfiguration,
  WebModelConfigurations,
} from "../../../../runtime/types.ts";
import { WebClient } from "../../protocol/client.ts";

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

export function ModelConfigurationEditor({
  sessionId,
  selectedKey,
  selectedModel,
  onSelect,
  onModelsLoaded,
  busy,
  onSaved,
}: {
  sessionId: string;
  selectedKey?: string;
  selectedModel?: { provider: string; id: string; name: string };
  onSelect?: (key: string) => void;
  onModelsLoaded?: (models: WebModelConfiguration[]) => void;
  busy: boolean;
  onSaved: () => Promise<boolean>;
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
  const drafts = useRef(new Map<string, WebModelConfiguration>());
  const [load, reload] = useState<{
    selection?: string;
    saved?: boolean;
    clearMissing?: boolean;
  }>({});
  const saveOperation = useRef<AbortController | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(false);
  const provider = selectedModel?.provider;
  const id = selectedModel?.id;
  const name = selectedModel?.name;
  useEffect(() => {
    if (!configuration) return;
    setError(false);
    setModel(
      drafts.current.get(selected) ??
        configuration.models.find(
          (item) => `${item.provider}/${item.id}` === selected,
        ) ??
        (provider && id
          ? { ...emptyModel, provider, id, name: name || id }
          : emptyModel),
    );
  }, [configuration, selected, provider, id, name]);
  useEffect(() => () => saveOperation.current?.abort(), []);
  useEffect(() => {
    const controller = new AbortController();
    setConfiguration(null);
    setError(false);
    setSaved(false);
    void client.modelConfigurations(sessionId, controller.signal).then(
      (value) => {
        if (controller.signal.aborted) return;
        setConfiguration(value);
        onModelsLoaded?.(value.models);
        if (load.selection !== undefined) {
          const latest = value.models.find(
            (item) => `${item.provider}/${item.id}` === load.selection,
          );
          if (latest) {
            drafts.current.delete(load.selection);
            setLocalSelection(load.selection);
            onSelect?.(load.selection);
          } else if (load.clearMissing) {
            drafts.current.delete(load.selection);
            setLocalSelection("");
            onSelect?.("");
          }
          setSaved(Boolean(latest && load.saved));
        }
      },
      () => {
        if (!controller.signal.aborted) setError(true);
      },
    );
    return () => controller.abort();
  }, [client, sessionId, load, onSelect, onModelsLoaded]);

  const editModel = (patch: Partial<WebModelConfiguration>) => {
    setModel((current) => {
      const updated = { ...current, ...patch };
      drafts.current.set(selected, updated);
      return updated;
    });
    setSaved(false);
  };

  return (
    <section className="settings-section-block">
      <h2>{t("editModelConfiguration")}</h2>
      <p>{t("modelConfigurationDetail")}</p>
      <form
        className="settings-edit-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (saving || busy || !configuration) return;
          setSaving(true);
          setError(false);
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
                reload(
                  selectedRef.current === submittedSelection
                    ? {
                        selection: `${model.provider}/${model.id}`,
                        saved: true,
                        clearMissing: true,
                      }
                    : {},
                );
                await onSaved().catch(() => false);
              },
              () => {
                if (
                  !controller.signal.aborted &&
                  selectedRef.current === submittedSelection
                )
                  setError(true);
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
              disabled={saving || !configuration}
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
            disabled={saving || busy || !configuration}
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
              disabled={saving || busy || !configuration}
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
            disabled={saving || busy || !configuration}
            onChange={(event) => editModel({ reasoning: event.target.checked })}
          />{" "}
          {t("modelConfig_reasoning")}
        </label>
        <button type="submit" disabled={saving || busy || !configuration}>
          {t(saving ? "savingSettings" : "saveModelConfiguration")}
        </button>
        {saved && load.selection === selected && (
          <p role="status">{t("modelConfigurationSaved")}</p>
        )}
        {error && (
          <div role="alert">
            <p>{t("modelConfigurationFailed")}</p>
            <button
              type="button"
              disabled={saving}
              onClick={() => {
                drafts.current.delete(selected);
                reload({
                  selection: selected || `${model.provider}/${model.id}`,
                  clearMissing: Boolean(selected),
                });
              }}
            >
              {t("reloadModelConfiguration")}
            </button>
          </div>
        )}
      </form>
    </section>
  );
}
