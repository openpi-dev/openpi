import { fileURLToPath } from "node:url";

/**
 * OpenPI-owned model tools, grouped by the extension that owns their runtime
 * state. Ordinary parent sessions add no resident OpenPI tool. Explicit user
 * intent can reveal the capability gateway or load one capability group;
 * capability-owned tools remain registered but are projected only after their
 * group is loaded. Lifecycle tools add a second resource/mode-state gate inside
 * that loaded group.
 */
export const OPENPI_TOOL_SURFACE = {
  capabilities: {
    entry: ["openpi_load_tools"],
    deferred: [],
  },
  fileSearch: {
    entry: ["fd", "rg"],
    deferred: [],
  },
  gitRead: {
    entry: ["git_show", "git_diff", "git_log"],
    deferred: [],
  },
  subagents: {
    entry: [
      "subagent_spawn",
      "subagent_wait",
      "subagent_cancel",
      "subagent_send",
      "subagent_check",
      "subagent_list",
    ],
    deferred: [],
  },
  workflows: {
    entry: ["workflow", "workflow_stop", "workflow_status"],
    deferred: [],
  },
  background: {
    entry: ["bg_start"],
    deferred: ["bg_status", "bg_list", "bg_kill", "bg_watch"],
  },
  tasks: {
    entry: ["tasks_add"],
    deferred: ["tasks_update", "tasks_list"],
  },
  goal: {
    entry: ["create_goal"],
    deferred: ["get_goal", "update_goal"],
  },
  interaction: {
    entry: [],
    deferred: ["ask_user", "human_handoff"],
  },
  plan: {
    entry: [],
    deferred: ["plan_ready"],
  },
  setup: {
    entry: [],
    deferred: ["configure_my_pi_setup"],
  },
  context: {
    entry: [],
    deferred: ["context_pivot"],
  },
} as const;

export type OpenPiToolOwner = keyof typeof OPENPI_TOOL_SURFACE;

export const OPENPI_CAPABILITY_GROUPS = {
  search: {
    owners: ["fileSearch", "gitRead"],
    summary:
      "Fast structured file and content search (fd, rg) plus read-only git inspection (git_show, git_diff, git_log).",
  },
  delegate: {
    owners: ["subagents"],
    summary: "Spawn and manage isolated in-process Pi subagents.",
  },
  workflow: {
    owners: ["workflows"],
    summary: "Run replay-safe multi-stage workflows.",
  },
  background: {
    owners: ["background"],
    summary: "Start and manage long-running background terminals.",
  },
  session: {
    owners: ["tasks", "goal"],
    summary:
      "Track explicit session tasks and persistent user-requested goals.",
  },
} as const satisfies Record<
  string,
  { owners: readonly OpenPiToolOwner[]; summary: string }
>;

export type OpenPiCapability = keyof typeof OPENPI_CAPABILITY_GROUPS;

export const OPENPI_CAPABILITY_NAMES = Object.keys(
  OPENPI_CAPABILITY_GROUPS,
) as OpenPiCapability[];

export const DEFAULT_OPENPI_ACTIVE_TOOL_NAMES: readonly string[] = [];

export const OPENPI_TOOL_SURFACE_NAMES = Object.values(
  OPENPI_TOOL_SURFACE,
).flatMap(({ entry, deferred }) => [...entry, ...deferred]);

interface ActiveToolSurface {
  events?: {
    emit(channel: string, data: unknown): void;
    on(channel: string, handler: (data: unknown) => void): () => void;
  };
  getActiveTools(): string[];
  getAllTools?(): {
    name: string;
    sourceInfo?: { path: string; source?: string };
  }[];
  setActiveTools(names: string[]): void;
}

interface OwnedToolPatch {
  enable?: readonly string[];
  disable?: readonly string[];
}

interface ToolSurfaceState {
  loaded: Set<OpenPiCapability>;
  desiredByOwner: Map<OpenPiToolOwner, Set<string>>;
  sourceByOwner: Map<OpenPiToolOwner, string>;
  managedOwners: Set<OpenPiToolOwner>;
  knownAvailable: Set<string>;
  subscribed: boolean;
}

