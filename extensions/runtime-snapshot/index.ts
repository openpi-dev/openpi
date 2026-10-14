import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  inspectSetupConfig,
  REASONING_LEVELS,
} from "../shared/setup-config.ts";
import { SUBAGENT_ROLE_NAMES } from "../shared/subagent-roles.ts";
import {
  OPENPI_TOOL_SURFACE_NAMES,
  OPENPI_OWNER_SOURCE_PATHS,
} from "../shared/tool-surface.ts";
import {
  webCapabilitySnapshot,
  type WebCapabilityProjection,
  type WebCapabilityKind,
} from "../shared/web-observer-registry.ts";

export const MAX_SNAPSHOT_BYTES = 16 * 1024;
const GIT_READ_TIMEOUT_MS = 5_000;
const MAX_RESOURCE_ITEMS = 32;
const MAX_TOOL_NAMES = 64;
const PACKAGE_DIRECTORY = fileURLToPath(new URL("../../", import.meta.url));
const SAFE_TOOL_NAMES = new Set([
  "read",
  "bash",
  "edit",
  "write",
  "ls",
  "find",
  "grep",
  ...OPENPI_TOOL_SURFACE_NAMES,
]);
const RESOURCE_STATUSES = new Set([
  "running",
  "done",
  "error",
  "completed",
  "failed",
  "aborted",
  "uncertain",
  "killed",
  "timed_out",
]);

function unavailable() {
  return { availability: "unavailable" as const, sampledAt: Date.now() };
}

