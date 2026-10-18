import { fileURLToPath } from "node:url";

/**
 * OpenPI-owned model tools, grouped by the extension that owns their runtime
 * state. `resident` tools are active from session start and stay active for
 * the whole session: model actions and runtime state (background
 * processes, context size, prompt content) never change the model-visible
 * tool list or the rebuilt system prompt. `boundary` tools are visible only
 * while a user-explicit boundary is active — plan mode, an `/openpi-setup`
 * episode, or the browser permission granted through setup — and leave when
 * that boundary ends.
 */
export const OPENPI_TOOL_SURFACE = {
  subagents: {
    resident: [
      "subagent_spawn",
      "subagent_wait",
      "subagent_cancel",
      "subagent_send",
      "subagent_check",
    ],
    boundary: [],
  },
  workflows: {
    resident: ["workflow", "workflow_stop", "workflow_status"],
    boundary: [],
  },
  gitRead: {
    resident: [],
    boundary: ["git_show", "git_diff", "git_log"],
  },
  interaction: {
    resident: [],
    boundary: ["ask_user", "human_handoff"],
  },
  plan: {
    resident: [],
    boundary: ["plan_ready"],
  },
  setup: {
    resident: [],
    boundary: ["configure_my_pi_setup"],
  },
  browser: { resident: [], boundary: ["openpi_browser"] },
} as const;

export type OpenPiToolOwner = keyof typeof OPENPI_TOOL_SURFACE;

export const OPENPI_TOOL_SURFACE_NAMES = Object.values(
  OPENPI_TOOL_SURFACE,
).flatMap(({ resident, boundary }) => [...resident, ...boundary]);

interface ActiveToolSurface {
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
  desiredByOwner: Map<OpenPiToolOwner, Set<string>>;
  knownAvailable: Set<string>;
}

export const OPENPI_OWNER_SOURCE_PATHS = {
  gitRead: fileURLToPath(new URL("../git-read/index.ts", import.meta.url)),
  subagents: fileURLToPath(new URL("../subagents/index.ts", import.meta.url)),
  workflows: fileURLToPath(new URL("../workflows/index.ts", import.meta.url)),
  interaction: fileURLToPath(new URL("../ask-user/index.ts", import.meta.url)),
  plan: fileURLToPath(new URL("../plan-mode/index.ts", import.meta.url)),
  setup: fileURLToPath(new URL("../setup/index.ts", import.meta.url)),
  browser: fileURLToPath(new URL("../browser/index.ts", import.meta.url)),
} as const satisfies Record<OpenPiToolOwner, string>;

const states = new WeakMap<object, ToolSurfaceState>();

function initialDesiredByOwner() {
  return new Map<OpenPiToolOwner, Set<string>>(
    (Object.keys(OPENPI_TOOL_SURFACE) as OpenPiToolOwner[]).map((owner) => [
      owner,
      new Set<string>(OPENPI_TOOL_SURFACE[owner].resident),
    ]),
  );
}

function stateFor(pi: ActiveToolSurface) {
  let state = states.get(pi);
  if (!state) {
    state = {
      desiredByOwner: initialDesiredByOwner(),
      knownAvailable: new Set<string>(),
    };
    states.set(pi, state);
  }
  return state;
}

function ownedToolNames(owner: OpenPiToolOwner) {
  return [
    ...OPENPI_TOOL_SURFACE[owner].resident,
    ...OPENPI_TOOL_SURFACE[owner].boundary,
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

  const expectedSource = OPENPI_OWNER_SOURCE_PATHS[owner];
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
  const next = pi
    .getActiveTools()
    .filter((name) => !ownedAvailable.has(name) || desired.has(name));
  const nextSet = new Set(next);

  for (const name of owned) {
    if (desired.has(name) && !nextSet.has(name) && available.has(name)) {
      next.push(name);
      nextSet.add(name);
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

/**
 * Record one owner's desired tools and reconcile them against the active
 * list. Resident tools can only ever be enabled: disabling one is a bug in
 * the owner and throws instead of silently churning the frozen surface.
 * Foreign and Pi-native tools are always preserved from the latest active
 * list.
 */
export function patchOwnedTools(
  pi: ActiveToolSurface,
  owner: OpenPiToolOwner,
  patch: OwnedToolPatch,
) {
  const owned = ownedToolNames(owner);
  const ownedSet = new Set(owned);
  const resident = new Set<string>(OPENPI_TOOL_SURFACE[owner].resident);
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
  for (const name of disable) {
    if (resident.has(name)) {
      throw new Error(
        `${owner} cannot disable resident tool ${JSON.stringify(name)}.`,
      );
    }
  }

  const state = stateFor(pi);
  const desired = state.desiredByOwner.get(owner)!;
  for (const name of enable) state.knownAvailable.add(name);
  for (const name of disable) desired.delete(name);
  for (const name of enable) desired.add(name);
  return reconcileOwner(pi, state, owner);
}