export const OPENPI_OWNER_SOURCE_PATHS = {
  capabilities: fileURLToPath(
    new URL("../capabilities/index.ts", import.meta.url),
  ),
  fileSearch: fileURLToPath(
    new URL("../file-search/index.ts", import.meta.url),
  ),
  gitRead: fileURLToPath(new URL("../git-read/index.ts", import.meta.url)),
  subagents: fileURLToPath(new URL("../subagents/index.ts", import.meta.url)),
  workflows: fileURLToPath(new URL("../workflows/index.ts", import.meta.url)),
  background: fileURLToPath(
    new URL("../background-terminals/index.ts", import.meta.url),
  ),
  tasks: fileURLToPath(new URL("../tasks/index.ts", import.meta.url)),
  goal: fileURLToPath(new URL("../goal/index.ts", import.meta.url)),
  interaction: fileURLToPath(new URL("../ask-user/index.ts", import.meta.url)),
  plan: fileURLToPath(new URL("../plan-mode/index.ts", import.meta.url)),
  setup: fileURLToPath(new URL("../setup/index.ts", import.meta.url)),
  context: fileURLToPath(new URL("../context-pivot/index.ts", import.meta.url)),
} as const satisfies Record<OpenPiToolOwner, string>;

const states = new WeakMap<object, ToolSurfaceState>();
export const OPENPI_CAPABILITY_STATE_CHANNEL = "openpi:capability-state";

function initialDesiredByOwner() {
  return new Map<OpenPiToolOwner, Set<string>>(
    (Object.keys(OPENPI_TOOL_SURFACE) as OpenPiToolOwner[]).map((owner) => [
      owner,
      new Set<string>(
        owner === "capabilities" ? [] : OPENPI_TOOL_SURFACE[owner].entry,
      ),
    ]),
  );
}

function newState(): ToolSurfaceState {
  return {
    loaded: new Set<OpenPiCapability>(),
    desiredByOwner: initialDesiredByOwner(),
    sourceByOwner: new Map<OpenPiToolOwner, string>(),
    managedOwners: new Set<OpenPiToolOwner>(),
    knownAvailable: new Set<string>(),
    subscribed: false,
  };
}

function capabilityStateFromEvent(data: unknown) {
  if (typeof data !== "object" || data === null) return undefined;
  const loaded = (data as { loaded?: unknown }).loaded;
  if (!Array.isArray(loaded)) return undefined;
  if (
    loaded.some(
      (name) =>
        typeof name !== "string" ||
        !OPENPI_CAPABILITY_NAMES.includes(name as OpenPiCapability),
    )
  ) {
    return undefined;
  }
  return loaded as OpenPiCapability[];
}

function subscribeToCapabilityState(
  pi: ActiveToolSurface,
  state: ToolSurfaceState,
) {
  if (
    state.subscribed ||
    typeof pi.events?.on !== "function" ||
    typeof pi.events?.emit !== "function"
  ) {
    return;
  }
  state.subscribed = true;
  pi.events.on(OPENPI_CAPABILITY_STATE_CHANNEL, (data) => {
    const loaded = capabilityStateFromEvent(data);
    if (!loaded) return;
    state.loaded = new Set(loaded);
    reconcileManagedOwners(pi, state);
  });
}

function stateFor(pi: ActiveToolSurface) {
  let state = states.get(pi);
  if (!state) {
    state = newState();
    if (
      typeof pi.events?.on !== "function" ||
      typeof pi.events?.emit !== "function"
    ) {
      state.loaded = new Set(OPENPI_CAPABILITY_NAMES);
    }
    states.set(pi, state);
  }
  return state;
}

function capabilityForOwner(owner: OpenPiToolOwner) {
  return OPENPI_CAPABILITY_NAMES.find((capability) =>
    OPENPI_CAPABILITY_GROUPS[capability].owners.includes(owner as never),
  );
}

