import { RuntimeInfoPanel } from "./RuntimeInfoPanel.tsx";
import { SettingsSelect } from "./SettingsSelect.tsx";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Button } from "@astryxdesign/core/Button";
import { Slider } from "@astryxdesign/core/Slider";
import { Switch } from "@astryxdesign/core/Switch";
import {
  Check,
  ChevronDown,
  Clipboard,
  Code2,
  CornerDownRight,
  Cpu,
  ExternalLink,
  FileText,
  FolderCog,
  Gauge,
  KeyRound,
  ListPlus,
  PanelBottom,
  Plug,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Terminal,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { WebCapabilitySnapshot } from "../../../../../extensions/shared/web-observer-registry.ts";
import type {
  WebModelSummary,
  WebSettingsCatalog,
  WebSettingsPluginSummary,
  WebSettingsPreferencesPatch,
  WebSettingsSkillSummary,
} from "../../../../protocol/types.ts";
import { copyText } from "../../lib/clipboard.ts";

const roles = ["explorer", "implementer", "reviewer", "advisor"] as const;

function SettingsLoadState({
  catalog,
  error,
  onRefresh,
}: {
  catalog: WebSettingsCatalog | null;
  error: string | null;
  onRefresh: () => void;
}) {
  const { t } = useTranslation();
  if (!error && !catalog) {
    return (
      <div className="settings-load-state" role="status">
        <RefreshCw className="settings-spin" aria-hidden="true" />
        <span>{t("settingsCatalogLoading")}</span>
      </div>
    );
  }
  if (!error) return null;
  return (
    <div className="settings-load-state error" role="alert">
      <strong>{t("settingsCatalogFailed")}</strong>
      <span>{error}</span>
      <button type="button" onClick={onRefresh}>
        {t("retryAdmissionCheck")}
      </button>
    </div>
  );
}

function SettingsToggleRow({
  icon: Icon,
  title,
  description,
  value,
  disabled,
  loading,
  onChange,
}: {
  icon: LucideIcon;
  title: string;
  description?: string;
  value: boolean;
  disabled: boolean;
  loading: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="settings-inline-control settings-toggle-row">
      <Icon aria-hidden="true" />
      <span className="settings-inline-copy">
        <strong>{title}</strong>
        {description && <small>{description}</small>}
      </span>
      <Switch
        label={title}
        isLabelHidden
        value={value}
        size="sm"
        isDisabled={disabled}
        isLoading={loading}
        onChange={onChange}
      />
    </div>
  );
}

function SetupAction({
  isPending,
  isBlocked = false,
  onConfigure,
  request,
  label,
}: {
  isPending: boolean;
  isBlocked?: boolean;
  onConfigure: (request: string) => Promise<boolean>;
  request: string;
  label: string;
}) {
  return (
    <Button
      label={label}
      variant="secondary"
      size="sm"
      icon={<Wrench aria-hidden="true" />}
      isDisabled={isPending || isBlocked}
      isLoading={isPending}
      onClick={() => void onConfigure(request)}
    />
  );
}

function SetupRequestForm({
  pending,
  onConfigure,
  placeholder,
}: {
  pending: boolean;
  onConfigure: (request: string) => Promise<boolean>;
  placeholder: string;
}) {
  const { t } = useTranslation();
  const [request, setRequest] = useState("");
  return (
    <form
      className="settings-edit-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!pending && request.trim()) void onConfigure(request.trim());
      }}
    >
      <label className="settings-form-field">
        {t("setupConfigurationRequest")}
        <textarea
          required
          maxLength={2000}
          value={request}
          disabled={pending}
          placeholder={placeholder}
          onChange={(event) => setRequest(event.target.value)}
        />
      </label>
      <button type="submit" disabled={pending || !request.trim()}>
        {t("configureViaSetup")}
      </button>
      <small>{t("setupFormDetail")}</small>
    </form>
  );
}