function sample<T>(read: () => T) {
  try {
    return {
      availability: "available" as const,
      sampledAt: Date.now(),
      ...read(),
    };
  } catch {
    // Exception messages may contain paths, endpoints, or credentials.
    return unavailable();
  }
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function thinkingLevel(value: unknown) {
  return REASONING_LEVELS.find((level) => level === value) ?? "unknown";
}

function abortIfNeeded(signal?: AbortSignal) {
  signal?.throwIfAborted();
}

async function gitRead(cwd: string, args: string[], signal?: AbortSignal) {
  // -C does not override repository-selection environment. Copy, never mutate
  // the parent's environment; retain unrelated Git/user configuration.
  const env = { ...process.env };
  for (const name of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_COMMON_DIR",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_IMPLICIT_WORK_TREE",
    "GIT_GRAFT_FILE",
    "GIT_SHALLOW_FILE",
    "GIT_PREFIX",
    "GIT_NAMESPACE",
    "GIT_CEILING_DIRECTORIES",
    "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  ]) {
    delete env[name];
  }
  // Inherited tracing can create/append files even for read-only Git commands.
  for (const name of Object.keys(env)) {
    if (name.startsWith("GIT_TRACE")) delete env[name];
  }
  return new Promise<string>((resolve, reject) => {
    execFile(
      "git",
      [
        "--no-optional-locks",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.untrackedCache=false",
        "-C",
        cwd,
        ...args,
      ],
      {
        encoding: "utf8",
        env,
        // Git startup can exceed one second on Windows runners even for a
        // small worktree. Keep reads bounded without treating that latency as
        // unavailable runtime state.
        timeout: GIT_READ_TIMEOUT_MS,
        maxBuffer: 8 * 1024,
        signal,
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}

/**
 * Facts for cwd's containing Git worktree, including changes outside nested cwd.
 * Dirty covers tracked (including gitlink) and normal untracked status,
 * not ignored files or nested submodule contents.
 * No branch/path/remote names, locks, refresh, or cleanup.
 */
export async function readDiskSnapshot(cwd: string, signal?: AbortSignal) {
  abortIfNeeded(signal);
  try {
    const head = (
      await gitRead(cwd, ["rev-parse", "--verify", "HEAD"], signal)
    ).trim();
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head)) return unavailable();
    const status = await gitRead(
      cwd,
      [
        "status",
        "--porcelain=v1",
        "--untracked-files=normal",
        "--ignore-submodules=dirty",
      ],
      signal,
    );
    abortIfNeeded(signal);
    return {
      availability: "available" as const,
      sampledAt: Date.now(),
      head,
      dirty: status.length > 0,
    };
  } catch {
    abortIfNeeded(signal);
    return unavailable();
  }
}

interface SnapshotDependencies {
  inspectConfig: () => Pick<
    ReturnType<typeof inspectSetupConfig>,
    "source" | "diagnostics" | "config"
  >;
  disk: typeof readDiskSnapshot;
}

/** Join existing facts, not an authority store or an atomic multi-owner view. */
export async function collectRuntimeSnapshot(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  registrationEpoch: number,
  dependencies: SnapshotDependencies = {
    inspectConfig: inspectSetupConfig,
    disk: readDiskSnapshot,
  },
  signal?: AbortSignal,
) {
  abortIfNeeded(signal);
  const startedAt = Date.now();
  // Read each source afresh. Do not cache settings, context, or owner samples.
  let configuredIdentity: { provider?: unknown; model?: unknown } | undefined;
  const configured = sample(() => {
    const settings = pi.getSettings();
    configuredIdentity = {
      provider: settings.defaultProvider,
      model: settings.defaultModel,
    };
    return {
      source: "pi-effective-settings" as const,
      model: {
        present:
          validIdentifier(settings.defaultProvider) &&
          validIdentifier(settings.defaultModel),
        providerPresent: validIdentifier(settings.defaultProvider),
        identifiers: "redacted" as const,
      },
      thinking: thinkingLevel(settings.defaultThinkingLevel),
      provenanceLayers: "unavailable" as const,
    };
  });
  const packageConfig = sample(() => {
    const inspection = dependencies.inspectConfig();
    if (
      inspection.diagnostics.some(
        (diagnostic) => diagnostic.severity === "error",
      )
    )
      throw new Error("Unavailable configuration");
    const config = inspection.config;
    return {
      source:
        inspection.source === "missing"
          ? ("package-defaults" as const)
          : ("package-config-disk" as const),
      suggestionModelConfigured:
        validIdentifier(config.suggestions.model?.provider) &&
        validIdentifier(config.suggestions.model?.model),
      roleModelOverrides: SUBAGENT_ROLE_NAMES.filter((role) => {
        const model = config.subagents.roleModels[role];
        return (
          validIdentifier(model?.provider) && validIdentifier(model?.model)
        );
      }),
      identifiers: "redacted" as const,
    };
  });
  const sessionSelected = sample(() => {
    const model = ctx.model;
    return {
      source: "pi-context" as const,
      model: {
        present: validIdentifier(model?.provider) && validIdentifier(model?.id),
        identifiers: "redacted" as const,
      },
      thinking: thinkingLevel(pi.getThinkingLevel()),
      matchesConfiguredDefault:
        configured.availability === "available" &&
        validIdentifier(model?.provider) &&
        validIdentifier(model?.id) &&
        validIdentifier(configuredIdentity?.provider) &&
        validIdentifier(configuredIdentity?.model)
          ? model.provider === configuredIdentity.provider &&
            model.id === configuredIdentity.model
          : ("unknown" as const),
      upstreamRoute: "unknown" as const,
    };
  });
  const trust = sample(() => ({
    source: "pi-context-live-decision" as const,
    projectTrusted: ctx.isProjectTrusted(),
    persistedDecision: "unavailable" as const,
    filesystemSandbox: false,
  }));
  const packageProvenance = sample(() => {
    const definitions = pi
      .getAllTools()
      .filter((tool) => tool.name === "runtime_snapshot");
    const definition = definitions.length === 1 ? definitions[0] : undefined;
    if (definition?.sourceInfo?.path !== OPENPI_OWNER_SOURCE_PATHS.runtime) {
      throw new Error("Unavailable definition provenance");
    }
    const { scope, origin } = definition.sourceInfo;
    return {
      source: "pi-tool-source-info" as const,
      scope:
        scope === "user" || scope === "project" || scope === "temporary"
          ? scope
          : "unknown",
      origin:
        origin === "package" || origin === "top-level" ? origin : "unknown",
      singleOpenpiSource: "unknown" as const,
    };
  });
  const toolBoundary = sample(() => {
    const active = pi.getActiveTools();
    const allowlisted = active.filter((name) => SAFE_TOOL_NAMES.has(name));
    return {
      source: "pi-active-tools" as const,
      active: {
        scope: "allowlisted-projection" as const,
        completeness: "unknown" as const,
        names: allowlisted.slice(0, MAX_TOOL_NAMES),
        omitted: Math.max(0, allowlisted.length - MAX_TOOL_NAMES),
      },
      roleRestrictions: "unavailable" as const,
    };
  });

  // Registry lookup does not acquire a manager, subscribe, or request detail.
  let remaining = MAX_RESOURCE_ITEMS;
  function resource(kind: WebCapabilityKind, query: string) {
    const ownerSample = sample(() => {
      const projection: WebCapabilityProjection | undefined =
        webCapabilitySnapshot(ctx.sessionManager, kind)[kind];
      if (!projection) throw new Error("Unavailable owner");
      const items = projection.items.slice(0, remaining).map((item) => ({
        status: RESOURCE_STATUSES.has(item.status) ? item.status : "unknown",
      }));
      const omitted =
        Math.max(0, projection.omitted) +
        projection.items.length -
        items.length;
      const truncated =
        projection.truncated || projection.items.length > items.length;
      remaining -= items.length;
      // Upstream truncation can also mean shortened metadata or an incomplete
      // inventory. Preserve the known count without claiming an exact total.
      const omittedCountKind = projection.truncated
        ? ("lower-bound" as const)
        : ("exact" as const);
      return { items, omitted, omittedCountKind, truncated };
    });
    return {
      ...ownerSample,
      source: "session-owner-observer" as const,
      query,
    };
  }
  const resources = {
    subagents: resource("subagents", "subagent_list"),
    workflows: resource("workflows", "workflow_status"),
    background: resource("background-terminals", "bg_list"),
  };
  const diskSample = async (cwd: string) => {
    try {
      return await dependencies.disk(cwd, signal);
    } catch {
      abortIfNeeded(signal);
      return unavailable();
    }
  };
  const [packageDisk, projectDisk] = await Promise.all([
    diskSample(PACKAGE_DIRECTORY),
    diskSample(ctx.cwd),
  ]);
  abortIfNeeded(signal);
  return {
    version: 1,
    sampledAt: startedAt,
    completedAt: Date.now(),
    consistency: "non-atomic-owner-samples" as const,
    configured: { ...configured, package: packageConfig },
    sessionSelected,
    trust,
    packageProvenance,
    toolBoundary,
    disk: { package: packageDisk, project: projectDisk },
    loaded: {
      availability: "available" as const,
      sampledAt: startedAt,
      source: "extension-registration" as const,
      registrationEpoch,
      revision: "unknown" as const,
      piVersion: "unavailable" as const,
      openpiVersion: "unavailable" as const,
    },
    resources,
  };
}

export function snapshotToolResult(
  snapshot: Awaited<ReturnType<typeof collectRuntimeSnapshot>>,
) {
  const result = {
    content: [{ type: "text" as const, text: JSON.stringify(snapshot) }],
    details: snapshot,
  };
  if (Buffer.byteLength(JSON.stringify(result), "utf8") <= MAX_SNAPSHOT_BYTES)
    return result;
  // Omit the largest sample payloads first, not the evidence that they were
  // sampled. Source availability and output omission are independent facts.
  const { package: packageConfig, ...configured } = snapshot.configured;
  const samples = {
    configured,
    packageConfig,
    sessionSelected: snapshot.sessionSelected,
    trust: snapshot.trust,
    packageProvenance: snapshot.packageProvenance,
    toolBoundary: snapshot.toolBoundary,
    packageDisk: snapshot.disk.package,
    projectDisk: snapshot.disk.project,
    loaded: snapshot.loaded,
    ...snapshot.resources,
  };
  type Sample = (typeof samples)[keyof typeof samples];
  const projected: Record<
    keyof typeof samples,
    | Sample
    | {
        availability: Sample["availability"];
        sampledAt: number;
        source?: string;
        query?: string;
        output: "omitted";
        reason: "output-bound";
      }
  > = { ...samples };
  const keys = Object.keys(samples) as (keyof typeof samples)[];
  keys.sort(
    (a, b) =>
      Buffer.byteLength(JSON.stringify(samples[b]), "utf8") -
      Buffer.byteLength(JSON.stringify(samples[a]), "utf8"),
  );
  for (const key of keys) {
    const entry = samples[key];
    projected[key] = {
      availability: entry.availability,
      sampledAt: entry.sampledAt,
      ...("source" in entry ? { source: entry.source } : {}),
      ...("query" in entry ? { query: entry.query } : {}),
      output: "omitted",
      reason: "output-bound",
    };
    const bounded = {
      version: snapshot.version,
      sampledAt: snapshot.sampledAt,
      completedAt: snapshot.completedAt,
      consistency: snapshot.consistency,
      configured: { ...projected.configured, package: projected.packageConfig },
      sessionSelected: projected.sessionSelected,
      trust: projected.trust,
      packageProvenance: projected.packageProvenance,
      toolBoundary: projected.toolBoundary,
      disk: { package: projected.packageDisk, project: projected.projectDisk },
      loaded: projected.loaded,
      resources: {
        subagents: projected.subagents,
        workflows: projected.workflows,
        background: projected.background,
      },
    };
    const result = {
      content: [{ type: "text" as const, text: JSON.stringify(bounded) }],
      details: bounded,
    };
    if (Buffer.byteLength(JSON.stringify(result), "utf8") <= MAX_SNAPSHOT_BYTES)
      return result;
  }
  // Collector metadata is fixed-size; do not claim completion if that changes.
  throw new Error("Snapshot metadata exceeds output bound");
}

export default function runtimeSnapshot(pi: ExtensionAPI) {
  const registrationEpoch = Date.now();
  pi.registerTool({
    name: "runtime_snapshot",
    label: "Runtime Snapshot",
    description:
      "Read a bounded, redacted parent runtime sample. Configured, Session-selected, disk and loaded facts are separate; loaded revision and upstream route may be unknown. No model calls or resource startup.",
    defaultActive: false,
    parameters: Type.Object({}),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
    async execute(_id, _params, signal, _onUpdate, ctx) {
      return snapshotToolResult(
        await collectRuntimeSnapshot(
          pi,
          ctx,
          registrationEpoch,
          undefined,
          signal,
        ),
      );
    },
  });
}
