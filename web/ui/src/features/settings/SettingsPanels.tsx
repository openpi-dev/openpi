import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Button } from "@astryxdesign/core/Button";
import { Slider } from "@astryxdesign/core/Slider";
import { Switch } from "@astryxdesign/core/Switch";
import {
  Bot,
  Check,
  Clipboard,
  CloudFog,
  Code2,
  Cpu,
  ExternalLink,
  FileText,
  Flower2,
  FolderCog,
  Gauge,
  KeyRound,
  Monitor,
  Moon,
  Plug,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Sparkles,
  Sun,
  TreePine,
  Wrench,
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
  WebThemePreference,
} from "../../../../protocol/types.ts";
import { copyText } from "../../lib/clipboard.ts";

const themes = [
  { id: "light", label: "themeLight", Icon: Sun },
  { id: "dark", label: "themeDark", Icon: Moon },
  { id: "mist", label: "themeMist", Icon: CloudFog },
  { id: "rose", label: "themeRose", Icon: Flower2 },
  { id: "pine", label: "themePine", Icon: TreePine },
  { id: "system", label: "themeSystem", Icon: Monitor },
] as const;

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
  theme,
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
  theme: WebThemePreference;
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
  const selectedTheme = setup?.ui.webTheme ?? theme;
  const [chatWidth, setChatWidth] = useState(setup?.ui.webChatWidth ?? 820);
  const [chatFontSize, setChatFontSize] = useState(
    setup?.ui.webChatFontSize ?? 14,
  );
  const configuredConcurrency = setup?.workflows.concurrency ?? 0;
  const configuredCalls = setup?.workflows.maxAgentCalls ?? 0;
  const [concurrency, setConcurrency] = useState(configuredConcurrency);
  const [maxCalls, setMaxCalls] = useState(configuredCalls);

  useEffect(() => {
    if (!setup) return;
    setChatWidth(setup.ui.webChatWidth);
    setChatFontSize(setup.ui.webChatFontSize);
  }, [setup]);

  useEffect(
    () => setConcurrency(configuredConcurrency),
    [configuredConcurrency],
  );
  useEffect(() => setMaxCalls(configuredCalls), [configuredCalls]);

  return (
    <section className="settings-general-panel">
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

      <section className="settings-section-block">
        <h2>{t("appearance")}</h2>
        <div
          className="settings-theme-options"
          role="radiogroup"
          aria-label={t("appearance")}
        >
          {themes.map(({ id, label, Icon }) => (
            <label
              key={id}
              className="settings-theme-option"
              data-selected={selectedTheme === id ? "true" : undefined}
            >
              <input
                type="radio"
                name="openpi-web-theme"
                value={id}
                checked={selectedTheme === id}
                disabled={preferencePending}
                onChange={() => {
                  void onUpdatePreferences({ theme: id });
                }}
              />
              <Icon aria-hidden="true" />
              <span>{t(label)}</span>
            </label>
          ))}
        </div>
      </section>

      {setup && (
        <section className="settings-section-block settings-chat-controls">
          <h2>{t("conversationSettings")}</h2>
          <Switch
            label={t("expandThinkingByDefault")}
            value={setup.ui.webExpandThinking}
            size="sm"
            width="100%"
            labelPosition="start"
            labelSpacing="spread"
            isDisabled={preferencePending}
            isLoading={preferencePending}
            onChange={(checked: boolean) => {
              void onUpdatePreferences({ expandThinking: checked });
            }}
          />
          <div className="settings-slider-control">
            <div className="settings-slider-heading">
              <span>{t("chatContentWidth")}</span>
              <output>{chatWidth}px</output>
              <button
                type="button"
                className="settings-reset-button"
                aria-label={t("resetChatContentWidth")}
                title={t("resetChatContentWidth")}
                disabled={preferencePending || chatWidth === 820}
                onClick={() => {
                  setChatWidth(820);
                  void onUpdatePreferences({ chatWidth: 820 }).then(
                    (accepted) => {
                      if (!accepted) setChatWidth(setup.ui.webChatWidth);
                    },
                  );
                }}
              >
                <RotateCcw aria-hidden="true" />
              </button>
            </div>
            <Slider
              label={t("chatContentWidth")}
              isLabelHidden
              value={chatWidth}
              min={820}
              max={2000}
              step={10}
              width="100%"
              valueDisplay="none"
              formatValue={(value: number) => `${value}px`}
              isDisabled={preferencePending}
              onChange={(value: number) => setChatWidth(value)}
              onChangeEnd={(value: number) => {
                if (value !== setup.ui.webChatWidth) {
                  void onUpdatePreferences({ chatWidth: value }).then(
                    (accepted) => {
                      if (!accepted) setChatWidth(setup.ui.webChatWidth);
                    },
                  );
                }
              }}
            />
          </div>
          <div className="settings-slider-control">
            <div className="settings-slider-heading">
              <span>{t("chatFontSize")}</span>
              <output>{chatFontSize}px</output>
              <button
                type="button"
                className="settings-reset-button"
                aria-label={t("resetChatFontSize")}
                title={t("resetChatFontSize")}
                disabled={preferencePending || chatFontSize === 14}
                onClick={() => {
                  setChatFontSize(14);
                  void onUpdatePreferences({ chatFontSize: 14 }).then(
                    (accepted) => {
                      if (!accepted) setChatFontSize(setup.ui.webChatFontSize);
                    },
                  );
                }}
              >
                <RotateCcw aria-hidden="true" />
              </button>
            </div>
            <Slider
              label={t("chatFontSize")}
              isLabelHidden
              value={chatFontSize}
              min={12}
              max={24}
              step={1}
              width="100%"
              valueDisplay="none"
              formatValue={(value: number) => `${value}px`}
              isDisabled={preferencePending}
              onChange={(value: number) => setChatFontSize(value)}
              onChangeEnd={(value: number) => {
                if (value !== setup.ui.webChatFontSize) {
                  void onUpdatePreferences({ chatFontSize: value }).then(
                    (accepted) => {
                      if (!accepted) {
                        setChatFontSize(setup.ui.webChatFontSize);
                      }
                    },
                  );
                }
              }}
            />
          </div>
        </section>
      )}

      <SettingsLoadState
        catalog={catalog}
        error={error}
        onRefresh={onRefresh}
      />
      {setup && (
        <>
          <section className="settings-section-block">
            <h2>{t("agentBehavior")}</h2>
            <div className="settings-chat-controls">
              <label className="settings-inline-control">
                <Sparkles aria-hidden="true" />
                <span>{t("capabilityDiscovery")}</span>
                <select
                  value={setup.capabilities.discovery}
                  disabled={setupPending || setupBlocked}
                  onChange={(event) =>
                    void onConfigure(
                      t("setupRequestDiscovery", { mode: event.target.value }),
                    )
                  }
                >
                  {(["explicit", "adaptive"] as const).map((mode) => (
                    <option key={mode} value={mode}>
                      {t(`capabilityDiscovery_${mode}`)}
                    </option>
                  ))}
                </select>
              </label>
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
              <Switch
                label={t("nextActionSuggestions")}
                value={setup.suggestions.enabled}
                size="sm"
                width="100%"
                labelPosition="start"
                labelSpacing="spread"
                isDisabled={setupPending || setupBlocked}
                isLoading={setupPending}
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
                <span>
                  {t("postEditCommand")} ·{" "}
                  {t(setup.postEditConfigured ? "configured" : "disabled")}
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
                  ["subagentResultDisplay", "subagentResults"],
                  ["bashToolDisplay", "bashOperations"],
                  ["fileMutationDisplay", "fileMutations"],
                ] as const
              ).map(([key, label]) => (
                <label key={key} className="settings-inline-control">
                  <span>{t(label)}</span>
                  <select
                    value={setup.ui[key]}
                    disabled={preferencePending}
                    onChange={(event) => {
                      const value = event.target.value;
                      if (value === "full" || value === "compact")
                        void onUpdatePreferences({ [key]: value });
                    }}
                  >
                    <option value="compact">
                      {t("detailDisplay_compact")}
                    </option>
                    <option value="full">{t("detailDisplay_full")}</option>
                  </select>
                </label>
              ))}
              <Switch
                label={t("terminalFooter")}
                value={setup.ui.customFooter}
                size="sm"
                width="100%"
                labelPosition="start"
                labelSpacing="spread"
                isDisabled={preferencePending}
                isLoading={preferencePending}
                onChange={(checked: boolean) =>
                  void onUpdatePreferences({ customFooter: checked })
                }
              />
              <label className="settings-inline-control">
                <span>{t("terminalFooterStyle")}</span>
                <select
                  value={setup.ui.footerStyle}
                  disabled={preferencePending || !setup.ui.customFooter}
                  onChange={(event) => {
                    const value = event.target.value;
                    if (
                      value === "plain" ||
                      value === "powerline" ||
                      value === "powerline-mono"
                    )
                      void onUpdatePreferences({ footerStyle: value });
                  }}
                >
                  <option value="plain">Plain</option>
                  <option value="powerline">Powerline</option>
                  <option value="powerline-mono">Powerline Mono</option>
                </select>
              </label>
              <small>{t("terminalFooterHint")}</small>
            </div>
          </section>
        </>
      )}

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
        <strong>
          {t(kind === "skills" ? "skillsSettings" : "pluginsSettings")}
        </strong>
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
      <select
        aria-label={t("filterResourceScope")}
        value={scope}
        onChange={(event) => onScope(event.target.value)}
      >
        <option value="all">{t("allResourceScopes")}</option>
        {(["project", "user", "temporary"] as const).map((value) => (
          <option key={value} value={value}>
            {t(`resourceScope_${value}`)}
          </option>
        ))}
      </select>
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
          <span>{t("resourceManagement")}</span>
          <h1>{t(kind === "skills" ? "addSkill" : "addPlugin")}</h1>
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
        <label className="settings-form-field">
          {t("scope")}
          <select
            value={scope}
            disabled={pending}
            onChange={(event) => {
              setScope(event.target.value);
            }}
          >
            <option value="user">{t("resourceScope_user")}</option>
            <option value="project">{t("resourceScope_project")}</option>
          </select>
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
    <section className="settings-split-panel settings-managed-panel">
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
                <span>
                  {t(`resourceScope_${selected.scope}`)} · {t("skill")}
                </span>
                <h1>{selected.name}</h1>
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
            <h1>
              {t(skills.length ? "noMatchingResources" : "skillsEmptyTitle")}
            </h1>
            <p>{t("skillsEmptyIntro")}</p>
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
    <section className="settings-subagents-panel">
      <header className="settings-subagent-summary">
        <div>
          <strong>{t("subagentConfiguration")}</strong>
          <span>{t("subagentConfigurationIntro")}</span>
        </div>
        {catalog && (
          <div className="settings-subagent-metrics">
            <span>{t("subagentActiveCount", { count: active })}</span>
            <span>{t("subagentCompletedCount", { count: completed })}</span>
            <span>
              {t("subagentConcurrency", {
                count: catalog.setup.workflows.concurrency,
              })}
            </span>
          </div>
        )}
      </header>
      <div className="settings-split-panel settings-subagent-split">
        <aside className="settings-resource-sidebar">
          <div className="settings-resource-list">
            <span className="settings-sidebar-label">{t("builtInRoles")}</span>
            {roles.map((role) => (
              <button
                key={role}
                type="button"
                className="settings-resource-item"
                aria-current={role === selectedRole ? "page" : undefined}
                onClick={() => setSelectedRole(role)}
              >
                <Bot aria-hidden="true" />
                <span>
                  <strong>{t(`subagentRole_${role}`)}</strong>
                  <small>{t(`subagentRoleShort_${role}`)}</small>
                </span>
              </button>
            ))}
          </div>
          <div className="settings-sidebar-footer settings-sidebar-footer-action">
            <SetupAction
              isPending={setupPending}
              isBlocked={setupBlocked}
              onConfigure={onConfigure}
              request={t("setupRequestSubagents")}
              label={t("configureRoles")}
            />
          </div>
        </aside>
        <div className="settings-resource-detail">
          <SettingsLoadState
            catalog={catalog}
            error={error}
            onRefresh={onRefresh}
          />
          {catalog && (
            <>
              <header className="settings-detail-heading">
                <div>
                  <span>{t("builtInRole")}</span>
                  <h1>{t(`subagentRole_${selectedRole}`)}</h1>
                  <p>{t(`subagentRoleDescription_${selectedRole}`)}</p>
                </div>
                <span className="settings-status-badge">{t("builtIn")}</span>
              </header>
              <dl className="settings-detail-metadata settings-detail-metadata-wide">
                <div>
                  <dt>{t("modelAssignment")}</dt>
                  <dd>
                    {assignment
                      ? `${assignment.provider}/${assignment.model}`
                      : t("inheritParentModel")}
                  </dd>
                </div>
                <div>
                  <dt>{t("effectiveModel")}</dt>
                  <dd>
                    {assignment
                      ? `${assignment.provider}/${assignment.model}`
                      : (currentModel?.label ?? t("unknownState"))}
                  </dd>
                </div>
                <div>
                  <dt>{t("workflowConcurrencyLabel")}</dt>
                  <dd>{catalog.setup.workflows.concurrency}</dd>
                </div>
                <div>
                  <dt>{t("workflowCallLimit")}</dt>
                  <dd>{catalog.setup.workflows.maxAgentCalls}</dd>
                </div>
              </dl>
              <section className="settings-role-principles">
                <form
                  className="settings-edit-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (setupPending) return;
                    void onConfigure(
                      t("setupRoleFormRequest", {
                        role: selectedRole,
                        model: roleModel || t("inheritParentModel"),
                        concurrency,
                      }),
                    );
                  }}
                >
                  <label className="settings-form-field">
                    {t("modelAssignment")}
                    <select
                      value={roleModel}
                      disabled={setupPending}
                      onChange={(event) => setRoleModel(event.target.value)}
                    >
                      <option value="">{t("inheritParentModel")}</option>
                      {roleModel &&
                        !models.some(
                          (model) =>
                            `${model.provider}/${model.id}` === roleModel,
                        ) && <option value={roleModel}>{roleModel}</option>}
                      {models.map((model) => (
                        <option
                          key={`${model.provider}/${model.id}`}
                          value={`${model.provider}/${model.id}`}
                        >
                          {model.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="settings-form-field">
                    {t("workflowConcurrencyLabel")}
                    <input
                      type="number"
                      min={1}
                      max={64}
                      required
                      value={concurrency}
                      disabled={setupPending}
                      onChange={(event) =>
                        setConcurrency(Number(event.target.value))
                      }
                    />
                  </label>
                  <button type="submit" disabled={setupPending}>
                    {t("configureViaSetup")}
                  </button>
                  <small>{t("setupFormDetail")}</small>
                </form>
                <h2>{t("runtimeBoundaries")}</h2>
                <div>
                  <KeyRound aria-hidden="true" />
                  <p>{t("subagentAuthorityNote")}</p>
                </div>
                <div>
                  <Cpu aria-hidden="true" />
                  <p>{t("subagentModelNote")}</p>
                </div>
              </section>
            </>
          )}
        </div>
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
    <section className="settings-split-panel settings-managed-panel">
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
                <span>{t(`resourceScope_${selected.scope}`)}</span>
                <h1>{sourceLabel(selected)}</h1>
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
            <h1>
              {t(plugins.length ? "noMatchingResources" : "pluginsEmptyTitle")}
            </h1>
            <p>{t("pluginsEmptyIntro")}</p>
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
