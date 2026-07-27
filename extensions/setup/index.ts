import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
  formatSetupConfig,
  loadSetupConfig,
  REASONING_LEVELS,
  saveSetupConfig,
} from "../shared/setup-config.ts";

export default function myPiSetup(pi: ExtensionAPI) {
  pi.registerTool({
    name: "configure_my_pi_setup",
    label: "Configure My Pi Setup",
    description:
      "Apply a user-requested configuration change for this Pi setup. Currently configures run recaps: enable or disable them, and optionally choose the summary provider, model, and reasoning level. Omit provider/model/reasoning to use the free local fallback without model calls.",
    parameters: Type.Object({
      summaries_enabled: Type.Boolean({
        description: "Whether run recap cards are enabled.",
      }),
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

      let model;
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
          enabled: params.summaries_enabled,
          ...(model ? { model } : {}),
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
          "Use configure_my_pi_setup to apply it. Interpret the request from the available Pi models and current configuration. Do not edit configuration files directly.",
        ].join("\n"),
        ctx.isIdle() ? undefined : { deliverAs: "followUp" },
      );
    },
  });
}
