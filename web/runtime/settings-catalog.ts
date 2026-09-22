import { basename, dirname, extname } from "node:path";
import type { MyPiSetupConfig } from "../../extensions/shared/setup-config.ts";
import type {
  WebOpenPiSetupProjection,
  WebSettingsPluginSummary,
  WebSettingsResourceCatalog,
} from "../protocol/types.ts";

const MAX_SKILLS = 128;
const MAX_PLUGINS = 64;
const MAX_RESOURCES_PER_PLUGIN = 256;
const MAX_TEXT = 500;
const MAX_DESCRIPTION = 1_000;

interface SettingsSourceInfo {
  source: string;
  scope: "user" | "project" | "temporary";
  origin: "package" | "top-level";
  baseDir?: string;
}

interface SettingsResourceLoader {
  getExtensions(): {
    extensions: readonly {
      hidden?: boolean;
      path: string;
      sourceInfo: SettingsSourceInfo;
      tools: { size: number };
      commands: { size: number };
    }[];
    errors: readonly unknown[];
  };
  getSkills(): {
    skills: readonly {
      name: string;
      description: string;
      filePath: string;
      sourceInfo: SettingsSourceInfo;
      disableModelInvocation: boolean;
    }[];
    diagnostics: readonly unknown[];
  };
  getPrompts(): {
    prompts: readonly {
      name: string;
      sourceInfo: SettingsSourceInfo;
    }[];
  };
  getThemes(): {
    themes: readonly {
      name?: string;
      sourceInfo?: SettingsSourceInfo;
    }[];
  };
}

function boundedText(value: string, max = MAX_TEXT) {
  const sanitized = value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").trim();
  return sanitized.length <= max
    ? sanitized
    : `${sanitized.slice(0, Math.max(0, max - 1))}…`;
}

function extensionName(path: string) {
  const file = basename(path);
  if (/^index\.[cm]?[jt]sx?$/u.test(file)) return basename(dirname(path));
  return file.slice(0, Math.max(0, file.length - extname(file).length));
}

function pluginFor(
  plugins: Map<string, WebSettingsPluginSummary>,
  sourceInfo: SettingsSourceInfo,
) {
  const source = boundedText(sourceInfo.source);
  const id = `${sourceInfo.scope}:${sourceInfo.origin}:${source}`;
  const existing = plugins.get(id);
  if (existing) return existing;
  const plugin: WebSettingsPluginSummary = {
    id,
    source,
    scope: sourceInfo.scope,
    origin: sourceInfo.origin,
    ...(sourceInfo.baseDir ? { baseDir: boundedText(sourceInfo.baseDir) } : {}),
    extensions: [],
    skills: [],
    prompts: [],
    themes: [],
  };
  plugins.set(id, plugin);
  return plugin;
}

function appendBounded(values: string[], value: string) {
  if (values.length >= MAX_RESOURCES_PER_PLUGIN) return false;
  values.push(boundedText(value));
  return true;
}

