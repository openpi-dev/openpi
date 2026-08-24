import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
  SUBAGENT_ROLE_NAMES,
  type SubagentRoleModel,
  type SubagentRoleModels,
} from "../shared/subagent-roles.ts";
import { sanitizeTerminalText } from "../shared/terminal-text.ts";
import {
  OPENPI_SETUP_EPISODE_CHANNEL,
  type OpenPiSetupEpisodeState,
} from "../shared/setup-episode-state.ts";
import { patchOwnedTools } from "../shared/tool-surface.ts";
import {
  formatPiIntercomStatus,
  inspectPiIntercom,
  installPiIntercom,
  type PiIntercomStatus,
} from "./intercom.ts";
import {
  applyFooterConfig,
  CAPABILITY_DISCOVERY_MODES,
  DETAIL_DISPLAYS,
  FOOTER_ITEMS,
  FOOTER_LAYOUT_ITEMS,
  FOOTER_PRESETS,
  FOOTER_STYLES,
  formatSetupConfig,
  hasSavedSetupConfig,
  loadSetupConfig,
  updateSetupConfig,
  MAX_WORKFLOW_AGENT_CALLS,
  MAX_WORKFLOW_CONCURRENCY,
  POST_EDIT_COMMAND_MAX_CHARS,
  REASONING_LEVELS,
  SETUP_CONFIG_CHANGED_CHANNEL,
  type FooterLayoutItem,
  type CapabilityDiscoveryMode,
  type FooterPreset,
  type FooterStyle,
  type MyPiSetupConfig,
} from "../shared/setup-config.ts";

const subagentRoleModelValueSchema = Type.Union([
  Type.Object(
    {
      provider: Type.String({ description: "Available Pi provider id." }),
      model: Type.String({ description: "Available Pi model id." }),
    },
    { additionalProperties: false },
  ),
  Type.Null(),
]);

export const SUBAGENT_ROLE_MODELS_SCHEMA = Type.Partial(
  Type.Record(
    Type.Union(SUBAGENT_ROLE_NAMES.map((role) => Type.Literal(role))),
    subagentRoleModelValueSchema,
  ),
  {
    additionalProperties: false,
    description:
      "Partial built-in-role model assignments shared by subagent_spawn and workflow agent_type. Each value is an available {provider, model}; null clears that role to inherit the parent model, and omitted roles are preserved.",
  },
);

export function applySubagentRoleModelUpdates(
  current: SubagentRoleModels,
  updates:
    | Partial<
        Record<(typeof SUBAGENT_ROLE_NAMES)[number], SubagentRoleModel | null>
      >
    | undefined,
  findModel: (
    provider: string,
    model: string,
  ) => { readonly provider: string; readonly id: string } | undefined,
) {
  if (!updates) return current;

  const roleModels = { ...current };
  for (const role of SUBAGENT_ROLE_NAMES) {
    const update = updates[role];
    if (update === undefined) continue;
    if (update === null) {
      delete roleModels[role];
      continue;
    }
    const resolved = findModel(update.provider, update.model);
    if (!resolved) {
      throw new Error(
        `Unknown configured subagent role model for ${role}: ${update.provider}/${update.model}`,
      );
    }
    roleModels[role] = { provider: resolved.provider, model: resolved.id };
  }
  return roleModels;
}