export function GeneralSettingsPanel({
  catalog,
  error,
  currentModel,
  thinkingLevel,
  cwd,
  setupPending,
  setupBlocked = false,
  preferencePending,
  setupBusy,
  setupBlockedReason,
  onConfigure,
  onUpdatePreferences,
  onOpenRuntimeStatus,
  onRefresh,
}: {
  catalog: WebSettingsCatalog | null;
  error: string | null;
  currentModel?: WebModelSummary;
  thinkingLevel: string;
  cwd: string;
  setupPending: boolean;
  setupBlocked?: boolean;
  preferencePending: boolean;
  setupBusy: boolean;
  setupBlockedReason?: string;
  onConfigure: (request: string) => Promise<boolean>;
  onUpdatePreferences: (patch: WebSettingsPreferencesPatch) => Promise<boolean>;
  onOpenRuntimeStatus: () => void;
  onRefresh: () => void;
}) {
  const { t } = useTranslation();
  const setup = catalog?.setup;
  const configuredConcurrency = setup?.workflows.concurrency ?? 0;
  const configuredCalls = setup?.workflows.maxAgentCalls ?? 0;
  const [concurrency, setConcurrency] = useState(configuredConcurrency);
  const [maxCalls, setMaxCalls] = useState(configuredCalls);

  useEffect(
    () => setConcurrency(configuredConcurrency),
    [configuredConcurrency],
  );
  useEffect(() => setMaxCalls(configuredCalls), [configuredCalls]);

  return (
    <section className="settings-content-page settings-general-panel">
      <div className="settings-page-heading">
        <div>
          <h1>{t("generalSettings")}</h1>
        </div>
        <SetupAction
          isPending={setupPending}
          isBlocked={setupBlocked}
          onConfigure={onConfigure}
          request={t("setupRequestReviewAll")}
          label={t("configureOpenPi")}
        />
      </div>

      {setupBusy && (
        <p className="settings-pending-hint" role="status">
          {setupBlockedReason || t("settingsSetupBusyHint")}
        </p>
      )}

      <SettingsLoadState
        catalog={catalog}
        error={error}
        onRefresh={onRefresh}
      />
      {setup && (
        <>
          <section className="settings-section-block">
            <div className="settings-follow-up-control">
              <div>
                <h2>{t("followUpBehavior")}</h2>
                <p>{t("followUpBehaviorDetail")}</p>
              </div>
              <fieldset
                className="settings-follow-up-choices"
                disabled={preferencePending}
              >
                <legend className="sr-only">{t("followUpBehavior")}</legend>
                {(["followUp", "steer"] as const).map((mode) => (
                  <label key={mode}>
                    <input
                      type="radio"
                      name="follow-up-behavior"
                      value={mode}
                      aria-label={t(
                        mode === "steer" ? "followUpSteer" : "followUpQueue",
                      )}
                      checked={
                        (setup.ui.webFollowUpBehavior ?? "followUp") === mode
                      }
                      onChange={() =>
                        void onUpdatePreferences({ followUpBehavior: mode })
                      }
                    />
                    <span className="settings-follow-up-option">
                      {mode === "steer" ? (
                        <CornerDownRight aria-hidden="true" />
                      ) : (
                        <ListPlus aria-hidden="true" />
                      )}
                      <span className="settings-follow-up-option-copy">
                        <strong>
                          {t(
                            mode === "steer"
                              ? "followUpSteer"
                              : "followUpQueue",
                          )}
                        </strong>
                        <small>
                          {t(
                            mode === "steer"
                              ? "followUpSteerDetail"
                              : "followUpQueueDetail",
                          )}
                        </small>
                      </span>
                    </span>
                  </label>
                ))}
              </fieldset>
            </div>
          </section>
          <section className="settings-section-block">
            <h2>{t("agentBehavior")}</h2>
            <div className="settings-chat-controls">
              <form
                className="settings-limits-control"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!setupPending && !setupBlocked)
                    void onConfigure(
                      t("setupRequestLimits", { concurrency, calls: maxCalls }),
                    );
                }}
              >
                <span>
                  <Gauge aria-hidden="true" />
                  {t("workflowLimits")}
                </span>
                <small>
                  {t("workflowLimitsValue", {
                    concurrency: setup.workflows.concurrency,
                    calls: setup.workflows.maxAgentCalls,
                  })}
                </small>
                <label>
                  {t("workflowConcurrency")}
                  <input
                    type="number"
                    min={1}
                    value={concurrency}
                    disabled={setupPending || setupBlocked}
                    onChange={(event) =>
                      setConcurrency(Number(event.target.value))
                    }
                    required
                  />
                </label>
                <label>
                  {t("workflowCalls")}
                  <input
                    type="number"
                    min={1}
                    value={maxCalls}
                    disabled={setupPending || setupBlocked}
                    onChange={(event) =>
                      setMaxCalls(Number(event.target.value))
                    }
                    required
                  />
                </label>
                <button
                  type="submit"
                  disabled={
                    setupPending ||
                    setupBlocked ||
                    (concurrency === setup.workflows.concurrency &&
                      maxCalls === setup.workflows.maxAgentCalls)
                  }
                >
                  {t("configureViaSetup")}
                </button>
              </form>
              <SettingsToggleRow
                icon={Sparkles}
                title={t("nextActionSuggestions")}
                description={t("nextActionSuggestionsDetail")}
                value={setup.suggestions.enabled}
                disabled={setupPending || setupBlocked}
                loading={setupPending}
                onChange={(checked: boolean) =>
                  void onConfigure(
                    t(
                      checked
                        ? "setupRequestEnableSuggestions"
                        : "setupRequestDisableSuggestions",
                    ),
                  )
                }
              />
              {setup.suggestions.model && (
                <small>{`${setup.suggestions.model.provider}/${setup.suggestions.model.model} · ${setup.suggestions.model.reasoning}`}</small>
              )}
              <div className="settings-inline-control">
                <Code2 aria-hidden="true" />
                <span className="settings-inline-copy">
                  <strong>
                    {t("postEditCommand")}
                    <span className="settings-inline-status">
                      {t(setup.postEditConfigured ? "configured" : "disabled")}
                    </span>
                  </strong>
                  <small>{t("postEditCommandDetail")}</small>
                </span>
                <SetupAction
                  isPending={setupPending}
                  isBlocked={setupBlocked}
                  onConfigure={onConfigure}
                  request={t("setupRequestPostEdit")}
                  label={t("configurePostEdit")}
                />
              </div>
              <small>{t("agentSettingsSetupHint")}</small>
            </div>
          </section>

          <section className="settings-section-block">
            <h2>{t("resultDisplay")}</h2>
            <div className="settings-chat-controls">
              {(
                [
                  ["subagentResultDisplay", "subagentResults", Cpu],
                  ["bashToolDisplay", "bashOperations", Terminal],
                  ["fileMutationDisplay", "fileMutations", FileText],
                ] as const
              ).map(([key, label, Icon]) => (
                <label
                  key={key}
                  className="settings-inline-control"
                  htmlFor={`settings-${key}`}
                >
                  <Icon aria-hidden="true" />
                  <span className="settings-inline-copy">
                    <strong>{t(label)}</strong>
                  </span>
                  <SettingsSelect
                    id={`settings-${key}`}
                    className="settings-select-control"
                    label={t(label)}
                    value={setup.ui[key]}
                    disabled={preferencePending}
                    onChange={(value) => {
                      if (value === "full" || value === "compact")
                        void onUpdatePreferences({ [key]: value });
                    }}
                    options={[
                      {
                        value: "compact",
                        label: t("detailDisplay_compact"),
                      },
                      { value: "full", label: t("detailDisplay_full") },
                    ]}
                  />
                </label>
              ))}
              <SettingsToggleRow
                icon={PanelBottom}
                title={t("terminalFooter")}
                value={setup.ui.customFooter}
                disabled={preferencePending}
                loading={preferencePending}
                onChange={(checked: boolean) =>
                  void onUpdatePreferences({ customFooter: checked })
                }
              />
              <label
                className="settings-inline-control"
                htmlFor="settings-footer-style"
              >
                <span>{t("terminalFooterStyle")}</span>
                <SettingsSelect
                  id="settings-footer-style"
                  className="settings-select-control"
                  label={t("terminalFooterStyle")}
                  value={setup.ui.footerStyle}
                  disabled={preferencePending || !setup.ui.customFooter}
                  onChange={(value) => {
                    if (
                      value === "plain" ||
                      value === "powerline" ||
                      value === "powerline-mono"
                    )
                      void onUpdatePreferences({ footerStyle: value });
                  }}
                  options={[
                    { value: "plain", label: "Plain" },
                    { value: "powerline", label: "Powerline" },
                    { value: "powerline-mono", label: "Powerline Mono" },
                  ]}
                />
              </label>
              <small>{t("terminalFooterHint")}</small>
            </div>
          </section>
        </>
      )}

      <RuntimeInfoPanel />

      <section className="settings-section-block">
        <h2>{t("sessionSettings")}</h2>
        <dl className="settings-summary-list">
          <div>
            <dt>{t("selectedModel")}</dt>
            <dd>{currentModel?.label ?? t("noModels")}</dd>
          </div>
          <div>
            <dt>{t("thinkingLevel")}</dt>
            <dd>{thinkingLevel}</dd>
          </div>
          <div>
            <dt>{t("currentWorkspace")}</dt>
            <dd title={cwd}>{cwd}</dd>
          </div>
        </dl>
        <Button
          label={t("openRuntimeDetails")}
          variant="secondary"
          size="sm"
          icon={<FolderCog aria-hidden="true" />}
          className="settings-runtime-action"
          onClick={onOpenRuntimeStatus}
        />
      </section>
    </section>
  );
}

