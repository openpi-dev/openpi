import { Selector } from "@astryxdesign/core/Selector";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { WebModelSummary } from "../../../../protocol/types.ts";
import type { WebModelDefaults } from "../../../../runtime/types.ts";
import { WebClient } from "../../protocol/client.ts";
import { ProviderIcon } from "./ProviderIcon.tsx";

export function ModelConnectionChoice({
  sessionId,
  sessionPath,
  provider,
  purpose,
  initialModel,
  busy,
  onSelectModel,
  onDefaultSaved,
  onSaving,
  onClose,
}: {
  sessionId: string;
  sessionPath?: string;
  provider?: string;
  purpose: "use" | "default";
  initialModel?: { provider: string; id: string } | null;
  busy: boolean;
  onSelectModel: (value: string) => Promise<boolean> | boolean;
  onDefaultSaved: (defaults: WebModelDefaults) => void;
  onSaving: (value: boolean) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [models, setModels] = useState<WebModelSummary[]>([]);
  const [selected, setSelected] = useState(
    initialModel ? `${initialModel.provider}/${initialModel.id}` : "",
  );
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [omitted, setOmitted] = useState(0);
  const [revision, refresh] = useState(0);
  const [makeDefault, setMakeDefault] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void revision;
    const controller = new AbortController();
    setLoading(true);
    setLoadError(false);
    const timer = window.setTimeout(
      () => {
        void new WebClient()
          .searchModels(query.trim(), sessionId, controller.signal, provider)
          .then(
            (result) => {
              if (controller.signal.aborted) return;
              setModels(result.models);
              setOmitted(result.truncation.matchesOmitted);
              setLoading(false);
            },
            () => {
              if (!controller.signal.aborted) {
                setLoadError(true);
                setLoading(false);
              }
            },
          );
      },
      query ? 200 : 0,
    );
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [sessionId, provider, query, revision]);
  const model =
    models.find((item) => `${item.provider}/${item.id}` === selected) ??
    models[0];
  const groups = new Map<string, WebModelSummary[]>();
  for (const item of models) {
    const group = groups.get(item.provider);
    if (group) group.push(item);
    else groups.set(item.provider, [item]);
  }
  const apply = async () => {
    if (!model || loading || saving || busy || !sessionPath) return;
    setSaving(true);
    onSaving(true);
    setError(null);
    let switched = false;
    try {
      if (purpose === "use") {
        if (!(await onSelectModel(`${model.provider}/${model.id}`)))
          throw new Error("selection failed");
        switched = true;
      }
      if (purpose === "default" || makeDefault) {
        const result = await new WebClient().saveModelDefault(
          model.provider,
          model.id,
          sessionId,
          sessionPath,
        );
        onDefaultSaved(result);
      }
      onClose();
    } catch {
      setError(
        switched
          ? "modelDefaultPartial"
          : purpose === "default"
            ? "modelDefaultSaveFailed"
            : "modelConnectionUseFailed",
      );
    } finally {
      setSaving(false);
      onSaving(false);
    }
  };
  return (
    <div className="models-connection-choice">
      <p className="models-hint">
        {t(
          purpose === "default"
            ? "modelDefaultHint"
            : "modelConnectionNextHint",
        )}
      </p>
      {(models.length > 8 || omitted > 0 || query) && (
        <input
          type="search"
          aria-label={t("modelConnectionSearch")}
          placeholder={t("modelConnectionSearch")}
          maxLength={200}
          value={query}
          disabled={saving}
          onChange={(event) => setQuery(event.target.value)}
        />
      )}
      {loadError ? (
        <p className="models-error" role="alert">
          {t("modelConnectionLoadFailed")}{" "}
          <button
            type="button"
            className="models-link"
            onClick={() => refresh((value) => value + 1)}
          >
            {t("retryAdmissionCheck")}
          </button>
        </p>
      ) : loading ? (
        <p className="models-hint" role="status">
          {t("loadingModels")}
        </p>
      ) : models.length ? (
        <Selector
          label={t("selectModel")}
          className="models-provider-picker"
          placement="below"
          value={model ? `${model.provider}/${model.id}` : ""}
          isDisabled={saving}
          options={[...groups].map(([id, items]) => ({
            type: "section" as const,
            title: id,
            options: items.map((item) => ({
              value: `${item.provider}/${item.id}`,
              label: item.name || item.id,
              description: `${item.provider} · ${item.id}`,
              icon: <ProviderIcon id={item.provider} />,
            })),
          }))}
          onChange={(value: string) => setSelected(value)}
        />
      ) : (
        <p className="models-hint">
          {t(query ? "modelConnectionNoMatch" : "modelConnectionNoModels")}
        </p>
      )}
      {omitted > 0 && !loading && (
        <p className="models-hint">
          {t("modelConnectionMore", { count: omitted })}
        </p>
      )}
      {purpose === "use" && (
        <label className="models-checkbox">
          <input
            type="checkbox"
            checked={makeDefault}
            disabled={saving}
            onChange={(event) => setMakeDefault(event.target.checked)}
          />
          {t("modelMakeDefault")}
        </label>
      )}
      {error && (
        <p className="models-error" role="alert">
          {t(error)}
        </p>
      )}
      <div className="models-editor-actions">
        <button
          type="button"
          className="models-button"
          disabled={saving}
          onClick={onClose}
        >
          {t("cancel")}
        </button>
        <button
          type="button"
          className="models-button primary"
          disabled={
            saving || busy || loading || loadError || !model || !sessionPath
          }
          onClick={() => void apply()}
        >
          {t(
            saving
              ? "providerSaving"
              : purpose === "default"
                ? "modelDefaultSave"
                : "modelConnectionUse",
          )}
        </button>
      </div>
    </div>
  );
}
