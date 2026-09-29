import { Dialog } from "@astryxdesign/core/Dialog";
import { Search, X, LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  WebModelConfiguration,
  WebModelConfigurations,
} from "../../../../runtime/types.ts";
import { WebApiError, WebClient } from "../../protocol/client.ts";

export function ProviderModelPicker({
  sessionId,
  template,
  configuration,
  onClose,
  onSaved,
  onSavingChange,
}: {
  sessionId: string;
  template: WebModelConfiguration;
  configuration: WebModelConfigurations;
  onClose: () => void;
  onSaved: (model: WebModelConfiguration) => void;
  onSavingChange?: (saving: boolean) => void;
}) {
  const { t } = useTranslation();
  const [models, setModels] = useState<{ id: string; name: string }[]>([]);
  const [selected, setSelected] = useState(new Set<string>());
  const [query, setQuery] = useState("");
  const [key, setKey] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<"load" | "save" | "conflict" | null>(null);
  const operation = useRef<AbortController | null>(null);
  const saveInFlight = useRef(false);
  const existing = new Set(
    configuration.models
      .filter((model) => model.provider === template.provider)
      .map((model) => model.id),
  );
  const visible = models.filter((model) =>
    `${model.id} ${model.name}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  const selectable = visible.filter((model) => !existing.has(model.id));
  const allVisible =
    selectable.length > 0 &&
    selectable.every((model) => selected.has(model.id));
  const discover = async () => {
    operation.current?.abort();
    const controller = new AbortController();
    operation.current = controller;
    setLoading(true);
    setError(null);
    try {
      const result = await new WebClient().discoverProviderModels(
        sessionId,
        {
          provider: template.provider,
          baseUrl: template.baseUrl,
          api: template.api,
          ...(key.trim() ? { apiKey: key.trim() } : {}),
        },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setModels(result.models);
      setTruncated(result.truncated);
      setSelected(
        (current) =>
          new Set(
            [...current].filter((id) =>
              result.models.some((model) => model.id === id),
            ),
          ),
      );
      setLoaded(true);
    } catch {
      if (!controller.signal.aborted) setError("load");
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  };
  const initialDiscover = useRef(discover);
  useEffect(() => {
    void initialDiscover.current();
    return () => operation.current?.abort();
  }, []);
  const save = async () => {
    if (saveInFlight.current || !selected.size || error === "conflict") return;
    saveInFlight.current = true;
    setSaving(true);
    onSavingChange?.(true);
    setError(null);
    const controller = new AbortController();
    operation.current = controller;
    const additions = models
      .filter((model) => selected.has(model.id) && !existing.has(model.id))
      .map((model) => ({ ...template, id: model.id, name: model.name }));
    try {
      await new WebClient().saveModelConfigurations(
        sessionId,
        configuration.revision,
        additions,
        controller.signal,
      );
      if (!controller.signal.aborted) onSaved(additions[0]!);
    } catch (reason) {
      if (!controller.signal.aborted)
        setError(
          reason instanceof WebApiError &&
            reason.code === "MODEL_CONFIGURATION_CONFLICT"
            ? "conflict"
            : "save",
        );
    } finally {
      saveInFlight.current = false;
      if (!controller.signal.aborted) {
        setSaving(false);
        onSavingChange?.(false);
      }
    }
  };
  return (
    <Dialog
      isOpen
      onOpenChange={(open: boolean) => !open && !saving && onClose()}
      width={480}
      aria-label={t("providerPickerTitle")}
    >
      <div className="provider-model-picker">
        <header>
          <div>
            <h2>{t("providerPickerTitle")}</h2>
            <p>{template.provider}</p>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label={t("close")}
            disabled={saving}
            onClick={onClose}
          >
            <X />
          </button>
        </header>
        <p className="provider-endpoint">{template.baseUrl}</p>
        <details
          className="provider-access"
          open={error === "load" || undefined}
        >
          <summary>{t("providerPickerAccess")}</summary>
          <label className="settings-form-field">
            {t("providerPickerKey")}
            <input
              type="password"
              autoComplete="off"
              value={key}
              disabled={saving || loading}
              onChange={(event) => setKey(event.target.value)}
            />
          </label>
          <p>{t("providerPickerKeyHint")}</p>
        </details>
        <div className="provider-picker-search">
          <Search aria-hidden="true" />
          <input
            type="search"
            aria-label={t("providerPickerSearch")}
            placeholder={t("providerPickerSearch")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <button
            type="button"
            disabled={saving || loading || !selectable.length}
            onClick={() =>
              setSelected(
                allVisible
                  ? new Set()
                  : new Set(
                      [
                        ...selected,
                        ...selectable.map((model) => model.id),
                      ].slice(0, 100),
                    ),
              )
            }
          >
            {t(allVisible ? "providerPickerClear" : "providerPickerSelectAll")}
          </button>
        </div>
        <div className="provider-picker-list" aria-busy={loading}>
          {loading && (
            <p className="provider-picker-empty" role="status">
              <LoaderCircle className="provider-picker-spinner" />
              {t("providerPickerLoading")}
            </p>
          )}
          {!loading &&
            visible.map((model) => (
              <label className="provider-picker-row" key={model.id}>
                <input
                  type="checkbox"
                  checked={existing.has(model.id) || selected.has(model.id)}
                  disabled={
                    saving ||
                    existing.has(model.id) ||
                    (!selected.has(model.id) && selected.size >= 100)
                  }
                  onChange={(event) =>
                    setSelected((previous) => {
                      const next = new Set(previous);
                      if (event.target.checked) next.add(model.id);
                      else next.delete(model.id);
                      return next;
                    })
                  }
                />
                <span>
                  <strong>{model.name}</strong>
                  <code>{model.id}</code>
                </span>
                {existing.has(model.id) && (
                  <small>{t("providerPickerAdded")}</small>
                )}
              </label>
            ))}
          {!loading && loaded && !visible.length && (
            <p className="provider-picker-empty">
              {t(query ? "providerPickerNoMatch" : "providerPickerEmpty")}
            </p>
          )}
        </div>
        {truncated && (
          <p className="settings-edit-state">{t("providerPickerBounded")}</p>
        )}
        {error && (
          <p role="alert" className="provider-picker-error">
            {t(`providerPickerError_${error}`)}
          </p>
        )}
        <p className="settings-edit-state">
          {t("providerPickerDefaults", {
            context: template.contextWindow.toLocaleString(),
            output: template.maxTokens.toLocaleString(),
          })}
        </p>
        <footer>
          <button
            type="button"
            disabled={loading || saving}
            onClick={() => void discover()}
          >
            {t("providerPickerRetry")}
          </button>
          <span>{t("providerPickerCount", { count: selected.size })}</span>
          <button
            type="button"
            className="provider-picker-cancel"
            disabled={saving}
            onClick={onClose}
          >
            {t("cancel")}
          </button>
          <button
            type="button"
            className="provider-picker-save"
            disabled={
              !selected.size || loading || saving || error === "conflict"
            }
            aria-busy={saving}
            onClick={() => void save()}
          >
            {saving && (
              <LoaderCircle
                className="provider-picker-spinner"
                aria-hidden="true"
              />
            )}
            {t("providerPickerSave")}
          </button>
        </footer>
      </div>
    </Dialog>
  );
}
