import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import {
  capabilitiesRequestedByPrompt,
  requestsCapabilityGateway,
} from "../shared/capability-intent.ts";
import {
  registerEditorLayer,
  removeEditorLayer,
} from "../shared/editor-layers.ts";
import {
  loadSetupConfig,
  type MyPiSetupConfig,
  SETUP_CONFIG_CHANGED_CHANNEL,
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
import {
  CapabilityIntentHighlightEditor,
  colorCapabilityKeyword,
  isLightNamedTheme,
} from "./src/ui.ts";

const CapabilitySchema = Type.Unsafe<OpenPiCapability>({
  type: "string",
  enum: OPENPI_CAPABILITY_NAMES,
});

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

    pi.on("session_start", (_event, ctx) => {
      resetOpenPiToolSurface(
        pi,
        dependencies.sourcePath
          ? { capabilities: dependencies.sourcePath }
          : undefined,
      );
      reconcileDiscoveryGateway();
      registerEditorLayer(pi, ctx, {
        id: "capability-intent-highlight",
        order: 150,
        wrap: (base, _tui, _theme, keybindings) =>
          new CapabilityIntentHighlightEditor(base, keybindings, (text) =>
            colorCapabilityKeyword(text, {
              colorMode: ctx.ui.theme.getColorMode(),
              light: isLightNamedTheme(ctx.ui.theme.name),
            }),
          ),
      });
    });

    pi.on("session_shutdown", () => {
      removeEditorLayer(pi, "capability-intent-highlight");
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
