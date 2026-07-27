import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
  formatSetupConfig,
  loadSetupConfig,
  MAX_WORKFLOW_AGENT_CALLS,
  MAX_WORKFLOW_CONCURRENCY,
  REASONING_LEVELS,
  saveSetupConfig,
} from "../shared/setup-config.ts";

export default function myPiSetup(pi: ExtensionAPI) {
  pi.registerTool({
    name: "configure_my_pi_setup",
    label: "Configure My Pi Setup",
    description:
      "Apply a user-requested configuration change for this Pi setup. Configures run recaps and workflow fan-out. Preserve current values for settings the user did not ask to change.",
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
      if (!request) {
        ctx.ui.notify(
          [
            formatSetupConfig(loadSetupConfig()),
            "",
            "Examples:",
            "/my-pi-setup 摘要使用 seal/deepseek-v4-flash，关闭推理",
            "/my-pi-setup 关闭自动摘要",
            "/my-pi-setup 摘要改用本地 fallback，不调用模型",
            "/my-pi-setup workflow 同时跑 16 个 agent，总任务最多 256 个",
          ].join("\n"),
          "info",
        );
        return;
      }

      pi.sendUserMessage(
        [
          "Configure the installed my-pi-setup package according to this request:",
          request,
          "",
          "Current configuration:",
          formatSetupConfig(loadSetupConfig()),
          "",
          "Use configure_my_pi_setup to apply only the requested changes and preserve everything else. Interpret model names from the available Pi registry. Do not edit configuration files directly.",
        ].join("\n"),
        ctx.isIdle() ? undefined : { deliverAs: "followUp" },
      );
    },
  });
}