function resourceSourceLabel(source: string) {
  const parts = source.split(/[\\/]/u).filter(Boolean);
  return parts.at(-1) || source;
}

function ResourceToolbar({
  kind,
  query,
  scope,
  onQuery,
  onScope,
  onAdd,
}: {
  kind: "skills" | "plugins";
  query: string;
  scope: string;
  onQuery: (value: string) => void;
  onScope: (value: string) => void;
  onAdd: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="settings-resource-toolbar">
      <div className="settings-resource-toolbar-heading">
        <strong>{t("resources")}</strong>
        <Button
          label={t(kind === "skills" ? "addSkill" : "addPlugin")}
          variant="secondary"
          size="sm"
          icon={<Plus aria-hidden="true" />}
          onClick={onAdd}
        />
      </div>
      <label className="settings-resource-search">
        <Search aria-hidden="true" />
        <input
          type="search"
          aria-label={t("searchResources")}
          placeholder={t("searchResources")}
          value={query}
          onChange={(event) => onQuery(event.target.value)}
        />
      </label>
      <SettingsSelect
        label={t("filterResourceScope")}
        value={scope}
        onChange={onScope}
        options={[
          { value: "all", label: t("allResourceScopes") },
          ...(["project", "user", "temporary"] as const).map((value) => ({
            value,
            label: t(`resourceScope_${value}`),
          })),
        ]}
      />
    </div>
  );
}

function ResourceInstallForm({
  kind,
  pending,
  onConfigure,
  onCancel,
}: {
  kind: "skills" | "plugins";
  pending: boolean;
  onConfigure: (request: string) => Promise<boolean>;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [source, setSource] = useState("");
  const [scope, setScope] = useState("user");
  return (
    <section className="settings-resource-install">
      <header className="settings-detail-heading">
        <div>
          <h2>{t(kind === "skills" ? "addSkill" : "addPlugin")}</h2>
          <p>{t("resourceInstallIntro")}</p>
        </div>
      </header>
      <form
        className="settings-edit-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!pending && source.trim())
            void onConfigure(
              t("setupResourceInstallRequest", {
                kind: t(
                  kind === "skills" ? "skillsSettings" : "pluginsSettings",
                ),
                source: JSON.stringify(source.trim()),
                scope,
              }),
            );
        }}
      >
        <label className="settings-form-field">
          {t("resourcePackageSource")}
          <input
            required
            maxLength={1000}
            value={source}
            placeholder={t("resourcePackageSourcePlaceholder")}
            disabled={pending}
            onChange={(event) => {
              setSource(event.target.value);
            }}
          />
        </label>
        <label className="settings-form-field" htmlFor="resource-install-scope">
          {t("scope")}
          <SettingsSelect
            id="resource-install-scope"
            label={t("scope")}
            value={scope}
            disabled={pending}
            onChange={setScope}
            options={[
              { value: "user", label: t("resourceScope_user") },
              { value: "project", label: t("resourceScope_project") },
            ]}
          />
        </label>
        <div className="settings-resource-actions">
          <Button
            type="submit"
            label={t("configureViaSetup")}
            variant="secondary"
            size="sm"
            isDisabled={pending || !source.trim()}
          />
          <Button
            label={t("cancel")}
            variant="ghost"
            size="sm"
            onClick={onCancel}
          />
        </div>
        <small>{t("resourceInstallReview")}</small>
      </form>
      {kind === "skills" && (
        <a
          className="settings-resource-link"
          href="https://skills.sh"
          target="_blank"
          rel="noreferrer"
        >
          {t("browseSkills")}
          <ExternalLink aria-hidden="true" />
        </a>
      )}
    </section>
  );
}

