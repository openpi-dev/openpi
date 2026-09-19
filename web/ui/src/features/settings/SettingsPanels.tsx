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
  FileText,
  Flower2,
  FolderCog,
  Gauge,
  KeyRound,
  Monitor,
  Moon,
  Plug,
  RefreshCw,
  Sparkles,
  Sun,
  TreePine,
  Wrench,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { WebCapabilitySnapshot } from "../../../../../extensions/shared/web-observer-registry.ts";
import type {
  WebModelSummary,
  WebSettingsCatalog,
  WebSettingsPluginSummary,
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
  onConfigure,
  request,
  label,
}: {
  isPending: boolean;
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
      isDisabled={isPending}
      isLoading={isPending}
      onClick={() => void onConfigure(request)}
    />
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
  onConfigure,
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
  onConfigure: (request: string) => Promise<boolean>;
  onOpenRuntimeStatus: () => void;
  onRefresh: () => void;
}) {
  const { t } = useTranslation();
  const setup = catalog?.setup;
  const [chatWidth, setChatWidth] = useState(setup?.ui.webChatWidth ?? 820);
  const [chatFontSize, setChatFontSize] = useState(
    setup?.ui.webChatFontSize ?? 14,
  );

  useEffect(() => {
    if (!setup) return;
    setChatWidth(setup.ui.webChatWidth);
    setChatFontSize(setup.ui.webChatFontSize);
  }, [setup]);

  return (
    <section className="settings-general-panel">
      <div className="settings-page-heading">
        <div>
          <h1>{t("generalSettings")}</h1>
        </div>
        <SetupAction
          isPending={setupPending}
          onConfigure={onConfigure}
          request={t("setupRequestReviewAll")}
          label={t("configureOpenPi")}
        />
      </div>

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
              data-selected={theme === id ? "true" : undefined}
            >
              <input
                type="radio"
                name="openpi-web-theme"
                value={id}
                checked={theme === id}
                disabled={setupPending}
                onChange={() => {
                  void onConfigure(t("setupRequestTheme", { theme: t(label) }));
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
            isDisabled={setupPending}
            isLoading={setupPending}
            onChange={(checked: boolean) => {
              void onConfigure(
                t(
                  checked
                    ? "setupRequestExpandThinking"
                    : "setupRequestCollapseThinking",
                ),
              );
            }}
          />
          <div className="settings-slider-control">
            <Slider
              label={t("chatContentWidth")}
              value={chatWidth}
              min={820}
              max={2000}
              step={10}
              width="100%"
              valueDisplay="text"
              formatValue={(value: number) => `${value}px`}
              isDisabled={setupPending}
              onChange={(value: number) => setChatWidth(value)}
              onChangeEnd={(value: number) => {
                if (value !== setup.ui.webChatWidth) {
                  void onConfigure(t("setupRequestChatWidth", { value })).then(
                    (accepted) => {
                      if (!accepted) setChatWidth(setup.ui.webChatWidth);
                    },
                  );
                }
              }}
            />
          </div>
          <div className="settings-slider-control">
            <Slider
              label={t("chatFontSize")}
              value={chatFontSize}
              min={12}
              max={24}
              step={1}
              width="100%"
              valueDisplay="text"
              formatValue={(value: number) => `${value}px`}
              isDisabled={setupPending}
              onChange={(value: number) => setChatFontSize(value)}
              onChangeEnd={(value: number) => {
                if (value !== setup.ui.webChatFontSize) {
                  void onConfigure(
                    t("setupRequestChatFontSize", { value }),
                  ).then((accepted) => {
                    if (!accepted) {
                      setChatFontSize(setup.ui.webChatFontSize);
                    }
                  });
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
            <div className="settings-fact-grid">
              <div>
                <Sparkles aria-hidden="true" />
                <span>{t("capabilityDiscovery")}</span>
                <strong>
                  {t(`capabilityDiscovery_${setup.capabilities.discovery}`)}
                </strong>
              </div>
              <div>
                <Gauge aria-hidden="true" />
                <span>{t("workflowLimits")}</span>
                <strong>
                  {t("workflowLimitsValue", {
                    concurrency: setup.workflows.concurrency,
                    calls: setup.workflows.maxAgentCalls,
                  })}
                </strong>
              </div>
              <div>
                <Bot aria-hidden="true" />
                <span>{t("nextActionSuggestions")}</span>
                <strong>
                  {setup.suggestions.enabled
                    ? setup.suggestions.model
                      ? `${setup.suggestions.model.provider}/${setup.suggestions.model.model} · ${setup.suggestions.model.reasoning}`
                      : t("enabled")
                    : t("disabled")}
                </strong>
              </div>
              <div>
                <Code2 aria-hidden="true" />
                <span>{t("postEditCommand")}</span>
                <strong>
                  {t(setup.postEditConfigured ? "configured" : "disabled")}
                </strong>
              </div>
            </div>
          </section>

          <section className="settings-section-block">
            <h2>{t("resultDisplay")}</h2>
            <dl className="settings-summary-list">
              <div>
                <dt>{t("subagentResults")}</dt>
                <dd>{t(`detailDisplay_${setup.ui.subagentResultDisplay}`)}</dd>
              </div>
              <div>
                <dt>{t("bashOperations")}</dt>
                <dd>{t(`detailDisplay_${setup.ui.bashToolDisplay}`)}</dd>
              </div>
              <div>
                <dt>{t("fileMutations")}</dt>
                <dd>{t(`detailDisplay_${setup.ui.fileMutationDisplay}`)}</dd>
              </div>
              <div>
                <dt>{t("footer")}</dt>
                <dd>
                  {setup.ui.customFooter
                    ? `${t("enabled")} · ${setup.ui.footerStyle}`
                    : t("disabled")}
                </dd>
              </div>
            </dl>
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

export function SkillsSettingsPanel({
  catalog,
  error,
  onRefresh,
}: {
  catalog: WebSettingsCatalog | null;
  error: string | null;
  onRefresh: () => void;
}) {
  const { t } = useTranslation();
  const skills = catalog?.resources.skills ?? [];
  const [selectedId, setSelectedId] = useState("");
  const [copyStatus, setCopyStatus] = useState<"copied" | "failed" | null>(
    null,
  );
  const selected = skills.find((skill) => skill.id === selectedId) ?? skills[0];

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
    <section className="settings-split-panel">
      <aside className="settings-resource-sidebar">
        <div className="settings-resource-list">
          {skills.map((skill) => (
            <button
              key={skill.id}
              type="button"
              className="settings-resource-item"
              aria-current={skill.id === selected?.id ? "page" : undefined}
              onClick={() => {
                setSelectedId(skill.id);
                setCopyStatus(null);
              }}
            >
              <Sparkles aria-hidden="true" />
              <span>
                <strong>{skill.name}</strong>
                <small>{resourceSourceLabel(skill.source)}</small>
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
          {catalog && !skills.length && (
            <p className="settings-resource-empty">{t("noSkillsFound")}</p>
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
        {error ? (
          <SettingsLoadState
            catalog={catalog}
            error={error}
            onRefresh={onRefresh}
          />
        ) : selected ? (
          <>
            <header className="settings-detail-heading">
              <div>
                <span>{t("skill")}</span>
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
                <dd>{selected.source}</dd>
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
            {copyStatus === "failed" && (
              <p className="inspection-warning">{t("copyFailed")}</p>
            )}
          </>
        ) : (
          <div className="settings-empty-detail">
            <Sparkles aria-hidden="true" />
            <span>{t("selectSkill")}</span>
          </div>
        )}
      </div>
    </section>
  );
}

export function SubagentsSettingsPanel({
  catalog,
  error,
  currentModel,
  activity,
  setupPending,
  onConfigure,
  onRefresh,
}: {
  catalog: WebSettingsCatalog | null;
  error: string | null;
  currentModel?: WebModelSummary;
  activity?: WebCapabilitySnapshot["subagents"];
  setupPending: boolean;
  onConfigure: (request: string) => Promise<boolean>;
  onRefresh: () => void;
}) {
  const { t } = useTranslation();
  const [selectedRole, setSelectedRole] =
    useState<(typeof roles)[number]>("explorer");
  const assignment = catalog?.setup.subagents.roleModels[selectedRole];
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

export function PluginsSettingsPanel({
  catalog,
  error,
  onRefresh,
}: {
  catalog: WebSettingsCatalog | null;
  error: string | null;
  onRefresh: () => void;
}) {
  const { t } = useTranslation();
  const plugins = catalog?.resources.plugins ?? [];
  const [selectedId, setSelectedId] = useState("");
  const selected =
    plugins.find((plugin) => plugin.id === selectedId) ?? plugins[0];

  useEffect(() => {
    if (plugins.length && !plugins.some((plugin) => plugin.id === selectedId)) {
      setSelectedId(plugins[0]!.id);
    }
  }, [plugins, selectedId]);

  return (
    <section className="settings-split-panel">
      <aside className="settings-resource-sidebar">
        <div className="settings-resource-list">
          {plugins.map((plugin) => (
            <button
              key={plugin.id}
              type="button"
              className="settings-resource-item"
              aria-current={plugin.id === selected?.id ? "page" : undefined}
              onClick={() => setSelectedId(plugin.id)}
            >
              <Plug aria-hidden="true" />
              <span>
                <strong>{resourceSourceLabel(plugin.source)}</strong>
                <small>
                  {t("resourceCount", { count: pluginCount(plugin) })}
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
          {catalog && !plugins.length && (
            <p className="settings-resource-empty">{t("noPluginsFound")}</p>
          )}
        </div>
        <div className="settings-sidebar-footer">
          <span>
            {catalog
              ? t("pluginCatalogTotals", catalog.resources.totals)
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
        {error ? (
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
                <h1>{resourceSourceLabel(selected.source)}</h1>
                <code>{selected.source}</code>
              </div>
              <span className="settings-status-badge healthy">
                {t("loaded")}
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
            <aside className="provider-read-only">
              <KeyRound aria-hidden="true" />
              <div>
                <strong>{t("providerReadOnly")}</strong>
                <p>{t("pluginsManagedByPi")}</p>
              </div>
            </aside>
          </>
        ) : (
          <div className="settings-empty-detail">
            <Plug aria-hidden="true" />
            <span>{t("selectPlugin")}</span>
          </div>
        )}
      </div>
    </section>
  );
}
