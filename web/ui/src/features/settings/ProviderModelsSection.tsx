import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Selector } from "@astryxdesign/core/Selector";
import { Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { WebModelSummary } from "../../../../protocol/types.ts";
import type {
  WebModelConfigurations,
  WebModelDefaults,
  WebProviderAuthProjection,
} from "../../../../runtime/types.ts";
import { WebApiError, WebClient } from "../../protocol/client.ts";
import { ProviderAccountLogin } from "./ProviderAccountLogin.tsx";
import { ProviderConfigurationCard } from "./ProviderConfigurationCard.tsx";
import { ProviderIcon } from "./ProviderIcon.tsx";
import { ModelConnectionChoice } from "./ModelConnectionChoice.tsx";
import "./provider-models.css";

export function ProviderModelsSection({
  sessionId,
  sessionPath,
  models,
  currentModel,
  busy,
  focusCredentials,
  onSaved,
  onSelectModel,
  onDraftChange,
  onSavingChange,
}: {
  sessionId: string;
  sessionPath?: string;
  models: WebModelSummary[];
  currentModel?: WebModelSummary;
  busy: boolean;
  focusCredentials: boolean;
  onSaved: () => Promise<boolean>;
  onSelectModel: (value: string) => Promise<boolean> | boolean;
  onDraftChange: (dirty: boolean) => void;
  onSavingChange: (saving: boolean) => void;
}) {
  const { t } = useTranslation();
  const [data, setData] = useState<{
    configuration: WebModelConfigurations;
    auth: WebProviderAuthProjection;
  } | null>(null);
  const [revision, refresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [visited, setVisited] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);
  const [mode, setMode] = useState("account");
  const [accountId, setAccountId] = useState("");
  const [catalogId, setCatalogId] = useState("");
  const [dirty, setDirty] = useState<Record<string, boolean>>({});
  const [removing, setRemoving] = useState(false);
  const [cardSaving, setCardSaving] = useState<Record<string, boolean>>({});
  const [choosingSaving, setChoosingSaving] = useState(false);
  const saving =
    removing || choosingSaving || Object.values(cardSaving).some(Boolean);
  const [defaults, setDefaults] = useState<WebModelDefaults | null>(null);
  const [defaultError, setDefaultError] = useState(false);
  const [choice, setChoice] = useState<{
    purpose: "use" | "default";
    provider?: string;
  } | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [remove, setRemove] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const operation = useRef<AbortController | null>(null);
  const initialFocus = useRef(focusCredentials);
  const returnFocus = useRef<string | null>(null);
  const editButtons = useRef(new Map<string, HTMLButtonElement>());
  const addButton = useRef<HTMLButtonElement>(null);
  const choiceReturnFocus = useRef<HTMLButtonElement | null>(null);
  const callbacks = useRef({ onDraftChange, onSavingChange });
  callbacks.current = { onDraftChange, onSavingChange };
  useEffect(() => {
    onDraftChange(Object.values(dirty).some(Boolean));
  }, [dirty, onDraftChange]);
  useEffect(() => {
    onSavingChange(saving);
  }, [saving, onSavingChange]);
  useEffect(() => {
    if (!choice && !saving && choiceReturnFocus.current) {
      choiceReturnFocus.current.focus({ preventScroll: true });
      choiceReturnFocus.current = null;
    }
  }, [choice, saving]);
  useEffect(() => {
    if (!returnFocus.current) return;
    const target = returnFocus.current;
    returnFocus.current = null;
    (editButtons.current.get(target) ?? addButton.current)?.focus({
      preventScroll: true,
    });
  });
  useEffect(
    () => () => {
      operation.current?.abort();
      callbacks.current.onDraftChange(false);
      callbacks.current.onSavingChange(false);
    },
    [],
  );
  useEffect(() => {
    void revision;
    const controller = new AbortController();
    setLoading(true);
    setLoadError(false);
    const client = new WebClient();
    void Promise.all([
      client.modelConfigurations(sessionId, controller.signal),
      client.providerAuth(sessionId, controller.signal),
    ]).then(
      ([configuration, auth]) => {
        if (controller.signal.aborted) return;
        setData({ configuration, auth });
        setLoading(false);
        if (initialFocus.current) {
          initialFocus.current = false;
          const id =
            currentModel?.provider ||
            auth.providers.find((provider) => provider.configured)?.id;
          if (id) {
            setEditing(id);
            setVisited([id]);
          }
        }
      },
      () => {
        if (!controller.signal.aborted) {
          setLoadError(true);
          setLoading(false);
        }
      },
    );
    return () => controller.abort();
  }, [sessionId, revision, currentModel?.provider]);
  useEffect(() => {
    void revision;
    const controller = new AbortController();
    setDefaultError(false);
    void new WebClient().modelDefaults(sessionId, controller.signal).then(
      (result) => {
        if (!controller.signal.aborted) setDefaults(result);
      },
      () => {
        if (!controller.signal.aborted) setDefaultError(true);
      },
    );
    return () => controller.abort();
  }, [sessionId, revision]);

  const configuration = data?.configuration;
  const configuredIds = new Set([
    ...(configuration?.providers?.map((provider) => provider.provider) ?? []),
    ...(configuration?.models.map((model) => model.provider) ?? []),
  ]);
  const visibleIds = new Set([
    ...configuredIds,
    ...(data?.auth.providers
      .filter((provider) => provider.configured)
      .map((provider) => provider.id) ?? []),
    ...models.map((model) => model.provider),
    ...visited.filter((id) => !id.startsWith("add:")),
  ]);
  const providers = [...visibleIds].map((id) => {
    const auth = data?.auth.providers.find((provider) => provider.id === id);
    const config = configuration?.providers?.find(
      (provider) => provider.provider === id,
    );
    return { id, name: config?.name || auth?.name || id, auth };
  });
  const available =
    data?.auth.providers.filter(
      (provider) =>
        provider.authMethods.includes("api_key") &&
        !visibleIds.has(provider.id),
    ) ?? [];
  const accounts =
    data?.auth.providers.filter(
      (provider) =>
        provider.authMethods.includes("oauth") && !provider.subscription,
    ) ?? [];
  const selectedAccount =
    accounts.find((provider) => provider.id === accountId) ?? accounts[0];
  const selectedCatalog =
    available.find((provider) => provider.id === catalogId) ?? available[0];
  const addModes = [
    {
      id: "account",
      label: "accountLoginTab",
      hint: "providerAccountHint",
      available: accounts.length > 0,
    },
    {
      id: "catalog",
      label: "providerAddCatalog",
      hint: "providerCatalogHint",
      available: available.length > 0,
    },
    {
      id: "custom",
      label: "providerAddCustom",
      hint: "providerCustomHint",
      available: true,
    },
  ];
  const selectAddMode = (nextMode: string) => {
    setMode(nextMode);
    const key =
      nextMode === "custom"
        ? "add:custom"
        : nextMode === "account"
          ? selectedAccount && `add:account:${selectedAccount.id}`
          : selectedCatalog && `add:${selectedCatalog.id}`;
    if (key)
      setVisited((previous) =>
        previous.includes(key) ? previous : [...previous, key],
      );
  };
  const selectEditor = (id: string) => {
    choiceReturnFocus.current = null;
    setChoice(null);
    setSaved(null);
    setAdding(false);
    setEditing(editing === id ? null : id);
    setVisited((previous) =>
      previous.includes(id) ? previous : [...previous, id],
    );
  };
  const closeCard = (key: string, name?: string, provider?: string) => {
    choiceReturnFocus.current = null;
    returnFocus.current = key;
    const closing = (id: string) =>
      key.startsWith("add:") ? id.startsWith("add:") : id === key;
    setVisited((previous) => previous.filter((id) => !closing(id)));
    setDirty((previous) =>
      Object.fromEntries(
        Object.entries(previous).filter(([id]) => !closing(id)),
      ),
    );
    if (key.startsWith("add:")) setAdding(false);
    else setEditing(null);
    if (name) {
      setSaved(name);
      setChoice({ purpose: "use", provider: provider ?? key });
      refresh((value) => value + 1);
      void onSaved().catch(() => false);
    }
  };
  const card = (key: string, id: string, isNew: boolean, custom: boolean) => {
    if (!configuration) return null;
    const auth = data?.auth.providers.find((provider) => provider.id === id);
    const onSaving = (value: boolean) =>
      setCardSaving((previous) =>
        previous[key] === value ? previous : { ...previous, [key]: value },
      );
    const onReload = () => {
      closeCard(key);
      refresh((value) => value + 1);
      void onSaved().catch(() => false);
    };
    if (key.startsWith("add:account:"))
      return (
        auth && (
          <div className="models-editor">
            <ProviderAccountLogin
              sessionId={sessionId}
              auth={auth}
              busy={busy}
              onSaving={onSaving}
              onAuthenticated={() =>
                closeCard(key, auth.name || auth.id, auth.id)
              }
              onReload={onReload}
            />
            {!cardSaving[key] && (
              <div className="models-editor-actions">
                <button
                  type="button"
                  className="models-button"
                  onClick={() => closeCard(key)}
                >
                  {t("cancel")}
                </button>
              </div>
            )}
          </div>
        )
      );
    return (
      <ProviderConfigurationCard
        key={key}
        sessionId={sessionId}
        providerId={id}
        configuration={configuration}
        auth={auth}
        isNew={isNew}
        custom={custom}
        taken={[
          ...(data?.auth.providers.map((provider) => provider.id) ?? []),
          ...configuredIds,
        ]}
        currentModel={currentModel}
        availableModels={models.filter((model) => model.provider === id)}
        busy={busy}
        onDirty={(value) =>
          setDirty((previous) =>
            previous[key] === value ? previous : { ...previous, [key]: value },
          )
        }
        onSaving={onSaving}
        onClose={(name, provider) => closeCard(key, name, provider)}
        onReload={onReload}
      />
    );
  };
  const providerName = (id: string) =>
    providers.find((item) => item.id === id)?.name ?? id;
  const modelName = (model: { provider: string; id: string }) =>
    models.find(
      (item) => item.provider === model.provider && item.id === model.id,
    )?.name || model.id;
  const choose = (
    purpose: "use" | "default",
    trigger: HTMLButtonElement,
    provider?: string,
  ) => {
    choiceReturnFocus.current = trigger;
    setChoice({ purpose, provider });
    setEditing(null);
    setAdding(false);
  };
  const chooser = (purpose: "use" | "default", provider?: string) => (
    <ModelConnectionChoice
      key={`${purpose}:${provider ?? "all"}`}
      sessionId={sessionId}
      sessionPath={sessionPath}
      provider={provider}
      purpose={purpose}
      initialModel={purpose === "default" ? defaults?.model : currentModel}
      busy={busy}
      onSelectModel={onSelectModel}
      onDefaultSaved={(result) => {
        setDefaults(result);
        setDefaultError(false);
        void onSaved().catch(() => false);
      }}
      onSaving={setChoosingSaving}
      onClose={() => {
        setChoice(null);
      }}
    />
  );

  return (
    <div className="models-page">
      <div className="models-section">
        <h2>{t("modelSettings")}</h2>
        <p className="models-intro">{t("modelsIntro")}</p>
        {saved && (
          <p className="models-saved" role="status">
            {t("providerSaved", { provider: saved })}
          </p>
        )}
        {loadError && (
          <div className="models-error" role="alert">
            {t("providerLoadFailed")}{" "}
            <button
              type="button"
              className="models-button"
              disabled={loading}
              onClick={() => refresh((value) => value + 1)}
            >
              {t("retryAdmissionCheck")}
            </button>
          </div>
        )}
        {removeError && !remove && (
          <div className="models-error" role="alert">
            {removeError}{" "}
            <button
              type="button"
              className="models-button"
              disabled={loading}
              onClick={() => {
                setRemoveError(null);
                refresh((value) => value + 1);
              }}
            >
              {t("refreshStatus")}
            </button>
          </div>
        )}
        {!data && loading && (
          <p className="models-hint" role="status">
            {t("providerLoading")}
          </p>
        )}
        <div className="models-default-card">
          <div className="models-default-row">
            <div className="models-default-copy">
              <span className="models-default-title">
                {t("modelDefaultTitle")}
              </span>
              {defaultError ? (
                <span className="models-hint">
                  {t("modelDefaultReadFailed")}
                </span>
              ) : defaults?.model ? (
                <span className="models-default-value">
                  <ProviderIcon
                    id={defaults.model.provider}
                    name={providerName(defaults.model.provider)}
                  />
                  <span>
                    {modelName(defaults.model)}
                    <small>{providerName(defaults.model.provider)}</small>
                  </span>
                </span>
              ) : (
                <span className="models-hint">
                  {t(defaults ? "modelDefaultNotSet" : "loadingModels")}
                </span>
              )}
            </div>
            <button
              type="button"
              className="models-button"
              disabled={
                saving ||
                busy ||
                Object.values(dirty).some(Boolean) ||
                !sessionPath
              }
              aria-expanded={choice?.purpose === "default"}
              onClick={(event) =>
                defaultError
                  ? refresh((value) => value + 1)
                  : choice?.purpose === "default"
                    ? setChoice(null)
                    : choose("default", event.currentTarget)
              }
            >
              {t(defaultError ? "refreshStatus" : "modelDefaultChoose")}
            </button>
          </div>
          {defaults?.projectOverride && (
            <p className="models-hint">
              {t("modelDefaultProjectOverride", {
                model: `${providerName(defaults.projectOverride.provider)} / ${modelName(defaults.projectOverride)}`,
              })}
            </p>
          )}
          {choice?.purpose === "default" && chooser("default")}
        </div>
        <ul className="models-provider-list">
          {providers.map((provider) => {
            const open = !adding && editing === provider.id;
            const custom =
              provider.auth?.custom ?? configuredIds.has(provider.id);
            return (
              <li key={provider.id} className="models-provider-card">
                <div className="models-provider-head">
                  <div className="models-provider-identity">
                    <span className="models-provider-avatar" aria-hidden="true">
                      <ProviderIcon id={provider.id} name={provider.name} />
                    </span>
                    <div className="models-provider-label">
                      <span className="models-provider-name">
                        {provider.name}
                      </span>
                      {custom && (
                        <span className="models-provider-tag">
                          {t("providerCustomTag")}
                        </span>
                      )}
                      {defaults?.model?.provider === provider.id && (
                        <span className="models-provider-tag">
                          {t("modelDefaultBadge")}
                        </span>
                      )}
                      {currentModel?.provider === provider.id && (
                        <span className="models-provider-tag">
                          {t("modelCurrentBadge")}
                        </span>
                      )}
                      {provider.auth && (
                        <span className="models-provider-status">
                          <span
                            className={`models-credential-dot ${provider.auth.configured ? "configured" : "missing"}`}
                            role="img"
                            aria-label={t(
                              provider.auth.configured
                                ? "credentialConfigured"
                                : "credentialMissing",
                            )}
                            title={t(
                              provider.auth.configured
                                ? "credentialConfigured"
                                : "credentialMissing",
                            )}
                          />
                          {t(
                            provider.auth.subscription
                              ? "accountLoginConfigured"
                              : provider.auth.configured
                                ? "credentialConfigured"
                                : "credentialMissing",
                          )}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="models-provider-actions">
                    {provider.auth?.configured && (
                      <button
                        type="button"
                        className="models-button"
                        disabled={
                          saving ||
                          busy ||
                          Object.values(dirty).some(Boolean) ||
                          !sessionPath
                        }
                        aria-label={t("modelConnectionChooseProvider", {
                          provider: provider.name,
                        })}
                        aria-expanded={
                          choice?.purpose === "use" &&
                          choice.provider === provider.id
                        }
                        onClick={(event) =>
                          choice?.purpose === "use" &&
                          choice.provider === provider.id
                            ? setChoice(null)
                            : choose("use", event.currentTarget, provider.id)
                        }
                      >
                        {t("selectModel")}
                      </button>
                    )}
                    <button
                      type="button"
                      className="models-button"
                      aria-label={t("editProvider", {
                        provider: provider.name,
                      })}
                      ref={(element) => {
                        if (element)
                          editButtons.current.set(provider.id, element);
                        else editButtons.current.delete(provider.id);
                      }}
                      aria-expanded={open}
                      disabled={saving}
                      onClick={() => selectEditor(provider.id)}
                    >
                      {t(
                        provider.auth?.authMethods.includes("oauth") &&
                          !provider.auth.configured
                          ? "accountLoginStart"
                          : "providerEdit",
                      )}
                    </button>
                    {configuredIds.has(provider.id) && (
                      <button
                        type="button"
                        className="models-button danger"
                        aria-label={t("removeProvider", {
                          provider: provider.name,
                        })}
                        disabled={
                          saving ||
                          busy ||
                          currentModel?.provider === provider.id
                        }
                        title={
                          currentModel?.provider === provider.id
                            ? t("providerCurrentRemoval")
                            : undefined
                        }
                        onClick={() => {
                          setRemove(provider.id);
                          setRemoveError(null);
                        }}
                      >
                        {t("providerRemove")}
                      </button>
                    )}
                  </div>
                </div>
                {choice?.purpose === "use" &&
                  choice.provider === provider.id &&
                  chooser("use", provider.id)}
                {visited.includes(provider.id) && (
                  <div hidden={!open}>
                    {card(provider.id, provider.id, false, custom)}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
        {configuration && (
          <>
            <div hidden={!adding} className="models-add-card">
              <fieldset
                className="models-add-modes"
                aria-label={t("providerAddMode")}
                onKeyDown={(event) => {
                  if (
                    saving ||
                    !["ArrowLeft", "ArrowRight", "Home", "End"].includes(
                      event.key,
                    )
                  )
                    return;
                  event.preventDefault();
                  const enabled = addModes.filter((item) => item.available);
                  const index = enabled.findIndex((item) => item.id === mode);
                  const nextMode =
                    enabled[
                      event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? enabled.length - 1
                          : (index +
                              (event.key === "ArrowRight" ? 1 : -1) +
                              enabled.length) %
                            enabled.length
                    ].id;
                  selectAddMode(nextMode);
                  event.currentTarget
                    .querySelectorAll("button")
                    [
                      addModes.findIndex((item) => item.id === nextMode)
                    ]?.focus();
                }}
              >
                {addModes.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    aria-pressed={mode === item.id}
                    disabled={saving || !item.available}
                    onClick={() => selectAddMode(item.id)}
                  >
                    {t(item.label)}
                  </button>
                ))}
              </fieldset>
              <p className="models-hint">
                {t(
                  addModes.find((item) => item.id === mode)?.hint ??
                    "providerCustomHint",
                )}
              </p>
              <div hidden={mode !== "account"}>
                {selectedAccount && (
                  <div className="models-provider-select">
                    <Selector
                      label={t("provider")}
                      className="models-provider-picker"
                      options={accounts.map((provider) => ({
                        value: provider.id,
                        label: provider.name || provider.id,
                        icon: (
                          <ProviderIcon
                            id={provider.id}
                            name={provider.name || provider.id}
                          />
                        ),
                      }))}
                      value={selectedAccount.id}
                      isDisabled={saving}
                      placement="below"
                      onChange={(id: string) => {
                        setAccountId(id);
                        const key = `add:account:${id}`;
                        setVisited((previous) =>
                          previous.includes(key)
                            ? previous
                            : [...previous, key],
                        );
                      }}
                    />
                  </div>
                )}
                {visited
                  .filter((key) => key.startsWith("add:account:"))
                  .map((key) => (
                    <div
                      key={key}
                      hidden={key !== `add:account:${selectedAccount?.id}`}
                    >
                      {card(key, key.slice("add:account:".length), true, false)}
                    </div>
                  ))}
              </div>
              <div hidden={mode !== "catalog"}>
                {selectedCatalog && (
                  <div className="models-provider-select">
                    <Selector
                      label={t("provider")}
                      className="models-provider-picker"
                      options={available.map((provider) => ({
                        value: provider.id,
                        label: provider.name || provider.id,
                        icon: (
                          <ProviderIcon
                            id={provider.id}
                            name={provider.name || provider.id}
                          />
                        ),
                      }))}
                      value={selectedCatalog.id}
                      isDisabled={saving}
                      placement="below"
                      onChange={(id: string) => {
                        setCatalogId(id);
                        const key = `add:${id}`;
                        setVisited((previous) =>
                          previous.includes(key)
                            ? previous
                            : [...previous, key],
                        );
                      }}
                    />
                  </div>
                )}
                {visited
                  .filter(
                    (key) =>
                      key.startsWith("add:") &&
                      key !== "add:custom" &&
                      !key.startsWith("add:account:"),
                  )
                  .map((key) => (
                    <div
                      key={key}
                      hidden={key !== `add:${selectedCatalog?.id}`}
                    >
                      {card(key, key.slice(4), true, false)}
                    </div>
                  ))}
              </div>
              {visited.includes("add:custom") && (
                <div hidden={mode !== "custom"}>
                  {card("add:custom", "", true, true)}
                </div>
              )}
            </div>
            {!adding && (
              <button
                type="button"
                className="models-add-button"
                ref={addButton}
                disabled={saving}
                onClick={() => {
                  choiceReturnFocus.current = null;
                  setChoice(null);
                  setAdding(true);
                  setEditing(null);
                  setSaved(null);
                  selectAddMode(
                    addModes.find((item) => item.id === mode)?.available
                      ? mode
                      : addModes.find((item) => item.available)!.id,
                  );
                }}
              >
                <Plus aria-hidden="true" />
                {t("providerAdd")}
              </button>
            )}
          </>
        )}
        {busy && (
          <p className="models-hint" role="status">
            {t("modelSelectionBusy")}
          </p>
        )}
      </div>
      {remove && (
        <AlertDialog
          isOpen
          title={t("removeProvider", {
            provider:
              providers.find((provider) => provider.id === remove)?.name ||
              remove,
          })}
          description={removeError || t("providerRemoveDetail")}
          isActionLoading={saving}
          cancelLabel={t("cancel")}
          actionLabel={t(saving ? "savingSettings" : "providerRemove")}
          onOpenChange={(open: boolean) => {
            if (!open && !saving) setRemove(null);
          }}
          onAction={() => {
            if (saving || busy || !configuration) return;
            const controller = new AbortController();
            operation.current = controller;
            setRemoving(true);
            setRemoveError(null);
            void new WebClient()
              .changeProviderConfiguration(
                sessionId,
                configuration.revision,
                { action: "remove", provider: remove },
                controller.signal,
              )
              .then(
                () => {
                  if (controller.signal.aborted) return;
                  closeCard(remove);
                  setRemove(null);
                  refresh((value) => value + 1);
                  void onSaved().catch(() => false);
                },
                (error) => {
                  if (!controller.signal.aborted)
                    setRemoveError(
                      t(
                        error instanceof WebApiError &&
                          error.code === "MODEL_CONFIGURATION_CONFLICT"
                          ? "modelConfigurationConflict"
                          : "providerConfigurationFailed",
                      ),
                    );
                },
              )
              .finally(() => {
                if (!controller.signal.aborted) setRemoving(false);
              });
          }}
        />
      )}
    </div>
  );
}
