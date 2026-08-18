import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import {
  loadSetupConfig,
  SETUP_CONFIG_CHANGED_CHANNEL,
  type MyPiSetupConfig,
} from "../shared/setup-config.ts";
import {
  getLoadedOpenPiCapabilities,
  loadOpenPiCapabilities,
  OPENPI_CAPABILITY_GROUPS,
  OPENPI_CAPABILITY_NAMES,
  OPENPI_TOOL_SURFACE,
  type OpenPiCapability,
  patchOwnedTools,
  resetOpenPiToolSurface,
} from "../shared/tool-surface.ts";

const CapabilitySchema = Type.Enum(OPENPI_CAPABILITY_NAMES);

const OpenPiLoadToolsParameters = Type.Object({
  groups: Type.Optional(
    Type.Array(CapabilitySchema, {
      minItems: 1,
      maxItems: OPENPI_CAPABILITY_NAMES.length,
      uniqueItems: true,
      description: "Groups to load; omit to list.",
    }),
  ),
});

type OpenPiLoadToolsInput = Static<typeof OpenPiLoadToolsParameters>;

const CAPABILITY_INTENT = {
  search:
    /\b(?:use|run)\s+(?:fd|rg)\b|\buse\s+(?:structured\s+)?(?:(?:file|code|content)\s+)?search\b|\b(?:structured|fast)\s+(?:file|code|content)\s+search\b|(?:使用|运行).{0,8}(?:fd|rg)|结构化(?:文件|代码|内容)搜索/iu,
  delegate:
    /\b(?:use|spawn|run)\s+(?:an?\s+|multiple\s+|several\s+|two\s+)?(?:pi\s+)?subagents?\b|(?:^|[.!?]\s+)(?:please\s+)?(?:delegate|parallelize)\s+(?:this|the)\s+(?:task|work)\b|\b(?:can|could|would)\s+you\s+(?:please\s+)?(?:delegate|parallelize)\s+(?:this|the)\s+(?:task|work)\b|\bparallel\s+agents?\b|(?:使用|启动|调用|来|开).{0,8}子代理|(?:多个?|多路)子代理|并行.{0,8}(?:代理|agent)|委派.{0,6}任务/iu,
  workflow:
    /\b(?:use|run|create|build)\s+(?:(?:an?|the)\s+)?(?:openpi\s+)?workflow\b|(?:使用|运行|创建|构建).{0,8}工作流/iu,
  background:
    /\b(?:run|start|keep)\b.{0,40}\b(?:in the background|background\s+(?:process|terminal|job))\b|后台.{0,8}(?:运行|进程|终端|任务)/iu,
  session:
    /\b(?:create|set|update|track)\s+(?:an?\s+)?(?:session\s+)?(?:goal|task list|tasks)\b|(?:设置|创建|更新|跟踪|追踪).{0,8}(?:目标|任务)/iu,
} as const satisfies Record<OpenPiCapability, RegExp>;

const CAPABILITY_GATEWAY_INTENT =
  /\bopenpi\s+(?:capabilit(?:y|ies)|tools?|features?)\b|openpi.{0,8}(?:能力|工具|功能)/iu;

const CONDITIONAL_OR_NEGATED_INTENT =
  /^(?:\s*(?:only\s+)?(?:if|when|unless|before|in case)\b)|\b(?:do not|don't|cannot|can't|not|no|never|avoid)\b|\b(?:if|unless)\b|\bwhen\s+(?:needed|required|necessary)\b|(?:如果|若|假如|除非|仅当|需要时|不要|不能|不用|不必|无需|避免|请勿|禁止)/iu;

const CAPABILITY_SKILLS: Partial<Record<OpenPiCapability, string>> = {
  delegate: fileURLToPath(
    new URL("../../skills/subagents/SKILL.md", import.meta.url),
  ),
  workflow: fileURLToPath(
    new URL("../../skills/workflows/SKILL.md", import.meta.url),
  ),
  background: fileURLToPath(
    new URL("../../skills/background-terminals/SKILL.md", import.meta.url),
  ),
};

function capabilitiesRequestedByPrompt(prompt: string) {
  const clauses = prompt.split(/[\n.!?。！？;；]+/u);
  return OPENPI_CAPABILITY_NAMES.filter((capability) =>
    clauses.some(
      (clause) =>
        !CONDITIONAL_OR_NEGATED_INTENT.test(clause) &&
        CAPABILITY_INTENT[capability].test(clause),
    ),
  );
}

