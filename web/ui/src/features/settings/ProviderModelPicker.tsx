import { Dialog } from "@astryxdesign/core/Dialog";
import { LoaderCircle, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { WebModelConfiguration } from "../../../../runtime/types.ts";
import type { DiscoveredProviderModel } from "../../../../runtime/provider-model-discovery.ts";
import { WebClient } from "../../protocol/client.ts";

export function ProviderModelPicker({
  sessionId,
  template,
  existingIds,
  apiKey,
  onClose,
  onAdd,
}: {
  sessionId: string;
  template: WebModelConfiguration;
  existingIds: string[];
  apiKey: string;
  onClose: () => void;
  onAdd: (models: DiscoveredProviderModel[]) => void;
}) {
  const { t } = useTranslation();
  const [models, setModels] = useState<DiscoveredProviderModel[]>([]);
  const [selected, setSelected] = useState(new Set<string>());
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState(false);
  const [revision, refresh] = useState(0);
  const connection = useRef({ template, apiKey, existingIds });
  const existing = new Set(existingIds);
  const capacity = Math.max(0, 100 - existing.size);
  const visible = models.filter((model) =>
    `${model.id} ${model.name}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  const selectable = visible.filter((model) => !existing.has(model.id));
  const allVisible =
    selectable.length > 0 &&
    selectable.every((model) => selected.has(model.id));
  useEffect(() => {
    void revision;
    const controller = new AbortController();
    const { template, apiKey, existingIds } = connection.current;
    setLoading(true);
    setError(false);
    void new WebClient()
      .discoverProviderModels(
        sessionId,
        {
          provider: template.provider,
          baseUrl: template.baseUrl,
          api: template.api,
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        },
        controller.signal,
      )
      .then(
        (result) => {
          if (controller.signal.aborted) return;
          setModels(result.models);
          setTruncated(result.truncated);
          setLoading(false);
          setSelected(
            new Set(
              result.models
                .filter((model) => !existingIds.includes(model.id))
                .slice(0, Math.max(0, 100 - existingIds.length))
                .map((model) => model.id),
            ),
          );
        },
        () => {
          if (!controller.signal.aborted) {
            setError(true);
            setLoading(false);
          }
        },
      );
    return () => controller.abort();
  }, [sessionId, revision]);
  return (
    <Dialog
      isOpen
      width={380}
      padding={0}
      className="models-picker-dialog"
      aria-label={t("providerPickerTitle")}
      onOpenChange={(open: boolean) => !open && onClose()}
    >
      <div className="models-picker">
        <header>
          <h2>{t("providerPickerTitle")}</h2>
          <button
            type="button"
            className="models-icon"
            aria-label={t("close")}
            onClick={onClose}
          >
            <X />
          </button>
        </header>
        <p>{t("providerPickerIntro")}</p>
        <div className="models-picker-toolbar">
          <input
            data-autofocus
            type="search"
            aria-label={t("providerPickerSearch")}
            placeholder={t("providerPickerSearch")}
            value={query}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.preventDefault();
            }}
            onChange={(event) => setQuery(event.target.value)}
          />
          <button
            type="button"
            className="models-link"
            disabled={loading || !selectable.length}
            onClick={() =>
              setSelected((previous) => {
                const next = new Set(previous);
                for (const model of selectable) {
                  if (allVisible) next.delete(model.id);
                  else if (next.size < capacity) next.add(model.id);
                }
                return next;
              })
            }
          >
            {t(allVisible ? "providerPickerClear" : "providerPickerSelectAll")}
          </button>
        </div>
        <div className="models-picker-list" aria-busy={loading}>
          {loading && (
            <p className="models-picker-empty" role="status">
              <LoaderCircle className="models-spinner" />
              {t("providerPickerLoading")}
            </p>
          )}
          {!loading &&
            !error &&
            visible.map((model) => (
              <label key={model.id} className="models-picker-row">
                <input
                  type="checkbox"
                  checked={existing.has(model.id) || selected.has(model.id)}
                  disabled={
                    existing.has(model.id) ||
                    (!selected.has(model.id) && selected.size >= capacity)
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
                <span title={model.name}>{model.id}</span>
                {existing.has(model.id) && (
                  <small>{t("providerPickerAdded")}</small>
                )}
              </label>
            ))}
          {!loading && !error && !visible.length && (
            <p className="models-picker-empty">
              {t(query ? "providerPickerNoMatch" : "providerPickerEmpty")}
            </p>
          )}
          {error && (
            <div className="models-error" role="alert">
              <p>{t("providerPickerError_load")}</p>
              <button
                type="button"
                className="models-button"
                onClick={() => refresh((value) => value + 1)}
              >
                {t("retryAdmissionCheck")}
              </button>
            </div>
          )}
        </div>
        {truncated && (
          <p className="models-hint">{t("providerPickerBounded")}</p>
        )}
        <footer>
          <span className="models-hint" aria-live="polite">
            {selected.size > 0 &&
              t("providerPickerSelected", { count: selected.size })}
          </span>
          <button type="button" className="models-button" onClick={onClose}>
            {t("cancel")}
          </button>
          <button
            type="button"
            className="models-button"
            disabled={!selected.size || loading || error}
            onClick={() =>
              onAdd(models.filter((model) => selected.has(model.id)))
            }
          >
            {t("providerPickerSave")}
          </button>
        </footer>
      </div>
    </Dialog>
  );
}
