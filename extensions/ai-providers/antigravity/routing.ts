import type { Model, ThinkingLevel } from "@earendil-works/pi-ai/compat";

export type AntigravityModelDefinition = Omit<
  Model<string>,
  "api" | "provider" | "baseUrl"
> & {
  /** Provider-private fields preserved by pi's extension model composer. */
  requestModelId?: string;
  antigravityEffortRouting?: Partial<Record<ThinkingLevel, string>>;
};

type Family = {
  id: string;
  name: string;
  members: readonly string[];
  defaultWireId: string;
  routes?: Partial<Record<ThinkingLevel, string>>;
  mode: "budget" | "google-level";
  budgets?: Partial<Record<ThinkingLevel, number>>;
  mandatory?: boolean;
  retiredMembers?: readonly string[];
  preserveAbsentEffortRoutes?: boolean;
};

function thinkingPairs(
  pairs: readonly (readonly [id: string, name: string])[],
): Family[] {
  return pairs.map(([id, name]) => ({
    id,
    name,
    members: [id, `${id}-thinking`],
    defaultWireId: id,
    routes: {
      minimal: `${id}-thinking`,
      low: `${id}-thinking`,
      medium: `${id}-thinking`,
      high: `${id}-thinking`,
      xhigh: `${id}-thinking`,
      max: `${id}-thinking`,
    },
    mode: "budget",
    preserveAbsentEffortRoutes: true,
  }));
}

const FAMILIES: readonly Family[] = [
  {
    id: "gemini-3.7-flash",
    name: "Gemini 3.7 Flash",
    members: [
      "gemini-3.7-flash-low",
      "gemini-3.7-flash-medium",
      "gemini-3.7-flash-high",
    ],
    defaultWireId: "gemini-3.7-flash-low",
    routes: {
      minimal: "gemini-3.7-flash-low",
      low: "gemini-3.7-flash-low",
      medium: "gemini-3.7-flash-medium",
      high: "gemini-3.7-flash-high",
      xhigh: "gemini-3.7-flash-high",
      max: "gemini-3.7-flash-high",
    },
    mode: "google-level",
    mandatory: true,
  },
  {
    id: "gemini-3.6-flash",
    name: "Gemini 3.6 Flash",
    members: [
      "gemini-3.6-flash-low",
      "gemini-3.6-flash-medium",
      "gemini-3.6-flash-high",
      "gemini-3.6-flash-tiered",
    ],
    defaultWireId: "gemini-3.6-flash-low",
    routes: {
      minimal: "gemini-3.6-flash-low",
      low: "gemini-3.6-flash-low",
      medium: "gemini-3.6-flash-medium",
      high: "gemini-3.6-flash-high",
      xhigh: "gemini-3.6-flash-high",
      max: "gemini-3.6-flash-high",
    },
    mode: "google-level",
    mandatory: true,
  },
  {
    id: "gemini-3.5-flash",
    name: "Gemini 3.5 Flash",
    members: [
      "gemini-3.5-flash-extra-low",
      "gemini-3.5-flash-low",
      "gemini-3-flash-agent",
    ],
    defaultWireId: "gemini-3.5-flash-extra-low",
    routes: {
      minimal: "gemini-3.5-flash-extra-low",
      low: "gemini-3.5-flash-extra-low",
      medium: "gemini-3.5-flash-low",
      high: "gemini-3-flash-agent",
      xhigh: "gemini-3-flash-agent",
      max: "gemini-3-flash-agent",
    },
    mode: "budget",
    budgets: {
      minimal: 1_000,
      low: 1_000,
      medium: 4_000,
      high: 10_000,
      xhigh: 10_000,
      max: 10_000,
    },
  },
  {
    id: "gemini-3.1-pro",
    name: "Gemini 3.1 Pro",
    members: [
      "gemini-3.1-pro-low",
      "gemini-pro-agent",
      // Discovery still publishes this deployment, but requests always fail.
      "gemini-3.1-pro-high",
    ],
    defaultWireId: "gemini-3.1-pro-low",
    routes: {
      minimal: "gemini-3.1-pro-low",
      low: "gemini-3.1-pro-low",
      medium: "gemini-3.1-pro-low",
      high: "gemini-pro-agent",
      xhigh: "gemini-pro-agent",
      max: "gemini-pro-agent",
    },
    mode: "budget",
    budgets: {
      minimal: 1_001,
      low: 1_001,
      medium: 1_001,
      high: 10_001,
      xhigh: 10_001,
      max: 10_001,
    },
    retiredMembers: ["gemini-3.1-pro-high"],
  },
  {
    id: "gemini-3-pro",
    name: "Gemini 3 Pro",
    members: ["gemini-3-pro-low", "gemini-3-pro-high"],
    defaultWireId: "gemini-3-pro-low",
    routes: {
      minimal: "gemini-3-pro-low",
      low: "gemini-3-pro-low",
      medium: "gemini-3-pro-low",
      high: "gemini-3-pro-high",
      xhigh: "gemini-3-pro-high",
      max: "gemini-3-pro-high",
    },
    mode: "google-level",
  },
  {
    id: "gpt-oss-120b",
    name: "GPT-OSS 120B",
    members: ["gpt-oss-120b-medium"],
    defaultWireId: "gpt-oss-120b-medium",
    mode: "budget",
  },
  {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    members: ["claude-sonnet-4-6", "claude-sonnet-4-6-thinking"],
    defaultWireId: "claude-sonnet-4-6",
    mode: "budget",
    retiredMembers: ["claude-sonnet-4-6-thinking"],
  },
  {
    id: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    members: ["claude-opus-4-6-thinking", "claude-opus-4-6"],
    defaultWireId: "claude-opus-4-6-thinking",
    mode: "budget",
    retiredMembers: ["claude-opus-4-6"],
  },
  ...thinkingPairs([
    ["claude-sonnet-4-5", "Claude Sonnet 4.5"],
    ["claude-opus-4-5", "Claude Opus 4.5"],
    ["gemini-2.5-flash", "Gemini 2.5 Flash"],
  ]),
];