export function buildInteractiveSetupPrompt(options: {
  currentConfiguration: string;
  currentModel: string;
  currentThinking: string;
  savedConfigExists: boolean;
}) {
  const configurationState = options.savedConfigExists
    ? [
        "This package has already been configured. Explain the current settings in the user's language, then ask whether they want to keep them or change Capability discovery, Next-action suggestions, Workflow limits, UI/Footer, result detail display, Post-edit, Agent role models, or review everything.",
        "If the user keeps the current settings, do not call configure_my_pi_setup. If they choose a category, ask only the follow-up needed for that category.",
      ]
    : [
        "This is the first setup. Explain the available choices and their impact in the user's language, then collect the initial preferences.",
        "Prefer one ask_user call with up to three independent questions covering Capability discovery plus Workflow limits, Next-action suggestions, and UI/Footer/result display. Explain that Post-edit defaults off; keep it off unless the user opts in, then ask only for the command. Explain that built-in Agent roles used by subagent_spawn and workflow agent_type inherit the parent model unless the user assigns an available model to a role.",
      ];

  return [
    "Guide me through configuring the installed OpenPI package interactively.",
    "",
    "Current configuration:",
    options.currentConfiguration,
    `Current Pi model: ${options.currentModel}`,
    `Current Pi thinking level: ${options.currentThinking}`,
    `Saved configuration exists: ${options.savedConfigExists ? "yes" : "no"}`,
    "",
    ...configurationState,
    "",
    "Before asking, briefly explain what can be configured and the practical impact:",
    "- Capability discovery: explicit is the safe default and keeps OpenPI model tools absent until the user asks for a capability. adaptive is opt-in and keeps only the small openpi_load_tools gateway visible, allowing the model to load Subagents, Workflows, background terminals, structured search, or Session tracking when it judges them useful. Loaded groups remain session-stable, and normal permission, concurrency, and workflow limits still apply.",
    "- Next-action suggestions: disabled, or model-generated after a fully settled main-agent run. A suggestion appears as dim inline text on the first row of an empty editor; reserved cells at the row end keep CJK IME preedit from overwriting it. Right accepts it without submitting, and any other editor input dismisses it. Enabling requires an available provider/model and reasoning level and adds one small model call per settled run.",
    "- Workflow fan-out: concurrency controls simultaneous agents and resource pressure; max agent calls controls the total capacity of one workflow. Valid ranges are 1-64 and 1-1024.",
    "- UI: the large header costs vertical space; the custom footer is a declarative dashboard. Presets: powerline (one-line ANSI256 blocks), powerline-mono (one-line high-contrast gray powerline), and compact (one-line plain text); the default is plain with model/context on the left and git/pr/cwd on the right. Style can also be set independently: plain, powerline, powerline-mono. Custom lines are a 2D layout of cwd/model/thinking/context/cache/cost/throughput/git/pr plus at most one flex per line for left/right alignment. Footer metrics use Codicon outline glyphs for model, context, and directory; a Nerd Font renders them as designed while the text stays readable without it. Changes apply immediately in the active TUI session.",
    "- Operational activity for Subagents, Workflows, and background terminals is core status and always remains visible whenever the custom footer is enabled.",
    "- Post-edit command: one optional shell command (maximum 500 characters) run in the background after a turn with successful Write/Edit operations (e.g. `npm run format`). Off by default, interactive TUI sessions only, failures surface as a notification. This is a single command, not an event-hook system.",
    "- Result detail display: Subagent results, Bash operations, and Write/Edit operations can each default to full or compact. Compact Subagent results show only bounded status rows and keep raw child reports behind app.tools.expand; compact Bash and Write/Edit operations use one-line semantic activity summaries. Read, grep, find, and ls use the same compact activity-row projection. Ctrl+O restores Pi's native full arguments, output, errors, diffs, and timing. Bash and Write/Edit default to compact. Recommend compact for users who scan activity first and inspect evidence on demand.",
    "- Agent role models: built-in explorer, implementer, reviewer, and advisor roles are shared by subagent_spawn and workflow agent_type, and inherit the parent model by default. Assign only an available registry model to an individual role when needed; clearing that role returns it to inheritance. Custom agent-type files still override a built-in role's complete definition.",
    "- Intercom: optional cross-session messaging is installed only after a native setup confirmation. It stays parent-only; Direct/Workflow children and Replay cannot use it. The status above is informational for this model-guided step—do not install packages or edit its config yourself.",
    "",
    "Natural-language configuration examples the user might ask for:",
    '- "let the model discover OpenPI capabilities when useful" → capability_discovery=adaptive',
    '- "only use OpenPI capabilities when I ask" → capability_discovery=explicit',
    '- "switch footer to powerline" → ui_footer_preset=powerline',
    '- "use mono powerline" → ui_footer_preset=powerline-mono',
    '- "compact footer" → ui_footer_preset=compact',
    '- "two custom lines: cwd flex model / context cost flex git" → ui_footer_lines=[["cwd","flex","model"],["context","cost","flex","git"]]',
    '- "run npm run format after Write/Edit turns" → post_edit_command="npm run format"',
    '- "turn off post-edit" → post_edit_command=""',
    '- "make explorer use my available fast model" → subagent_role_models={explorer:{provider:"…",model:"…"}}',
    '- "make explorer inherit again" → subagent_role_models={explorer:null}',
    "",
    "Use ask_user for the decision instead of merely printing instructions. Put the recommended choice first. Do not change configuration until the choices are clear. Then call configure_my_pi_setup at most once with the final requested changes, preserving everything else. Do not edit configuration files directly.",
  ];
}

