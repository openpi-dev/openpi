import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
  FOOTER_ITEMS,
  formatSetupConfig,
  hasSavedSetupConfig,
  loadSetupConfig,
  MAX_WORKFLOW_AGENT_CALLS,
  MAX_WORKFLOW_CONCURRENCY,
  REASONING_LEVELS,
  saveSetupConfig,
  SUBAGENT_RESULT_DISPLAYS,
} from "../shared/setup-config.ts";

export function buildInteractiveSetupPrompt(options: {
  currentConfiguration: string;
  currentModel: string;
  currentThinking: string;
  savedConfigExists: boolean;
}) {
  const configurationState = options.savedConfigExists
    ? [
        "This package has already been configured. Explain the current settings in the user's language, then ask whether they want to keep them or change Recaps, Workflow limits, UI/Footer, Subagent result display, or review everything.",
        "If the user keeps the current settings, do not call configure_my_pi_setup. If they choose a category, ask only the follow-up needed for that category.",
      ]
    : [
        "This is the first setup. Explain the available choices and their impact in the user's language, then collect the initial preferences.",
        "Prefer one ask_user call with up to three independent questions covering Recaps, Workflow limits, and UI/Footer.",
      ];

  return [
    "Guide me through configuring the installed my-pi-setup package interactively.",
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
    "- Run recaps: disabled (no recap), local fallback (no model call but mechanical output), or model-generated (better recap with an extra model call). A model recap also chooses provider/model and thinking level.",
    "- Workflow fan-out: concurrency controls simultaneous agents and resource pressure; max agent calls controls the total capacity of one workflow. Valid ranges are 1-64 and 1-1024.",
    "- UI: the large header costs vertical space; the custom footer provides a compact dashboard. Configurable footer metrics are cwd, model, thinking, context, cache hit rate, cost, throughput, git branch, and PR.",
    "- Operational activity for Subagents, Workflows, and background terminals is core status and always remains visible whenever the custom footer is enabled.",
    "- Subagent result display: full preserves the existing behavior and shows complete results by default; compact shows a bounded preview and lets the user expand it with the configured app.tools.expand key (Ctrl+O by default). Recommend compact for users who do not usually inspect implementation details.",
    "",
    "Use ask_user for the decision instead of merely printing instructions. Put the recommended choice first. Do not change configuration until the choices are clear. Then call configure_my_pi_setup at most once with the final requested changes, preserving everything else. Do not edit configuration files directly.",
  ];
}

export default function myPiSetup(pi: ExtensionAPI) {
  pi.registerTool({
    name: "configure_my_pi_setup",
    label: "Configure My Pi Setup",
    description:
      "Apply a user-requested configuration change for this Pi setup. Configures run recaps, workflow fan-out, UI/Footer, and Subagent result display. Preserve current values for settings the user did not ask to change.",
    parameters: Type.Object({
      summaries_enabled: Type.Optional(
        Type.Boolean({
          description:
            "Whether run recap cards are enabled. Omit to preserve the current value.",
        }),
      ),
      summary_use_local_fallback: Type.Optional(
        Type.Boolean({
          description:
            "Set true to clear the configured summary model and use local fallback. Omit unless requested.",
        }),
      ),
      summary_provider: Type.Optional(
        Type.String({ description: "Configured Pi provider id." }),
      ),
      summary_model: Type.Optional(
        Type.String({ description: "Configured Pi model id." }),
      ),
      summary_reasoning: Type.Optional(
        StringEnum(REASONING_LEVELS, {
          description: "Reasoning level for the summary model.",
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
      ui_footer_items: Type.Optional(
        Type.Array(StringEnum(FOOTER_ITEMS), {
          minItems: 1,
          uniqueItems: true,
          description:
            "Dashboard footer metrics to display, in this order: cwd, model, thinking, context, cache, cost, throughput, git, pr. Operational activity remains visible whenever the custom footer is enabled. Omit to preserve the current selection.",
        }),
      ),
      subagent_result_display: Type.Optional(
        StringEnum(SUBAGENT_RESULT_DISPLAYS, {
          description:
            "How completed Subagent results render by default: full preserves complete output; compact shows a bounded preview that can be expanded with app.tools.expand. Omit to preserve the current value.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const modelFields = [
        params.summary_provider,
        params.summary_model,
        params.summary_reasoning,
      ];
      const supplied = modelFields.filter(
        (value) => value !== undefined,
      ).length;
      if (supplied !== 0 && supplied !== modelFields.length) {
        throw new Error(
          "summary_provider, summary_model, and summary_reasoning must be provided together, or all omitted for local fallback.",
        );
      }

      const current = loadSetupConfig();
      let model = current.summaries.model;
      if (params.summary_use_local_fallback) model = undefined;
      if (params.summary_provider && params.summary_model) {
        const resolved = ctx.modelRegistry.find(
          params.summary_provider,
          params.summary_model,
        );
        if (!resolved) {
          throw new Error(
            `Unknown configured model: ${params.summary_provider}/${params.summary_model}`,
          );
        }
        model = {
          provider: resolved.provider,
          model: resolved.id,
          reasoning: params.summary_reasoning!,
        };
      }

      const config = {
        summaries: {
          enabled: params.summaries_enabled ?? current.summaries.enabled,
          ...(model ? { model } : {}),
        },
        workflows: {
          concurrency:
            params.workflow_concurrency ?? current.workflows.concurrency,
          maxAgentCalls:
            params.workflow_max_agent_calls ?? current.workflows.maxAgentCalls,
        },
        ui: {
          showHeader: params.ui_show_header ?? current.ui.showHeader,
          customFooter: params.ui_custom_footer ?? current.ui.customFooter,
          footerItems: params.ui_footer_items ?? current.ui.footerItems,
          subagentResultDisplay:
            params.subagent_result_display ?? current.ui.subagentResultDisplay,
        },
      };
      await saveSetupConfig(config);
      const text = formatSetupConfig(config);
      if (ctx.hasUI) ctx.ui.notify(text, "info");
      return {
        content: [{ type: "text", text: `Updated my Pi setup. ${text}` }],
        details: config,
      };
    },
  });

  pi.registerCommand("my-pi-setup", {
    description:
      "View or change this package's configuration in natural language",
    handler: async (args, ctx) => {
      const request = args.trim();
      const currentConfiguration = formatSetupConfig(loadSetupConfig());
      const savedConfigExists = hasSavedSetupConfig();
      const currentModel = ctx.model
        ? `${ctx.model.provider}/${ctx.model.id}`
        : "unavailable";
      const currentThinking = pi.getThinkingLevel();

      const prompt = request
        ? [
            "Configure the installed my-pi-setup package according to this request:",
            request,
            "",
            "Current configuration:",
            currentConfiguration,
            "",
            "Use configure_my_pi_setup to apply only the requested changes and preserve everything else. Interpret model names from the available Pi registry. Do not edit configuration files directly.",
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
    },
  });
}