export function projectWebSettingsResources(
  resourceLoader: SettingsResourceLoader,
): WebSettingsResourceCatalog {
  const extensionResult = resourceLoader.getExtensions();
  const skillResult = resourceLoader.getSkills();
  const prompts = resourceLoader.getPrompts().prompts;
  const themes = resourceLoader.getThemes().themes;
  const plugins = new Map<string, WebSettingsPluginSummary>();
  let resourcesOmitted = 0;

  for (const extension of extensionResult.extensions) {
    if (extension.hidden) continue;
    const plugin = pluginFor(plugins, extension.sourceInfo);
    if (plugin.extensions.length >= MAX_RESOURCES_PER_PLUGIN) {
      resourcesOmitted++;
      continue;
    }
    plugin.extensions.push({
      name: boundedText(extensionName(extension.path)),
      path: boundedText(extension.path),
      toolCount: extension.tools.size,
      commandCount: extension.commands.size,
    });
  }

  for (const skill of skillResult.skills) {
    const plugin = pluginFor(plugins, skill.sourceInfo);
    if (!appendBounded(plugin.skills, skill.name)) resourcesOmitted++;
  }
  for (const prompt of prompts) {
    const plugin = pluginFor(plugins, prompt.sourceInfo);
    if (!appendBounded(plugin.prompts, prompt.name)) resourcesOmitted++;
  }
  for (const theme of themes) {
    if (!theme.sourceInfo || !theme.name) continue;
    const plugin = pluginFor(plugins, theme.sourceInfo);
    if (!appendBounded(plugin.themes, theme.name)) resourcesOmitted++;
  }

  const visibleSkills = skillResult.skills.slice(0, MAX_SKILLS).map((skill) => ({
    id: `${skill.sourceInfo.source}:${skill.name}`,
    name: boundedText(skill.name),
    description: boundedText(skill.description, MAX_DESCRIPTION),
    filePath: boundedText(skill.filePath),
    source: boundedText(skill.sourceInfo.source),
    scope: skill.sourceInfo.scope,
    origin: skill.sourceInfo.origin,
    disableModelInvocation: skill.disableModelInvocation,
  }));
  const allPlugins = [...plugins.values()];
  const visiblePlugins = allPlugins.slice(0, MAX_PLUGINS).map((plugin) => ({
    ...plugin,
    extensions: plugin.extensions.sort((left, right) =>
      left.name.localeCompare(right.name),
    ),
    skills: plugin.skills.sort(),
    prompts: plugin.prompts.sort(),
    themes: plugin.themes.sort(),
  }));
  const skillsOmitted = Math.max(0, skillResult.skills.length - visibleSkills.length);
  const pluginsOmitted = Math.max(0, allPlugins.length - visiblePlugins.length);

  return {
    skills: visibleSkills.sort((left, right) => left.name.localeCompare(right.name)),
    plugins: visiblePlugins.sort((left, right) =>
      left.source.localeCompare(right.source),
    ),
    totals: {
      extensions: extensionResult.extensions.filter((extension) => !extension.hidden)
        .length,
      skills: skillResult.skills.length,
      prompts: prompts.length,
      themes: themes.length,
    },
    diagnostics: {
      extensionErrors: extensionResult.errors.length,
      skillErrors: skillResult.diagnostics.length,
    },
    truncation: {
      truncated:
        skillsOmitted > 0 || pluginsOmitted > 0 || resourcesOmitted > 0,
      skillsOmitted,
      pluginsOmitted,
      resourcesOmitted,
    },
  };
}

export function projectWebSetupConfig(
  config: MyPiSetupConfig,
): WebOpenPiSetupProjection {
  return {
    capabilities: { discovery: config.capabilities.discovery },
    suggestions: {
      enabled: config.suggestions.enabled,
      ...(config.suggestions.model
        ? {
            model: {
              provider: boundedText(config.suggestions.model.provider),
              model: boundedText(config.suggestions.model.model),
              reasoning: config.suggestions.model.reasoning,
            },
          }
        : {}),
    },
    workflows: { ...config.workflows },
    ui: {
      webTheme: config.ui.webTheme,
      webChatWidth: config.ui.webChatWidth,
      webChatFontSize: config.ui.webChatFontSize,
      webExpandThinking: config.ui.webExpandThinking,
      showHeader: config.ui.showHeader,
      customFooter: config.ui.customFooter,
      footerStyle: config.ui.footerStyle,
      subagentResultDisplay: config.ui.subagentResultDisplay,
      bashToolDisplay: config.ui.bashToolDisplay,
      fileMutationDisplay: config.ui.fileMutationDisplay,
    },
    postEditConfigured: Boolean(config.postEdit.command),
    subagents: {
      roleModels: Object.fromEntries(
        Object.entries(config.subagents.roleModels).map(([role, model]) => [
          role,
          { provider: boundedText(model.provider), model: boundedText(model.model) },
        ]),
      ),
    },
  };
}