const safeSetupNotice = (value: unknown, maximum = 500) =>
  sanitizeTerminalText(value instanceof Error ? value.message : String(value))
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maximum);

export function buildSetupSuccessText(
  currentConfiguration: string,
  normalizationNote = "",
) {
  return [
    `Updated OpenPI setup. ${currentConfiguration}${normalizationNote}`,
    "This setup episode is complete; configure_my_pi_setup is now hidden. Do not call it again. Do not edit configuration files directly. If the user requests another configuration change, tell them to run /openpi-setup <request> to start a new setup episode.",
  ].join(" ");
}

export function shouldOfferPiIntercom(options: {
  readonly request: string;
  readonly status: PiIntercomStatus;
  readonly mode: ExtensionCommandContext["mode"];
  readonly idle: boolean;
}) {
  return (
    !options.request &&
    !options.status.active &&
    !options.status.installed &&
    !options.status.diagnostic &&
    options.mode === "tui" &&
    options.idle
  );
}

async function maybeOfferPiIntercom(
  ctx: ExtensionCommandContext,
  status: PiIntercomStatus,
  request: string,
) {
  if (
    !shouldOfferPiIntercom({
      request,
      status,
      mode: ctx.mode,
      idle: ctx.isIdle(),
    })
  ) {
    return status;
  }

  const accepted = await ctx.ui.confirm(
    status.configured
      ? "Repair optional pi-intercom integration?"
      : "Install optional pi-intercom integration?",
    [
      "pi-intercom enables cross-session messaging through a local IPC broker.",
      "Like every Pi package, it runs with full system access.",
      "OpenPI will install npm:pi-intercom globally. A new private config gets safe defaults; an existing preference file is never rewritten and must already define both fields:",
      "• confirmSend: true",
      '• inboundTrigger: "replies"',
      "It remains parent-only and activates after /reload.",
    ].join("\n"),
  );
  if (!accepted) return status;

  ctx.ui.setWorkingMessage("Installing optional pi-intercom integration...");
  try {
    await installPiIntercom({
      cwd: ctx.cwd,
      onProgress: (event) =>
        ctx.ui.setWorkingMessage(
          safeSetupNotice(
            event.message ?? "Installing optional pi-intercom integration...",
            200,
          ),
        ),
    });
    const installed = inspectPiIntercom({
      cwd: ctx.cwd,
      active: false,
    });
    const next = { ...installed, reloadRequired: true };
    ctx.ui.notify(
      "pi-intercom installed with existing preferences preserved or a new safe config created. Run /reload after setup to activate it.",
      "info",
    );
    return next;
  } catch (error) {
    ctx.ui.notify(
      `pi-intercom was not enabled: ${safeSetupNotice(error)}`,
      "error",
    );
    return inspectPiIntercom({ cwd: ctx.cwd, active: false });
  } finally {
    ctx.ui.setWorkingMessage();
  }
}

export const CONFIGURE_MY_PI_SETUP_TOOL_NAME = "configure_my_pi_setup";

type SetupEpisode = "idle" | "armed" | "active";

function showConfigureTool(pi: ExtensionAPI) {
  patchOwnedTools(pi, "setup", {
    enable: [CONFIGURE_MY_PI_SETUP_TOOL_NAME],
  });
}

function hideConfigureTool(pi: ExtensionAPI) {
  patchOwnedTools(pi, "setup", {
    disable: [CONFIGURE_MY_PI_SETUP_TOOL_NAME],
  });
}