function ResourceFooter({
  catalog,
  pending,
  onReload,
  kind,
  onConfigure,
  children,
}: {
  catalog: WebSettingsCatalog | null;
  pending: boolean;
  onReload?: () => Promise<void>;
  kind: "skills" | "plugins";
  onConfigure: (request: string) => Promise<boolean>;
  children?: import("react").ReactNode;
}) {
  const { t } = useTranslation();
  const [review, setReview] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  return (
    <section className="settings-resource-management">
      {children && <div className="settings-resource-actions">{children}</div>}
      <div className="settings-resource-reload">
        <div>
          <strong>{t("resourceSessionState")}</strong>
          <p>{t("resourcesReloadNote")}</p>
        </div>
        <Button
          label={t("reloadResources")}
          variant="secondary"
          size="sm"
          icon={<RefreshCw aria-hidden="true" />}
          isDisabled={
            pending || reloading || !catalog?.sessionPath || !onReload
          }
          isLoading={reloading}
          onClick={() => setReview(true)}
        />
      </div>
      {result && (
        <p className="settings-resource-notice" role="status">
          {result}
        </p>
      )}
      <details className="settings-resource-advanced">
        <summary>{t("advancedResourceConfiguration")}</summary>
        <SetupRequestForm
          pending={pending}
          onConfigure={onConfigure}
          placeholder={t(
            kind === "skills"
              ? "setupSkillsPlaceholder"
              : "setupPluginsPlaceholder",
          )}
        />
      </details>
      {review && (
        <AlertDialog
          isOpen
          onOpenChange={setReview}
          title={t("reloadResources")}
          description={t("resourceReloadReview")}
          cancelLabel={t("cancel")}
          actionLabel={t("reloadResources")}
          onAction={() => {
            setReview(false);
            setReloading(true);
            setResult(null);
            void onReload?.()
              .then(
                () => setResult(t("resourceReloaded")),
                (error: unknown) =>
                  setResult(
                    error instanceof Error
                      ? error.message
                      : t("resourceReloadFailed"),
                  ),
              )
              .finally(() => setReloading(false));
          }}
        />
      )}
    </section>
  );
}

function ResourceDiagnostics({
  catalog,
}: {
  catalog: WebSettingsCatalog | null;
}) {
  const { t } = useTranslation();
  if (!catalog) return null;
  const { diagnostics, truncation } = catalog.resources;
  if (
    !diagnostics.settingsErrors &&
    !diagnostics.extensionErrors &&
    !diagnostics.skillErrors &&
    !truncation.truncated
  )
    return null;
  return (
    <p className="settings-resource-notice" role="status">
      {t("resourceDiagnostics", diagnostics)}
      {diagnostics.settingsErrors
        ? ` ${t("resourceConfigurationDiagnostics", { count: diagnostics.settingsErrors })}`
        : ""}
      {truncation.truncated && ` ${t("resourceCatalogTruncated")}`}
    </p>
  );
}