function ownerIsVisible(state: ToolSurfaceState, owner: OpenPiToolOwner) {
  const capability = capabilityForOwner(owner);
  return capability === undefined || state.loaded.has(capability);
}

function ownedToolNames(owner: OpenPiToolOwner) {
  return [
    ...OPENPI_TOOL_SURFACE[owner].entry,
    ...OPENPI_TOOL_SURFACE[owner].deferred,
  ] as readonly string[];
}

function availableOwnedToolNames(
  pi: ActiveToolSurface,
  state: ToolSurfaceState,
  owner: OpenPiToolOwner,
) {
  for (const name of pi.getActiveTools()) state.knownAvailable.add(name);
  const reportedTools = pi.getAllTools?.();
  const owned = new Set<string>(ownedToolNames(owner));
  if (!reportedTools || reportedTools.length === 0) {
    return new Set([...state.knownAvailable].filter((name) => owned.has(name)));
  }
  if (reportedTools.every((tool) => tool.sourceInfo === undefined)) {
    return new Set(
      reportedTools.map(({ name }) => name).filter((name) => owned.has(name)),
    );
  }

  const expectedSource =
    state.sourceByOwner.get(owner) ?? OPENPI_OWNER_SOURCE_PATHS[owner];
  return new Set(
    reportedTools
      .filter(
        (tool) =>
          owned.has(tool.name) && tool.sourceInfo?.path === expectedSource,
      )
      .map(({ name }) => name),
  );
}

/** Verify that one active tool is the definition owned by this OpenPI source. */
export function isOwnedToolActive(
  pi: ActiveToolSurface,
  owner: OpenPiToolOwner,
  name: string,
) {
  if (!ownedToolNames(owner).includes(name)) {
    throw new Error(`${owner} does not own tool ${JSON.stringify(name)}.`);
  }
  return (
    pi.getActiveTools().includes(name) &&
    availableOwnedToolNames(pi, stateFor(pi), owner).has(name)
  );
}

/** Verify that one registered tool is available from this OpenPI source. */
export function isOwnedToolAvailable(
  pi: ActiveToolSurface,
  owner: OpenPiToolOwner,
  name: string,
) {
  if (!ownedToolNames(owner).includes(name)) {
    throw new Error(`${owner} does not own tool ${JSON.stringify(name)}.`);
  }
  return availableOwnedToolNames(pi, stateFor(pi), owner).has(name);
}

function projectedOwnerTools(
  pi: ActiveToolSurface,
  state: ToolSurfaceState,
  owner: OpenPiToolOwner,
) {
  const available = availableOwnedToolNames(pi, state, owner);
  const owned = ownedToolNames(owner);
  const ownedAvailable = new Set(owned.filter((name) => available.has(name)));
  const desired = state.desiredByOwner.get(owner)!;
  const visible = ownerIsVisible(state, owner);
  const next = pi
    .getActiveTools()
    .filter(
      (name) => !ownedAvailable.has(name) || (visible && desired.has(name)),
    );
  const nextSet = new Set(next);

  if (visible) {
    for (const name of owned) {
      if (desired.has(name) && !nextSet.has(name) && available.has(name)) {
        next.push(name);
        nextSet.add(name);
      }
    }
  }

  return next;
}

function applyActiveTools(pi: ActiveToolSurface, next: string[]) {
  const active = pi.getActiveTools();
  if (
    active.length === next.length &&
    active.every((name, index) => name === next[index])
  ) {
    return false;
  }
  pi.setActiveTools(next);
  return true;
}

function reconcileOwner(
  pi: ActiveToolSurface,
  state: ToolSurfaceState,
  owner: OpenPiToolOwner,
) {
  return applyActiveTools(pi, projectedOwnerTools(pi, state, owner));
}

function reconcileManagedOwners(
  pi: ActiveToolSurface,
  state: ToolSurfaceState,
) {
  let changed = false;
  for (const owner of state.managedOwners) {
    changed = reconcileOwner(pi, state, owner) || changed;
  }
  return changed;
}

