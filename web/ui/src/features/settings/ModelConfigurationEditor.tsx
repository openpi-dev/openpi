import { useEffect, useMemo, useState } from "react";
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
  busy,
  onSaved,
}: {
  sessionId: string;
  busy: boolean;
  onSaved: () => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const client = useMemo(() => new WebClient(), []);
  const [configuration, setConfiguration] =
    useState<WebModelConfigurations | null>(null);
  const [model, setModel] = useState(emptyModel);
  const [selected, setSelected] = useState("");
  const [revision, refresh] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision explicitly reloads the native configuration after a save or retry.
  useEffect(() => {
    const controller = new AbortController();
    setConfiguration(null);
    setError(false);
    void client.modelConfigurations(sessionId, controller.signal).then(
      (value) => {
        if (!controller.signal.aborted) setConfiguration(value);
      },
      () => {
        if (!controller.signal.aborted) setError(true);
      },
    );
    return () => controller.abort();
  }, [client, sessionId, revision]);

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
          void client
            .saveModelConfiguration(sessionId, configuration.revision, model)
            .then(
              async () => {
                setSaved(true);
                refresh((value) => value + 1);
                await onSaved();
              },
              () => setError(true),
            )
            .finally(() => setSaving(false));
        }}
      >
        <label className="settings-form-field">
          {t("configuredModels")}
          <select
            value={selected}
            disabled={saving || !configuration}
            onChange={(event) => {
              const key = event.target.value;
              setSelected(key);
              setSaved(false);
              setModel(
                configuration?.models.find(
                  (item) => `${item.provider}/${item.id}` === key,
                ) ?? emptyModel,
              );
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
                (!!selected && (field === "provider" || field === "id"))
              }
              onChange={(event) => {
                setModel({ ...model, [field]: event.target.value });
                setSaved(false);
              }}
            />
          </label>
        ))}
        <label className="settings-form-field">
          {t("modelConfig_api")}
          <select
            value={model.api}
            disabled={saving || busy}
            onChange={(event) => {
              const api = event.target.value;
              if (
                api === "openai-responses" ||
                api === "openai-completions" ||
                api === "anthropic-messages"
              )
                setModel({ ...model, api });
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
              disabled={saving || busy}
              onChange={(event) =>
                setModel({ ...model, [field]: Number(event.target.value) })
              }
            />
          </label>
        ))}
        <label>
          <input
            type="checkbox"
            checked={model.reasoning}
            disabled={saving || busy}
            onChange={(event) =>
              setModel({ ...model, reasoning: event.target.checked })
            }
          />{" "}
          {t("modelConfig_reasoning")}
        </label>
        <button type="submit" disabled={saving || busy || !configuration}>
          {t(saving ? "savingSettings" : "saveModelConfiguration")}
        </button>
        {saved && <p role="status">{t("modelConfigurationSaved")}</p>}
        {error && (
          <div role="alert">
            <p>{t("modelConfigurationFailed")}</p>
            <button
              type="button"
              disabled={saving}
              onClick={() => refresh((value) => value + 1)}
            >
              {t("refreshStatus")}
            </button>
          </div>
        )}
      </form>
    </section>
  );
}