export function SkillsSettingsPanel({
  catalog,
  error,
  onRefresh,
  setupPending,
  onConfigure,
  onReload,
}: {
  catalog: WebSettingsCatalog | null;
  error: string | null;
  onRefresh: () => void;
  setupPending: boolean;
  onConfigure: (request: string) => Promise<boolean>;
  onReload?: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const skills = catalog?.resources.skills ?? [];
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState("all");
  const [adding, setAdding] = useState(false);
  const filtered = useMemo(
    () =>
      skills.filter(
        (skill) =>
          (scope === "all" || skill.scope === scope) &&
          `${skill.name} ${skill.description} ${skill.source}`
            .toLocaleLowerCase()
            .includes(query.trim().toLocaleLowerCase()),
      ),
    [skills, query, scope],
  );
  const skillGroups = useMemo(() => {
    const order = ["project", "user", "temporary"] as const;
    return order
      .map((scope) => ({
        scope,
        skills: filtered.filter((skill) => skill.scope === scope),
      }))
      .filter((group) => group.skills.length > 0);
  }, [filtered]);
  const [selectedId, setSelectedId] = useState("");
  const [copyStatus, setCopyStatus] = useState<"copied" | "failed" | null>(
    null,
  );
  const selected =
    filtered.find((skill) => skill.id === selectedId) ?? filtered[0];
  const manageable = filtered.filter((skill) => skill.canManage !== false);
  const bulkPaths = JSON.stringify(manageable.map((skill) => skill.filePath));
  const bulkTooLarge = new TextEncoder().encode(bulkPaths).length > 12_000;

  useEffect(() => {
    if (skills.length && !skills.some((skill) => skill.id === selectedId)) {
      setSelectedId(skills[0]!.id);
    }
  }, [selectedId, skills]);

  const copyInvocation = (skill: WebSettingsSkillSummary) => {
    setCopyStatus(null);
    void copyText(`/skill:${skill.name} `).then((success) =>
      setCopyStatus(success ? "copied" : "failed"),
    );
  };

  return (
    <section className="settings-content-page settings-managed-panel">
      <header className="settings-page-heading">
        <div>
          <h1>{t("skillsSettings")}</h1>
          <p>{t("skillsEmptyIntro")}</p>
        </div>
      </header>
      <aside className="settings-resource-sidebar">
        <ResourceToolbar
          kind="skills"
          query={query}
          scope={scope}
          onQuery={setQuery}
          onScope={setScope}
          onAdd={() => setAdding(true)}
        />
        <div className="settings-resource-list">
          {skillGroups.map((group) => (
            <section className="settings-resource-group" key={group.scope}>
              <span className="settings-sidebar-label">
                {t(`resourceScope_${group.scope}`)}
              </span>
              {group.skills.map((skill) => (
                <button
                  key={skill.id}
                  type="button"
                  className="settings-resource-item"
                  aria-current={skill.id === selected?.id ? "page" : undefined}
                  onClick={() => {
                    setSelectedId(skill.id);
                    setCopyStatus(null);
                    setAdding(false);
                  }}
                >
                  <Sparkles aria-hidden="true" />
                  <span>
                    <strong>{skill.name}</strong>
                    <small>
                      {t(
                        skill.disableModelInvocation
                          ? "explicitOnly"
                          : "availableToModel",
                      )}
                    </small>
                  </span>
                </button>
              ))}
            </section>
          ))}
          {!catalog && !error && (
            <SettingsLoadState
              catalog={catalog}
              error={error}
              onRefresh={onRefresh}
            />
          )}
          {catalog && !filtered.length && (
            <p className="settings-resource-empty">
              {t(skills.length ? "noMatchingResources" : "noSkillsFound")}
            </p>
          )}
        </div>
        <div className="settings-sidebar-footer">
          <span>{t("skillCount", { count: skills.length })}</span>
          <button
            type="button"
            aria-label={t("refreshStatus")}
            onClick={onRefresh}
          >
            <RefreshCw aria-hidden="true" />
          </button>
        </div>
      </aside>
      <div className="settings-resource-detail">
        <ResourceDiagnostics catalog={catalog} />
        {adding ? (
          <ResourceInstallForm
            kind="skills"
            pending={setupPending}
            onConfigure={onConfigure}
            onCancel={() => setAdding(false)}
          />
        ) : error ? (
          <SettingsLoadState
            catalog={catalog}
            error={error}
            onRefresh={onRefresh}
          />
        ) : selected ? (
          <>
            <header className="settings-detail-heading">
              <div>
                <h2>{selected.name}</h2>
                <p>{selected.description}</p>
              </div>
              <Button
                label={
                  copyStatus === "copied"
                    ? t("copiedMessage")
                    : t("copySkillInvocation")
                }
                variant="secondary"
                size="sm"
                icon={copyStatus === "copied" ? <Check /> : <Clipboard />}
                onClick={() => copyInvocation(selected)}
              />
            </header>
            <dl className="settings-detail-metadata">
              <div>
                <dt>{t("source")}</dt>
                <dd>
                  {selected.source === "auto"
                    ? t("resourceSourceAuto")
                    : selected.source === "local"
                      ? t("resourceSourceLocal")
                      : selected.source === "builtin"
                        ? t("builtIn")
                        : selected.source}
                </dd>
              </div>
              <div>
                <dt>{t("scope")}</dt>
                <dd>{t(`resourceScope_${selected.scope}`)}</dd>
              </div>
              <div>
                <dt>{t("invocation")}</dt>
                <dd>
                  <code>{`/skill:${selected.name}`}</code>
                </dd>
              </div>
              <div>
                <dt>{t("modelInvocation")}</dt>
                <dd>
                  {t(
                    selected.disableModelInvocation
                      ? "explicitOnly"
                      : "availableToModel",
                  )}
                </dd>
              </div>
            </dl>
            <section className="settings-path-block">
              <FileText aria-hidden="true" />
              <div>
                <strong>{t("skillFile")}</strong>
                <code>{selected.filePath}</code>
              </div>
            </section>
            <div className="settings-resource-actions">
              <SetupAction
                isPending={setupPending}
                isBlocked={selected.canManage === false}
                onConfigure={onConfigure}
                label={t(
                  selected.disableModelInvocation
                    ? "enableSkillInvocation"
                    : "disableSkillInvocation",
                )}
                request={t("setupSkillInvocationRequest", {
                  path: selected.filePath,
                  disabled: !selected.disableModelInvocation,
                })}
              />
              <SetupAction
                isPending={setupPending}
                isBlocked={selected.canManage === false}
                onConfigure={onConfigure}
                label={t("updateResource")}
                request={t("setupSkillManageRequest", {
                  action: "update",
                  path: JSON.stringify(selected.filePath),
                  source: JSON.stringify(selected.source),
                  scope: selected.scope,
                })}
              />
              <SetupAction
                isPending={setupPending}
                isBlocked={selected.canManage === false}
                onConfigure={onConfigure}
                label={t("removeResource")}
                request={t("setupSkillManageRequest", {
                  action: "remove",
                  path: JSON.stringify(selected.filePath),
                  source: JSON.stringify(selected.source),
                  scope: selected.scope,
                })}
              />
            </div>
            {selected.canManage === false && (
              <p className="settings-resource-notice">
                {t("resourceTargetTruncated")}
              </p>
            )}
            {copyStatus === "failed" && (
              <p className="inspection-warning">{t("copyFailed")}</p>
            )}
          </>
        ) : (
          <div className="settings-empty-detail">
            <Sparkles aria-hidden="true" />
            <h2>
              {t(skills.length ? "noMatchingResources" : "skillsEmptyTitle")}
            </h2>
            <Button
              label={t("addSkill")}
              variant="secondary"
              size="sm"
              icon={<Plus aria-hidden="true" />}
              onClick={() => setAdding(true)}
            />
          </div>
        )}
        {!adding && (
          <ResourceFooter
            catalog={catalog}
            pending={setupPending}
            onReload={onReload}
            kind="skills"
            onConfigure={onConfigure}
          >
            {manageable.length > 1 && (
              <>
                <SetupAction
                  isPending={setupPending}
                  isBlocked={bulkTooLarge}
                  onConfigure={onConfigure}
                  label={t("enableVisibleSkills", { count: manageable.length })}
                  request={t("setupSkillsBulkRequest", {
                    paths: bulkPaths,
                    disabled: false,
                  })}
                />
                <SetupAction
                  isPending={setupPending}
                  isBlocked={bulkTooLarge}
                  onConfigure={onConfigure}
                  label={t("disableVisibleSkills", {
                    count: manageable.length,
                  })}
                  request={t("setupSkillsBulkRequest", {
                    paths: bulkPaths,
                    disabled: true,
                  })}
                />
              </>
            )}
            {bulkTooLarge && (
              <p className="settings-resource-caption">
                {t("resourceBulkTooLarge")}
              </p>
            )}
          </ResourceFooter>
        )}
      </div>
    </section>
  );
}

export function SubagentsSettingsPanel({
  catalog,
  error,
  currentModel,
  models,
  activity,
  setupPending,
  setupBlocked = false,
  onConfigure,
  onRefresh,
}: {
  catalog: WebSettingsCatalog | null;
  error: string | null;
  currentModel?: WebModelSummary;
  models: WebModelSummary[];
  activity?: WebCapabilitySnapshot["subagents"];
  setupPending: boolean;
  setupBlocked?: boolean;
  onConfigure: (request: string) => Promise<boolean>;
  onRefresh: () => void;
}) {
  const { t } = useTranslation();
  const [selectedRole, setSelectedRole] =
    useState<(typeof roles)[number]>("explorer");
  const assignment = catalog?.setup.subagents.roleModels[selectedRole];
  const [roleModel, setRoleModel] = useState("");
  const [concurrency, setConcurrency] = useState(1);
  useEffect(() => {
    const assignment = catalog?.setup.subagents.roleModels[selectedRole];
    setRoleModel(
      assignment ? `${assignment.provider}/${assignment.model}` : "",
    );
    setConcurrency(catalog?.setup.workflows.concurrency ?? 1);
  }, [selectedRole, catalog]);
  const active =
    activity?.items.filter((item) => item.status === "running").length ?? 0;
  const completed =
    activity?.items.filter((item) => item.status !== "running").length ?? 0;

  return (
    <section className="settings-content-page settings-subagents-panel">
      <header className="settings-page-heading">
        <div>
          <h1>{t("subagentsSettings")}</h1>
          <p>{t("subagentConfigurationIntro")}</p>
        </div>
        <SetupAction
          isPending={setupPending}
          isBlocked={setupBlocked}
          onConfigure={onConfigure}
          request={t("setupRequestSubagents")}
          label={t("configureRoles")}
        />
      </header>
      <SettingsLoadState
        catalog={catalog}
        error={error}
        onRefresh={onRefresh}
      />
      <div className="settings-control-group">
        <label className="settings-control-row" htmlFor="subagent-role">
          <span className="settings-control-copy">
            <strong>{t("builtInRoles")}</strong>
            <span>{t(`subagentRoleShort_${selectedRole}`)}</span>
          </span>
          <SettingsSelect
            id="subagent-role"
            name="subagentRole"
            label={t("builtInRoles")}
            value={selectedRole}
            onChange={(value) => {
              const role = roles.find((item) => item === value);
              if (role) setSelectedRole(role);
            }}
            options={roles.map((role) => ({
              value: role,
              label: t(`subagentRole_${role}`),
            }))}
          />
        </label>
      </div>
      <div className="settings-role-detail">
        {catalog && (
          <>
            <header className="settings-detail-heading">
              <div>
                <h2>{t(`subagentRole_${selectedRole}`)}</h2>
                <p>{t(`subagentRoleDescription_${selectedRole}`)}</p>
              </div>
            </header>
            <form
              className="settings-edit-form settings-role-form"
              onSubmit={(event) => {
                event.preventDefault();
                if (setupPending || setupBlocked) return;
                void onConfigure(
                  t("setupRoleFormRequest", {
                    role: selectedRole,
                    model: roleModel || t("inheritParentModel"),
                    concurrency,
                  }),
                );
              }}
            >
              <div className="settings-control-group">
                <label className="settings-control-row" htmlFor="role-model">
                  <span className="settings-control-copy">
                    <strong>{t("modelAssignment")}</strong>
                  </span>
                  <SettingsSelect
                    id="role-model"
                    name="roleModel"
                    label={t("modelAssignment")}
                    value={roleModel}
                    disabled={setupPending || setupBlocked}
                    onChange={setRoleModel}
                    menuWidth="min(380px, calc(100vw - 32px))"
                    options={[
                      { value: "", label: t("inheritParentModel") },
                      ...(roleModel &&
                      !models.some(
                        (model) =>
                          `${model.provider}/${model.id}` === roleModel,
                      )
                        ? [{ value: roleModel, label: roleModel }]
                        : []),
                      ...models.map((model) => ({
                        value: `${model.provider}/${model.id}`,
                        label: model.label,
                      })),
                    ]}
                  />
                </label>
                <div className="settings-control-row">
                  <span className="settings-control-copy">
                    <strong>{t("effectiveModel")}</strong>
                  </span>
                  <span className="settings-control-value">
                    {assignment
                      ? `${assignment.provider}/${assignment.model}`
                      : (currentModel?.label ?? t("unknownState"))}
                  </span>
                </div>
                <label className="settings-control-row">
                  <span className="settings-control-copy">
                    <strong>{t("workflowConcurrencyLabel")}</strong>
                  </span>
                  <input
                    name="concurrency"
                    type="number"
                    autoComplete="off"
                    min={1}
                    max={64}
                    required
                    value={concurrency}
                    disabled={setupPending || setupBlocked}
                    onChange={(event) =>
                      setConcurrency(Number(event.target.value))
                    }
                  />
                </label>
                <div className="settings-control-row">
                  <span className="settings-control-copy">
                    <strong>{t("workflowCallLimit")}</strong>
                  </span>
                  <span className="settings-control-value">
                    {catalog.setup.workflows.maxAgentCalls}
                  </span>
                </div>
              </div>
              <button type="submit" disabled={setupPending || setupBlocked}>
                {t("configureViaSetup")}
              </button>
              <small className="settings-resource-caption">
                {t("setupFormDetail")}
              </small>
            </form>
            <section className="settings-role-principles">
              <h2>{t("runtimeBoundaries")}</h2>
              <div className="settings-control-group">
                <div className="settings-control-row">
                  <KeyRound aria-hidden="true" />
                  <p>{t("subagentAuthorityNote")}</p>
                </div>
                <div className="settings-control-row">
                  <Cpu aria-hidden="true" />
                  <p>{t("subagentModelNote")}</p>
                </div>
              </div>
              <p className="settings-resource-caption">
                {t("subagentActiveCount", { count: active })} ·{" "}
                {t("subagentCompletedCount", { count: completed })}
              </p>
            </section>
          </>
        )}
      </div>
    </section>
  );
}

function pluginCount(plugin: WebSettingsPluginSummary) {
  return (
    plugin.extensions.length +
    plugin.skills.length +
    plugin.prompts.length +
    plugin.themes.length
  );
}

function pluginState(plugin: WebSettingsPluginSummary) {
  if (plugin.enabled === false) return "disabled";
  if (plugin.configured && !plugin.installed) return "missing";
  if (plugin.diagnostics?.length) return "error";
  if (pluginCount(plugin)) return "loaded";
  return plugin.installed ? "installed" : "notLoaded";
}

export function PluginsSettingsPanel({
  catalog,
  error,
  onRefresh,
  setupPending,
  onConfigure,
  onReload,
}: {
  catalog: WebSettingsCatalog | null;
  error: string | null;
  onRefresh: () => void;
  setupPending: boolean;
  onConfigure: (request: string) => Promise<boolean>;
  onReload?: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const plugins = catalog?.resources.plugins ?? [];
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState("all");
  const [adding, setAdding] = useState(false);
  const filtered = useMemo(
    () =>
      plugins.filter(
        (plugin) =>
          (scope === "all" || plugin.scope === scope) &&
          `${plugin.name ?? ""} ${plugin.source}`
            .toLocaleLowerCase()
            .includes(query.trim().toLocaleLowerCase()),
      ),
    [plugins, query, scope],
  );
  const [selectedId, setSelectedId] = useState("");
  const selected =
    filtered.find((plugin) => plugin.id === selectedId) ?? filtered[0];
  const manageable = filtered.filter(
    (plugin) => plugin.configured && plugin.canManage !== false,
  );
  const sourceLabel = (plugin: WebSettingsPluginSummary) =>
    plugin.name ??
    (plugin.source === "auto"
      ? t("resourceSourceAuto")
      : plugin.source === "builtin"
        ? t("builtIn")
        : resourceSourceLabel(plugin.source));
  const bulkPackages = JSON.stringify(
    manageable.map(({ source, scope, baseDir }) => ({
      source,
      scope,
      path: baseDir,
    })),
  );
  const bulkTooLarge = new TextEncoder().encode(bulkPackages).length > 12_000;

  useEffect(() => {
    if (plugins.length && !plugins.some((plugin) => plugin.id === selectedId)) {
      setSelectedId(plugins[0]!.id);
    }
  }, [plugins, selectedId]);

  return (
    <section className="settings-content-page settings-managed-panel">
      <header className="settings-page-heading">
        <div>
          <h1>{t("pluginsSettings")}</h1>
          <p>{t("pluginsEmptyIntro")}</p>
        </div>
      </header>
      <aside className="settings-resource-sidebar">
        <ResourceToolbar
          kind="plugins"
          query={query}
          scope={scope}
          onQuery={setQuery}
          onScope={setScope}
          onAdd={() => setAdding(true)}
        />
        <div className="settings-resource-list">
          {filtered.map((plugin) => (
            <button
              key={plugin.id}
              type="button"
              className="settings-resource-item"
              aria-current={plugin.id === selected?.id ? "page" : undefined}
              onClick={() => {
                setSelectedId(plugin.id);
                setAdding(false);
              }}
            >
              <Plug aria-hidden="true" />
              <span>
                <strong>{sourceLabel(plugin)}</strong>
                <small>
                  {t(`resourceScope_${plugin.scope}`)} ·{" "}
                  {t(`pluginState_${pluginState(plugin)}`)}
                </small>
              </span>
            </button>
          ))}
          {!catalog && !error && (
            <SettingsLoadState
              catalog={catalog}
              error={error}
              onRefresh={onRefresh}
            />
          )}
          {catalog && !filtered.length && (
            <p className="settings-resource-empty">
              {t(plugins.length ? "noMatchingResources" : "noPluginsFound")}
            </p>
          )}
        </div>
        <div className="settings-sidebar-footer">
          <span>
            {catalog
              ? t("pluginCount", { count: plugins.length })
              : t("settingsCatalogLoading")}
          </span>
          <button
            type="button"
            aria-label={t("refreshStatus")}
            onClick={onRefresh}
          >
            <RefreshCw aria-hidden="true" />
          </button>
        </div>
      </aside>
      <div className="settings-resource-detail">
        <ResourceDiagnostics catalog={catalog} />
        {adding ? (
          <ResourceInstallForm
            kind="plugins"
            pending={setupPending}
            onConfigure={onConfigure}
            onCancel={() => setAdding(false)}
          />
        ) : error ? (
          <SettingsLoadState
            catalog={catalog}
            error={error}
            onRefresh={onRefresh}
          />
        ) : selected ? (
          <>
            <header className="settings-detail-heading">
              <div>
                <h2>{sourceLabel(selected)}</h2>
                <code>{selected.source}</code>
              </div>
              <span
                className={`settings-status-badge ${pluginState(selected) === "loaded" ? "healthy" : ""}`}
              >
                {t(`pluginState_${pluginState(selected)}`)}
              </span>
            </header>
            <dl className="settings-detail-metadata settings-detail-metadata-wide">
              <div>
                <dt>{t("scope")}</dt>
                <dd>{t(`resourceScope_${selected.scope}`)}</dd>
              </div>
              <div>
                <dt>{t("resourceOrigin")}</dt>
                <dd>{t(`resourceOrigin_${selected.origin}`)}</dd>
              </div>
              <div>
                <dt>{t("installedVersion")}</dt>
                <dd>{selected.installedVersion ?? t("notReported")}</dd>
              </div>
              <div>
                <dt>{t("configuredVersion")}</dt>
                <dd>
                  {selected.configuredVersion ?? t("resourceVersionUnpinned")}
                </dd>
              </div>
              <div>
                <dt>{t("resources")}</dt>
                <dd>
                  {t("pluginResourceSummary", {
                    extensions: selected.extensions.length,
                    skills: selected.skills.length,
                    prompts: selected.prompts.length,
                    themes: selected.themes.length,
                  })}
                </dd>
              </div>
              <div>
                <dt>{t("baseDirectory")}</dt>
                <dd title={selected.baseDir}>
                  {selected.baseDir ?? t("notReported")}
                </dd>
              </div>
            </dl>
            {[...new Set(selected.diagnostics)].map((diagnostic) => (
              <p
                key={diagnostic}
                className="settings-resource-notice"
                role="status"
              >
                {diagnostic}
              </p>
            ))}
            {selected.canManage === false && (
              <p className="settings-resource-notice">
                {t("resourceTargetTruncated")}
              </p>
            )}
            {selected.configured && selected.canManage !== false && (
              <div className="settings-resource-actions settings-resource-primary-actions">
                {(
                  [
                    selected.enabled === false ? "enable" : "disable",
                    "update",
                    "remove",
                  ] as const
                ).map((action) => (
                  <SetupAction
                    key={action}
                    isPending={setupPending}
                    onConfigure={onConfigure}
                    label={t(`pluginAction_${action}`)}
                    request={t("setupPluginOperationRequest", {
                      action,
                      source: JSON.stringify(selected.source),
                      path: JSON.stringify(selected.baseDir ?? null),
                      scope: selected.scope,
                    })}
                  />
                ))}
              </div>
            )}
            <p className="settings-resource-caption">
              {t("pluginLoadedResources", { count: pluginCount(selected) })}
            </p>
            <section className="settings-resource-groups">
              {selected.extensions.length > 0 && (
                <div>
                  <h2>{t("extensions")}</h2>
                  <ul>
                    {selected.extensions.map((extension) => (
                      <li key={extension.path}>
                        <div>
                          <strong>{extension.name}</strong>
                          <code>{extension.path}</code>
                        </div>
                        <span>
                          {t("extensionSurfaceCount", {
                            tools: extension.toolCount,
                            commands: extension.commandCount,
                          })}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {selected.skills.length > 0 && (
                <div>
                  <h2>{t("skillsSettings")}</h2>
                  <p>{selected.skills.join(" · ")}</p>
                </div>
              )}
              {selected.prompts.length > 0 && (
                <div>
                  <h2>{t("prompts")}</h2>
                  <p>{selected.prompts.join(" · ")}</p>
                </div>
              )}
              {selected.themes.length > 0 && (
                <div>
                  <h2>{t("themes")}</h2>
                  <p>{selected.themes.join(" · ")}</p>
                </div>
              )}
            </section>
          </>
        ) : (
          <div className="settings-empty-detail">
            <Plug aria-hidden="true" />
            <h2>
              {t(plugins.length ? "noMatchingResources" : "pluginsEmptyTitle")}
            </h2>
            <Button
              label={t("addPlugin")}
              variant="secondary"
              size="sm"
              icon={<Plus aria-hidden="true" />}
              onClick={() => setAdding(true)}
            />
          </div>
        )}
        {!adding && (
          <ResourceFooter
            catalog={catalog}
            pending={setupPending}
            onReload={onReload}
            kind="plugins"
            onConfigure={onConfigure}
          >
            {manageable.length > 1 && (
              <>
                <SetupAction
                  isPending={setupPending}
                  isBlocked={bulkTooLarge}
                  onConfigure={onConfigure}
                  label={t("enableVisiblePlugins", {
                    count: manageable.length,
                  })}
                  request={t("setupPluginsBulkRequest", {
                    packages: bulkPackages,
                    disabled: false,
                  })}
                />
                <SetupAction
                  isPending={setupPending}
                  isBlocked={bulkTooLarge}
                  onConfigure={onConfigure}
                  label={t("disableVisiblePlugins", {
                    count: manageable.length,
                  })}
                  request={t("setupPluginsBulkRequest", {
                    packages: bulkPackages,
                    disabled: true,
                  })}
                />
              </>
            )}
            {bulkTooLarge && (
              <p className="settings-resource-caption">
                {t("resourceBulkTooLarge")}
              </p>
            )}
          </ResourceFooter>
        )}
      </div>
    </section>
  );
}