/** Reset one bound Pi Session to the minimal parent surface. */
export function resetOpenPiToolSurface(
  pi: ActiveToolSurface,
  sourceByOwner: Readonly<Partial<Record<OpenPiToolOwner, string>>> = {},
) {
  const state = newState();
  for (const [owner, source] of Object.entries(sourceByOwner)) {
    if (source) state.sourceByOwner.set(owner as OpenPiToolOwner, source);
  }
  states.set(pi, state);
  state.managedOwners.add("capabilities");
  const changed = reconcileOwner(pi, state, "capabilities");
  pi.events?.emit(OPENPI_CAPABILITY_STATE_CHANNEL, { loaded: [] });
  return changed;
}

export function getLoadedOpenPiCapabilities(pi: ActiveToolSurface) {
  return OPENPI_CAPABILITY_NAMES.filter((capability) =>
    stateFor(pi).loaded.has(capability),
  );
}

/**
 * Load capability groups monotonically for this Session. There is deliberately
 * no unload operation: a stable surface is more cache-friendly and easier for
 * the model to reason about than tools that repeatedly disappear and return.
 */
export function loadOpenPiCapabilities(
  pi: ActiveToolSurface,
  capabilities: readonly OpenPiCapability[],
) {
  const invalid = capabilities.filter(
    (capability) => !OPENPI_CAPABILITY_NAMES.includes(capability),
  );
  if (invalid.length > 0) {
    throw new Error(
      `Unknown OpenPI ${invalid.length === 1 ? "capability" : "capabilities"}: ${invalid.map((name) => JSON.stringify(name)).join(", ")}.`,
    );
  }

  const state = stateFor(pi);
  const before = pi.getActiveTools();
  const newlyLoaded: OpenPiCapability[] = [];
  for (const capability of capabilities) {
    if (!state.loaded.has(capability)) {
      state.loaded.add(capability);
      newlyLoaded.push(capability);
    }
  }
  reconcileManagedOwners(pi, state);
  pi.events?.emit(OPENPI_CAPABILITY_STATE_CHANNEL, {
    loaded: getLoadedOpenPiCapabilities(pi),
  });
  const beforeSet = new Set(before);
  return {
    newlyLoaded,
    loaded: getLoadedOpenPiCapabilities(pi),
    activatedTools: pi.getActiveTools().filter((name) => !beforeSet.has(name)),
  };
}

/**
 * Record one owner's desired tools and reconcile them through both gates:
 * capability loaded first, then the owner's authoritative resource/mode state.
 * Foreign and Pi-native tools are always preserved from the latest active list.
 */
export function patchOwnedTools(
  pi: ActiveToolSurface,
  owner: OpenPiToolOwner,
  patch: OwnedToolPatch,
) {
  const owned = [
    ...OPENPI_TOOL_SURFACE[owner].entry,
    ...OPENPI_TOOL_SURFACE[owner].deferred,
  ] as readonly string[];
  const ownedSet = new Set(owned);
  const enable = new Set(patch.enable ?? []);
  const disable = new Set(patch.disable ?? []);

  for (const name of [...enable, ...disable]) {
    if (!ownedSet.has(name)) {
      throw new Error(`${owner} does not own tool ${JSON.stringify(name)}.`);
    }
  }
  for (const name of enable) {
    if (disable.has(name)) {
      throw new Error(
        `${owner} cannot enable and disable tool ${JSON.stringify(name)} in one patch.`,
      );
    }
  }

  const state = stateFor(pi);
  state.managedOwners.add(owner);
  if (capabilityForOwner(owner)) subscribeToCapabilityState(pi, state);
  const desired = state.desiredByOwner.get(owner)!;
  for (const name of enable) state.knownAvailable.add(name);
  for (const name of disable) desired.delete(name);
  for (const name of enable) desired.add(name);
  return reconcileOwner(pi, state, owner);
}
