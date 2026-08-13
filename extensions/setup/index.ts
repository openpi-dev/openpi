import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
  SUBAGENT_ROLE_MODELS_SCHEMA,
  applySubagentRoleModelUpdates,
  buildInteractiveSetupPrompt,
  safeSetupNotice,
  shouldOfferPiIntercom,
} from "./domain.ts";
import {
  formatPiIntercomStatus,
  inspectPiIntercom,
  installPiIntercom,
  type PiIntercomStatus,
} from "./intercom.ts";
import {
  applyFooterConfig,
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
  type FooterPreset,
  type FooterStyle,
  type MyPiSetupConfig,
} from "../shared/setup-config.ts";

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

export default function openPiSetup(pi: ExtensionAPI) {
  pi.registerTool({
    name: "configure_my_pi_setup",
    label: "Configure OpenPI",
    description:
      "Apply a user-requested configuration change for this Pi setup: suggestions, workflow fan-out, UI/footer, result display, Post-edit, agent-role models (null clears a role). Preserve settings the user did not ask to change.",
    parameters: Type.Object({
      suggestions_enabled: Type.Optional(
        Type.Boolean({
          description: "Whether next-action ghost suggestions are enabled.",
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
          description: "Max concurrent workflow agents (default 8, hard 64).",
        }),
      ),
      workflow_max_agent_calls: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: MAX_WORKFLOW_AGENT_CALLS,
          description:
            "Max agent() calls per workflow (default 128, hard 1024).",
        }),
      ),
      ui_show_header: Type.Optional(
        Type.Boolean({
          description: "Show the decorative Pi header (default false).",
        }),
      ),
      ui_custom_footer: Type.Optional(
        Type.Boolean({
          description:
            "Replace Pi's footer with the package dashboard footer (default true).",
        }),
      ),
      ui_footer_preset: Type.Optional(
        StringEnum(FOOTER_PRESETS, {
          description:
            "Footer preset applied first; style/lines overrides win after it.",
        }),
      ),
      ui_footer_style: Type.Optional(
        StringEnum(FOOTER_STYLES, {
          description: "Footer visual style (plain/powerline/powerline-mono).",
        }),
      ),
      ui_footer_lines: Type.Optional(
        Type.Array(
          Type.Array(StringEnum(FOOTER_LAYOUT_ITEMS), { minItems: 1 }),
          {
            minItems: 1,
            description:
              "Multi-line footer layout: rows of metrics (cwd/model/thinking/context/cache/cost/throughput/git/pr/flex). Mutually exclusive with ui_footer_items.",
          },
        ),
      ),
      ui_footer_items: Type.Optional(
        Type.Array(StringEnum(FOOTER_ITEMS), {
          minItems: 1,
          uniqueItems: true,
          description:
            "Legacy flat footer metric selection. Mutually exclusive with ui_footer_lines.",
        }),
      ),
      subagent_result_display: Type.Optional(
        StringEnum(DETAIL_DISPLAYS, {
          description: "Subagent result display: full or compact preview.",
        }),
      ),
      bash_tool_display: Type.Optional(
        StringEnum(DETAIL_DISPLAYS, {
          description:
            "Bash output display: compact (one-line + bounded preview) or full.",
        }),
      ),
      file_mutation_display: Type.Optional(
        StringEnum(DETAIL_DISPLAYS, {
          description: "Write/Edit display: compact folded preview or full.",
        }),
      ),
      subagent_role_models: Type.Optional(SUBAGENT_ROLE_MODELS_SCHEMA),
      post_edit_command: Type.Optional(
        Type.String({
          maxLength: POST_EDIT_COMMAND_MAX_CHARS,
          description:
            "Shell command run after turns with Write/Edit (empty string disables).",
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
        content: [
          { type: "text", text: `Updated OpenPI setup. ${text}${note}` },
        ],
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
          "Footer tips: presets are powerline, powerline-mono, compact; style is plain/powerline/powerline-mono; custom layouts use ui_footer_lines (2D enum arrays with optional flex). Do not use ui_footer_items together with ui_footer_lines. Built-in Agent role models (explorer, implementer, reviewer, advisor) are shared by subagent_spawn and workflow agent_type; they inherit the parent unless assigned an available registry model, and clearing an assignment restores inheritance. Custom agent-type files still override built-in role definitions. Nerd Font only affects powerline separator glyphs. Changes apply immediately in the active TUI session. Intercom installation is handled only by the native setup confirmation; do not install packages or edit its config yourself.",
          "",
          "Use configure_my_pi_setup to apply only the requested OpenPI-owned changes and preserve everything else. Interpret model names from the available Pi registry. Do not edit configuration files directly.",
        ]
      : buildInteractiveSetupPrompt({
          currentConfiguration,
          currentModel,
          currentThinking,
          savedConfigExists,
        });

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