const familyById = new Map<string, Family>();
for (const family of FAMILIES) {
  familyById.set(family.id, family);
  for (const member of family.members) familyById.set(member, family);
}

function clampLevel(
  level: ThinkingLevel,
): "minimal" | "low" | "medium" | "high" {
  if (level === "xhigh" || level === "max") return "high";
  return level;
}

export function collapseAntigravityModels<T extends AntigravityModelDefinition>(
  models: readonly T[],
): T[] {
  const byId = new Map(models.map((model) => [model.id, model]));
  const consumed = new Set<string>();
  const collapsed: T[] = [];

  for (const model of models) {
    if (consumed.has(model.id)) continue;
    const family = familyById.get(model.id);
    if (!family) {
      collapsed.push(model);
      continue;
    }
    if (collapsed.some((entry) => entry.id === family.id)) continue;
    for (const member of family.members) consumed.add(member);
    consumed.add(family.id);
    const logical = byId.get(family.id);
    const source =
      logical ?? family.members.map((id) => byId.get(id)).find(Boolean);
    if (!source) continue;
    const retired = new Set(family.retiredMembers ?? []);
    const liveWireIds = new Set(
      family.members.filter((id) => byId.has(id) && !retired.has(id)),
    );
    if (logical?.requestModelId && !retired.has(logical.requestModelId)) {
      liveWireIds.add(logical.requestModelId);
    } else if (logical && family.members.includes(family.id)) {
      liveWireIds.add(family.id);
    }
    // A discovery response containing only a retired deployment is unusable;
    // consume it without publishing a logical model that cannot be requested.
    if (liveWireIds.size === 0) continue;
    const requestModelId = liveWireIds.has(family.defaultWireId)
      ? family.defaultWireId
      : liveWireIds.values().next().value;
    if (!requestModelId) continue;
    const effortRouting: Partial<Record<ThinkingLevel, string>> = {};
    for (const [effort, target] of Object.entries(family.routes ?? {}) as [
      ThinkingLevel,
      string,
    ][]) {
      if (
        !retired.has(target) &&
        (liveWireIds.has(target) || family.preserveAbsentEffortRoutes)
      ) {
        effortRouting[effort] = target;
      }
    }
    collapsed.push({
      ...source,
      id: family.id,
      name: family.name,
      reasoning: true,
      ...(requestModelId !== family.id ? { requestModelId } : {}),
      ...(Object.keys(effortRouting).length > 0
        ? { antigravityEffortRouting: effortRouting }
        : {}),
    });
  }

  return collapsed;
}

export function routeAntigravityModel(
  modelId: string,
  reasoning: ThinkingLevel | undefined,
  thinkingBudgets: Partial<Record<ThinkingLevel, number>> | undefined,
  overrides?: Pick<
    AntigravityModelDefinition,
    "requestModelId" | "antigravityEffortRouting"
  >,
): { wireModelId: string; thinkingConfig?: Record<string, unknown> } {
  const family = familyById.get(modelId);
  if (!family) {
    if (!reasoning) return { wireModelId: modelId };
    if (modelId.toLowerCase().includes("claude")) {
      const level = clampLevel(reasoning);
      const budget =
        thinkingBudgets?.[level] ??
        {
          minimal: 1_024,
          low: 8_192,
          medium: 16_384,
          high: 32_768,
        }[level];
      return {
        wireModelId: modelId,
        thinkingConfig: { includeThoughts: true, thinkingBudget: budget },
      };
    }
    return {
      wireModelId: modelId,
      thinkingConfig: {
        includeThoughts: true,
        thinkingLevel: clampLevel(reasoning).toUpperCase(),
      },
    };
  }

  const effective = reasoning ?? (family.mandatory ? "minimal" : undefined);
  const discoveredRouting = overrides?.antigravityEffortRouting;
  const wireModelId = effective
    ? ((discoveredRouting
        ? (discoveredRouting[effective] ?? overrides?.requestModelId)
        : (family.routes?.[effective] ?? overrides?.requestModelId)) ??
      family.defaultWireId)
    : (overrides?.requestModelId ?? family.defaultWireId);
  if (!effective) {
    return {
      wireModelId,
      thinkingConfig: { includeThoughts: false, thinkingBudget: 0 },
    };
  }
  if (family.mode === "google-level") {
    const level = clampLevel(effective);
    return {
      wireModelId,
      thinkingConfig: {
        includeThoughts: true,
        thinkingLevel: level === "minimal" ? "LOW" : level.toUpperCase(),
      },
    };
  }
  const level = clampLevel(effective);
  const budget =
    thinkingBudgets?.[level] ??
    family.budgets?.[effective] ??
    {
      minimal: 1_024,
      low: 8_192,
      medium: 16_384,
      high: 32_768,
    }[level];
  return {
    wireModelId,
    thinkingConfig: { includeThoughts: true, thinkingBudget: budget },
  };
}