function requestsCapabilityGateway(prompt: string) {
  return prompt
    .split(/[\n.!?。！？;；]+/u)
    .some(
      (clause) =>
        !CONDITIONAL_OR_NEGATED_INTENT.test(clause) &&
        CAPABILITY_GATEWAY_INTENT.test(clause),
    );
}

function capabilitySkillPaths(capabilities: readonly OpenPiCapability[]) {
  return capabilities.flatMap((capability) => {
    const skill = CAPABILITY_SKILLS[capability];
    return skill ? [skill] : [];
  });
}

function skillGuidance(capabilities: readonly OpenPiCapability[]) {
  const skills = capabilitySkillPaths(capabilities);
  return skills.length > 0
    ? `Before first use, read the matching OpenPI capability guidance: ${skills.join(", ")}.`
    : "";
}

interface CapabilityExtensionDependencies {
  readonly loadConfig: () => Pick<MyPiSetupConfig, "capabilities">;
  readonly sourcePath?: string;
}

export function createCapabilitiesExtension(
  dependencies: CapabilityExtensionDependencies = {
    loadConfig: loadSetupConfig,
  },
) {
  return function capabilities(pi: ExtensionAPI) {
    const reconcileDiscoveryGateway = () => {
      const adaptive =
        dependencies.loadConfig().capabilities.discovery === "adaptive";
      patchOwnedTools(pi, "capabilities", {
        ...(adaptive
          ? { enable: OPENPI_TOOL_SURFACE.capabilities.entry }
          : { disable: OPENPI_TOOL_SURFACE.capabilities.entry }),
      });
    };

    pi.events.on(SETUP_CONFIG_CHANGED_CHANNEL, reconcileDiscoveryGateway);

    pi.on("session_start", () => {
      resetOpenPiToolSurface(
        pi,
        dependencies.sourcePath
          ? { capabilities: dependencies.sourcePath }
          : undefined,
      );
      reconcileDiscoveryGateway();
    });

    pi.on("before_agent_start", (event) => {
      if (requestsCapabilityGateway(event.prompt)) {
        patchOwnedTools(pi, "capabilities", {
          enable: OPENPI_TOOL_SURFACE.capabilities.entry,
        });
      }
      const requested = capabilitiesRequestedByPrompt(event.prompt);
      if (requested.length > 0) loadOpenPiCapabilities(pi, requested);
      const guidance = skillGuidance(requested);
      if (guidance) {
        return {
          message: {
            customType: "openpi-capability-guidance",
            content: guidance,
            display: false,
            details: { capabilities: requested },
          },
        };
      }
    });

    pi.registerTool({
      name: "openpi_load_tools",
      label: "Load OpenPI Tools",
      description:
        "Load optional OpenPI groups only when useful: search, delegate, workflow, background, or session. Ordinary file and shell work needs none. Loaded groups stay available.",
      parameters: OpenPiLoadToolsParameters,
      async execute(_toolCallId, params: OpenPiLoadToolsInput) {
        const result = params.groups
          ? loadOpenPiCapabilities(pi, params.groups)
          : {
              newlyLoaded: [],
              loaded: getLoadedOpenPiCapabilities(pi),
              activatedTools: [],
            };
        const available = OPENPI_CAPABILITY_NAMES.map((name) => ({
          name,
          summary: OPENPI_CAPABILITY_GROUPS[name].summary,
          loaded: result.loaded.includes(name),
        }));
        const text = params.groups
          ? result.newlyLoaded.length > 0
            ? `Loaded OpenPI capabilities: ${result.newlyLoaded.join(", ")}. Activated tools: ${result.activatedTools.join(", ") || "none yet"}.${skillGuidance(result.newlyLoaded) ? ` ${skillGuidance(result.newlyLoaded)}` : ""}`
            : `Requested OpenPI capabilities were already loaded: ${result.loaded.join(", ") || "none"}.`
          : `Available OpenPI capabilities:\n${available
              .map(
                ({ name, summary, loaded }) =>
                  `- ${name}${loaded ? " (loaded)" : ""}: ${summary}`,
              )
              .join("\n")}`;
        return {
          content: [{ type: "text" as const, text }],
          details: {
            available,
            loaded: result.loaded,
            newlyLoaded: result.newlyLoaded,
            activatedTools: result.activatedTools,
          },
        };
      },
    });
  };
}

export default createCapabilitiesExtension();