export default function openPiSetup(pi: ExtensionAPI) {
  let episode: SetupEpisode = "idle";
  const publishEpisode = () =>
    pi.events.emit(OPENPI_SETUP_EPISODE_CHANNEL, {
      active: episode !== "idle",
    } satisfies OpenPiSetupEpisodeState);

  const endEpisode = () => {
    episode = "idle";
    hideConfigureTool(pi);
    publishEpisode();
  };

  pi.on("session_start", () => {
    endEpisode();
  });

  pi.on("agent_start", () => {
    if (episode === "armed") {
      episode = "active";
      publishEpisode();
    }
  });

  pi.on("tool_execution_end", (event) => {
    if (
      episode === "active" &&
      event.toolName === CONFIGURE_MY_PI_SETUP_TOOL_NAME &&
      !event.isError
    ) {
      endEpisode();
    }
  });

  pi.on("agent_settled", () => {
    if (episode === "active") endEpisode();
  });

  pi.registerTool({
    name: "configure_my_pi_setup",
    label: "Configure OpenPI",
    description:
      "Apply a user-requested configuration change for this Pi setup. Configures capability discovery (explicit or opt-in adaptive), next-action suggestions, workflow fan-out, UI/Footer (presets, style, multi-line layout), result detail display, optional Post-edit, and built-in Agent-role model assignments shared by subagent_spawn and workflow agent_type. Role models must be available in the Pi registry; null clears a role back to parent-model inheritance. Footer examples: powerline preset, powerline-mono, compact, or custom ui_footer_lines with flex. Preserve current values for settings the user did not ask to change. Changes apply immediately to the capability gateway and active TUI footer.",
    parameters: Type.Object({
      capability_discovery: Type.Optional(
        StringEnum(CAPABILITY_DISCOVERY_MODES, {
          description:
            "Capability adoption policy. explicit keeps OpenPI tools absent until the user asks for a capability; adaptive keeps only the small openpi_load_tools gateway visible so the model may load a useful group on its own. Adaptive can start expensive work such as Subagents or Workflows, so it is opt-in. Omit to preserve the current value.",
        }),
      ),
      suggestions_enabled: Type.Optional(
        Type.Boolean({
          description:
            "Whether model-generated next-action ghost suggestions are enabled. Omit to preserve the current value.",
        }),
      ),
      suggestion_provider: Type.Optional(
        Type.String({ description: "Configured Pi provider id." }),
      ),
      suggestion_model: Type.Optional(
        Type.String({ description: "Configured Pi model id." }),
      ),
      suggestion_reasoning: Type.Optional(
        StringEnum(REASONING_LEVELS, {
          description: "Reasoning level for the suggestion model.",
        }),
      ),
      workflow_concurrency: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: MAX_WORKFLOW_CONCURRENCY,
          description:
            "Maximum simultaneously running agents in each workflow (default 8, hard maximum 64). Omit to preserve the current value.",
        }),
      ),
      workflow_max_agent_calls: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: MAX_WORKFLOW_AGENT_CALLS,
          description:
            "Maximum total agent() calls in each workflow (default 128, hard maximum 1024). Omit to preserve the current value.",
        }),
      ),
      ui_show_header: Type.Optional(
        Type.Boolean({
          description:
            "Whether to show the large decorative Pi header. Defaults to false; omit to preserve the current value.",
        }),
      ),
      ui_custom_footer: Type.Optional(
        Type.Boolean({
          description:
            "Whether to replace Pi's footer with the package dashboard footer. Defaults to true; omit to preserve the current value.",
        }),
      ),
      ui_footer_preset: Type.Optional(
        StringEnum(FOOTER_PRESETS, {
          description:
            "Convenient footer preset applied first: powerline (one-line ANSI256 blocks), powerline-mono (one-line gray powerline), compact (one-line plain text). Style/lines overrides still win after the preset. Omit to preserve the current layout unless other footer fields are set.",
        }),
      ),
      ui_footer_style: Type.Optional(
        StringEnum(FOOTER_STYLES, {
          description:
            "Footer visual style: plain (Pi theme separators), powerline (ANSI256 colored blocks with  seams), powerline-mono (high-contrast gray powerline). A Nerd Font renders Codicon metric glyphs and powerline seams as designed; text stays readable without it. Omit to preserve the current style (or the preset's style when a preset is applied).",
        }),
      ),
      ui_footer_lines: Type.Optional(
        Type.Array(
          Type.Array(StringEnum(FOOTER_LAYOUT_ITEMS), { minItems: 1 }),
          {
            minItems: 1,
            description:
              "Declarative multi-line footer layout. Each row is an ordered list of metrics (cwd, model, thinking, context, cache, cost, throughput, git, pr) plus at most one flex for left/right alignment. Unknown/duplicate metrics are dropped; empty result falls back to the default. Cannot be combined with ui_footer_items.",
          },
        ),
      ),
      ui_footer_items: Type.Optional(
        Type.Array(StringEnum(FOOTER_ITEMS), {
          minItems: 1,
          uniqueItems: true,
          description:
            "Legacy flat footer metric selection. Mapped onto the default one-line skeleton (metrics not listed are hidden). Prefer ui_footer_lines for custom multi-line layouts. Cannot be combined with ui_footer_lines. Operational activity remains visible whenever the custom footer is enabled. Omit to preserve the current selection.",
        }),
      ),
      subagent_result_display: Type.Optional(
        StringEnum(DETAIL_DISPLAYS, {
          description:
            "How completed Subagent results render by default: full shows complete output; compact shows only bounded status rows while app.tools.expand reveals the full child report. Omit to preserve the current value.",
        }),
      ),
      bash_tool_display: Type.Optional(
        StringEnum(DETAIL_DISPLAYS, {
          description:
            "How Bash commands and output render by default: compact shows one semantic activity row with running/success/failure state; app.tools.expand restores Pi's native command, output, error, timing, and full-output metadata. Full keeps Pi's native rendering expanded by default. Omit to preserve the current value.",
        }),
      ),
      file_mutation_display: Type.Optional(
        StringEnum(DETAIL_DISPLAYS, {
          description:
            "How Write/Edit content and diffs render by default: compact shows one semantic activity row with path, status, and line/diff counts; app.tools.expand restores Pi's native preview, output, error, and diff. Full keeps Pi's native rendering expanded by default. Omit to preserve the current value.",
        }),
      ),
      subagent_role_models: Type.Optional(SUBAGENT_ROLE_MODELS_SCHEMA),
      post_edit_command: Type.Optional(
        Type.String({
          maxLength: POST_EDIT_COMMAND_MAX_CHARS,
          description:
            'A single shell command (maximum 500 characters) to run in the background after a turn with successful Write/Edit operations, e.g. "npm run format". Runs once per changed turn, not per edit, and only in an interactive TUI session. Set to an empty string to turn it off. Omit to preserve the current value.',
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const modelFields = [
        params.suggestion_provider,
        params.suggestion_model,
        params.suggestion_reasoning,
      ];
      const supplied = modelFields.filter(
        (value) => value !== undefined,
      ).length;
      if (supplied !== 0 && supplied !== modelFields.length) {
        throw new Error(
          "suggestion_provider, suggestion_model, and suggestion_reasoning must be provided together, or all omitted.",
        );
      }

      const buildConfig = (current: MyPiSetupConfig) => {
        let model = current.suggestions.model;
        if (params.suggestion_provider && params.suggestion_model) {
          const resolved = ctx.modelRegistry.find(
            params.suggestion_provider,
            params.suggestion_model,
          );
          if (!resolved) {
            throw new Error(
              `Unknown configured model: ${params.suggestion_provider}/${params.suggestion_model}`,
            );
          }
          model = {
            provider: resolved.provider,
            model: resolved.id,
            reasoning: params.suggestion_reasoning!,
          };
        }
        const suggestionsEnabled =
          params.suggestions_enabled ??
          (params.suggestion_provider ? true : current.suggestions.enabled);
        if (suggestionsEnabled && !model) {
          throw new Error(
            "Next-action suggestions require suggestion_provider, suggestion_model, and suggestion_reasoning.",
          );
        }

        const footer = applyFooterConfig(
          {
            footerStyle: current.ui.footerStyle,
            footerLines: current.ui.footerLines,
          },
          {
            ...(params.ui_footer_preset !== undefined
              ? { preset: params.ui_footer_preset as FooterPreset }
              : {}),
            ...(params.ui_footer_style !== undefined
              ? { style: params.ui_footer_style as FooterStyle }
              : {}),
            ...(params.ui_footer_lines !== undefined
              ? {
                  lines: params.ui_footer_lines as FooterLayoutItem[][],
                }
              : {}),
            ...(params.ui_footer_items !== undefined
              ? { items: params.ui_footer_items }
              : {}),
          },
        );

        const config: MyPiSetupConfig = {
          capabilities: {
            discovery:
              (params.capability_discovery as
                | CapabilityDiscoveryMode
                | undefined) ?? current.capabilities.discovery,
          },
          suggestions: {
            enabled: suggestionsEnabled,
            ...(model ? { model } : {}),
          },
          workflows: {
            concurrency:
              params.workflow_concurrency ?? current.workflows.concurrency,
            maxAgentCalls:
              params.workflow_max_agent_calls ??
              current.workflows.maxAgentCalls,
          },
          ui: {
            showHeader: params.ui_show_header ?? current.ui.showHeader,
            customFooter: params.ui_custom_footer ?? current.ui.customFooter,
            ...footer,
            subagentResultDisplay:
              params.subagent_result_display ??
              current.ui.subagentResultDisplay,
            bashToolDisplay:
              params.bash_tool_display ?? current.ui.bashToolDisplay,
            fileMutationDisplay:
              params.file_mutation_display ?? current.ui.fileMutationDisplay,
          },
          postEdit: {
            command:
              params.post_edit_command !== undefined
                ? params.post_edit_command.trim()
                : current.postEdit.command,
          },
          subagents: {
            roleModels: applySubagentRoleModelUpdates(
              current.subagents.roleModels,
              params.subagent_role_models,
              (provider, modelId) => ctx.modelRegistry.find(provider, modelId),
            ),
          },
        };
        return config;
      };

      // Patch the document as it is on disk now, not as it was when this call
      // started, and report any stored value that was normalized or migrated.
      const { config, replaced } = await updateSetupConfig(buildConfig);
      pi.events.emit(SETUP_CONFIG_CHANGED_CHANNEL, config);
      const text = formatSetupConfig(config);
      const note =
        replaced.length > 0
          ? ` Normalized or migrated stored values: ${replaced.join(", ")}.`
          : "";
      if (ctx.hasUI) ctx.ui.notify(`${text}${note}`, "info");
      return {
        content: [{ type: "text", text: buildSetupSuccessText(text, note) }],
        details: config,
      };
    },
  });

  const setupHandler = async (args: string, ctx: ExtensionCommandContext) => {
    const request = args.trim();
    let intercomStatus = inspectPiIntercom({
      cwd: ctx.cwd,
      active: pi.getAllTools().some(({ name }) => name === "intercom"),
    });
    intercomStatus = await maybeOfferPiIntercom(ctx, intercomStatus, request);

    const currentConfiguration = formatSetupConfig(loadSetupConfig(), [
      formatPiIntercomStatus(intercomStatus),
    ]);
    const savedConfigExists = hasSavedSetupConfig();
    const currentModel = ctx.model
      ? `${ctx.model.provider}/${ctx.model.id}`
      : "unavailable";
    const currentThinking = pi.getThinkingLevel();

    const prompt = request
      ? [
          "Configure the installed OpenPI package according to this request:",
          request,
          "",
          "Current configuration:",
          currentConfiguration,
          "",
          "Capability discovery is explicit by default; adaptive is an opt-in that keeps only openpi_load_tools visible so the model may load useful groups. Footer tips: presets are powerline, powerline-mono, compact; style is plain/powerline/powerline-mono; custom layouts use ui_footer_lines (2D enum arrays with optional flex). Do not use ui_footer_items together with ui_footer_lines. Built-in Agent role models (explorer, implementer, reviewer, advisor) are shared by subagent_spawn and workflow agent_type; they inherit the parent unless assigned an available registry model, and clearing an assignment restores inheritance. Custom agent-type files still override built-in role definitions. A Nerd Font renders Footer Codicons and powerline seams as designed; text stays readable without it. Changes apply immediately in the active TUI session. Intercom installation is handled only by the native setup confirmation; do not install packages or edit its config yourself.",
          "",
          "Use configure_my_pi_setup to apply only the requested OpenPI-owned changes and preserve everything else. Interpret model names from the available Pi registry. Do not edit configuration files directly.",
        ]
      : buildInteractiveSetupPrompt({
          currentConfiguration,
          currentModel,
          currentThinking,
          savedConfigExists,
        });

    episode = "armed";
    showConfigureTool(pi);
    publishEpisode();
    pi.sendUserMessage(
      prompt.join("\n"),
      ctx.isIdle() ? undefined : { deliverAs: "followUp" },
    );
  };

  pi.registerCommand("openpi-setup", {
    description: "View or change OpenPI configuration in natural language",
    handler: setupHandler,
  });
  pi.registerCommand("my-pi-setup", {
    description: "Legacy alias — use /openpi-setup",
    handler: setupHandler,
  });
}
