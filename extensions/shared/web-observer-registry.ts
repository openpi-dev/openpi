export type WebCapabilityKind =
  | "subagents"
  | "workflows"
  | "background-terminals";

export const WEB_MAX_CAPABILITY_ITEMS = 32;
const WEB_MAX_ACTIVITY_TEXT = 160;
const WEB_MAX_WORKFLOW_AGENTS_SCANNED = 1_024;

export interface WebSubagentActivity {
  readonly id: string;
  readonly title: string;
  readonly status: "running" | "done" | "error";
  readonly outcome?: "completed" | "failed" | "interrupted";
  readonly createdAt: number;
  readonly settledAt?: number;
}

export interface WebWorkflowActivity {
  readonly runId: string;
  readonly name?: string;
  readonly status: "running" | "completed" | "failed" | "aborted" | "uncertain";
  readonly currentPhase?: string;
  readonly startedAt: number;
  readonly finishedAt?: number;
  readonly agents: {
    readonly total: number;
    readonly running: number;
    readonly done: number;
    readonly error: number;
    readonly uncertain: number;
    readonly omitted?: number;
  };
}

export interface WebBackgroundTerminalActivity {
  readonly id: string;
  readonly title: string;
  readonly status: "running" | "done" | "failed" | "killed" | "timed_out";
  readonly createdAt: number;
  readonly settledAt?: number;
  readonly exitCode?: number;
  readonly signal?: string;
}

export interface WebCapabilityProjection<
  Item =
    | WebSubagentActivity
    | WebWorkflowActivity
    | WebBackgroundTerminalActivity,
> {
  readonly items: readonly Item[];
  readonly omitted: number;
  /** Records were omitted or a user-visible string was shortened. */
  readonly truncated: boolean;
}

export interface WebCapabilitySnapshot {
  readonly subagents?: WebCapabilityProjection<WebSubagentActivity>;
  readonly workflows?: WebCapabilityProjection<WebWorkflowActivity>;
  readonly "background-terminals"?: WebCapabilityProjection<WebBackgroundTerminalActivity>;
}

export interface WebCapabilityProvider {
  readonly kind: WebCapabilityKind;
  readonly snapshot: () => WebCapabilityProjection;
  readonly subscribe?: (listener: () => void) => () => void;
}

interface BoundedActivityText {
  readonly value: string;
  readonly truncated: boolean;
}

function boundedActivityText(value: string): BoundedActivityText {
  if (value.length <= WEB_MAX_ACTIVITY_TEXT) {
    return { value, truncated: false };
  }
  return {
    value: `${value.slice(0, WEB_MAX_ACTIVITY_TEXT - 1)}…`,
    truncated: true,
  };
}

function newestActivityAt(value: {
  readonly createdAt?: number;
  readonly startedAt?: number;
  readonly settledAt?: number;
  readonly finishedAt?: number;
}) {
  return (
    value.settledAt ??
    value.finishedAt ??
    value.createdAt ??
    value.startedAt ??
    0
  );
}

function boundedActivityProjection<
  Source extends {
    readonly status: string;
    readonly createdAt?: number;
    readonly startedAt?: number;
    readonly settledAt?: number;
    readonly finishedAt?: number;
  },
  Item,
>(
  source: readonly Source[],
  project: (value: Source) => {
    readonly item: Item;
    readonly truncated: boolean;
  },
) {
  const selected: Source[] = [];
  const compare = (left: Source, right: Source) => {
    const running =
      Number(right.status === "running") - Number(left.status === "running");
    return running || newestActivityAt(right) - newestActivityAt(left);
  };
  for (const value of source) {
    const insertAt = selected.findIndex(
      (current) => compare(value, current) < 0,
    );
    if (insertAt < 0) selected.push(value);
    else selected.splice(insertAt, 0, value);
    if (selected.length > WEB_MAX_CAPABILITY_ITEMS) selected.pop();
  }
  const projected = selected.map(project);
  const omitted = Math.max(0, source.length - projected.length);
  return {
    items: projected.map(({ item }) => item),
    omitted,
    truncated: omitted > 0 || projected.some((value) => value.truncated),
  };
}

export function projectSubagentCapability(
  source: readonly {
    readonly id: string;
    readonly title: string;
    readonly status: WebSubagentActivity["status"];
    readonly outcome?: WebSubagentActivity["outcome"];
    readonly createdAt: number;
    readonly settledAt?: number;
  }[],
): WebCapabilityProjection<WebSubagentActivity> {
  return boundedActivityProjection(source, (value) => {
    const id = boundedActivityText(value.id);
    const title = boundedActivityText(value.title);
    return {
      item: {
        id: id.value,
        title: title.value,
        status: value.status,
        ...(value.outcome ? { outcome: value.outcome } : {}),
        createdAt: value.createdAt,
        ...(value.settledAt !== undefined
          ? { settledAt: value.settledAt }
          : {}),
      },
      truncated: id.truncated || title.truncated,
    };
  });
}

export function projectWorkflowCapability(
  source: readonly {
    readonly runId: string;
    readonly name?: string;
    readonly status: WebWorkflowActivity["status"];
    readonly currentPhase?: string;
    readonly startedAt: number;
    readonly finishedAt?: number;
    readonly agents: readonly {
      readonly state: keyof WebWorkflowActivity["agents"] | string;
    }[];
  }[],
): WebCapabilityProjection<WebWorkflowActivity> {
  return boundedActivityProjection(source, (value) => {
    const runId = boundedActivityText(value.runId);
    const name = value.name ? boundedActivityText(value.name) : undefined;
    const phase = value.currentPhase
      ? boundedActivityText(value.currentPhase)
      : undefined;
    const counts = {
      total: value.agents.length,
      running: 0,
      done: 0,
      error: 0,
      uncertain: 0,
    };
    const scannedAgents = value.agents.slice(
      0,
      WEB_MAX_WORKFLOW_AGENTS_SCANNED,
    );
    for (const agent of scannedAgents) {
      if (agent.state === "running") counts.running++;
      else if (agent.state === "done") counts.done++;
      else if (agent.state === "error") counts.error++;
      else counts.uncertain++;
    }
    const agentsOmitted = value.agents.length - scannedAgents.length;
    return {
      item: {
        runId: runId.value,
        ...(name ? { name: name.value } : {}),
        status: value.status,
        ...(phase ? { currentPhase: phase.value } : {}),
        startedAt: value.startedAt,
        ...(value.finishedAt !== undefined
          ? { finishedAt: value.finishedAt }
          : {}),
        agents: {
          ...counts,
          ...(agentsOmitted > 0 ? { omitted: agentsOmitted } : {}),
        },
      },
      truncated:
        runId.truncated ||
        name?.truncated === true ||
        phase?.truncated === true ||
        agentsOmitted > 0,
    };
  });
}

export function projectBackgroundTerminalCapability(
  source: readonly {
    readonly id: string;
    readonly title: string;
    readonly status: WebBackgroundTerminalActivity["status"];
    readonly createdAt: number;
    readonly settledAt?: number;
    readonly exitCode?: number;
    readonly signal?: string;
  }[],
): WebCapabilityProjection<WebBackgroundTerminalActivity> {
  return boundedActivityProjection(source, (value) => {
    const id = boundedActivityText(value.id);
    const title = boundedActivityText(value.title);
    const signal = value.signal ? boundedActivityText(value.signal) : undefined;
    return {
      item: {
        id: id.value,
        title: title.value,
        status: value.status,
        createdAt: value.createdAt,
        ...(value.settledAt !== undefined
          ? { settledAt: value.settledAt }
          : {}),
        ...(value.exitCode !== undefined ? { exitCode: value.exitCode } : {}),
        ...(signal ? { signal: signal.value } : {}),
      },
      truncated: id.truncated || title.truncated || signal?.truncated === true,
    };
  });
}

/** The Pi SessionManager object itself is the capability-lifetime identity. */
export type WebCapabilityScope = object;

type CapabilityListener = (scope: WebCapabilityScope) => void;
type ProviderSubscriptions = Map<
  WebCapabilityScope,
  Map<WebCapabilityKind, () => void>
>;

interface WebObserverRegistry {
  readonly version: 1;
  readonly providers: Map<
    WebCapabilityScope,
    Map<WebCapabilityKind, WebCapabilityProvider>
  >;
  readonly listeners: Map<CapabilityListener, ProviderSubscriptions>;
}

const WEB_OBSERVER_REGISTRY_KEY = Symbol.for(
  "@tt-a1i/openpi/web-observer-registry/v1",
);

function sharedWebObserverRegistry(): WebObserverRegistry {
  const existing: unknown = Reflect.get(globalThis, WEB_OBSERVER_REGISTRY_KEY);
  if (existing !== undefined) {
    if (
      !existing ||
      typeof existing !== "object" ||
      (existing as { version?: unknown }).version !== 1 ||
      !((existing as { providers?: unknown }).providers instanceof Map) ||
      !((existing as { listeners?: unknown }).listeners instanceof Map)
    ) {
      throw new Error("Incompatible OpenPI Web observer registry");
    }
    return existing as WebObserverRegistry;
  }
  const registry: WebObserverRegistry = {
    version: 1,
    providers: new Map(),
    listeners: new Map(),
  };
  Object.defineProperty(globalThis, WEB_OBSERVER_REGISTRY_KEY, {
    value: registry,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  return registry;
}

// Pi may load package extensions from a managed install while the standalone
// CLI runs from a global npm install. Symbol.for keeps those same-process module
// copies on one versioned registry without adding a second persistence layer.
const { providers, listeners } = sharedWebObserverRegistry();

function connect(
  scope: WebCapabilityScope,
  provider: WebCapabilityProvider,
  listener: CapabilityListener,
) {
  const subscriptions = listeners.get(listener);
  let scopedSubscriptions = subscriptions?.get(scope);
  if (!scopedSubscriptions && subscriptions) {
    scopedSubscriptions = new Map();
    subscriptions.set(scope, scopedSubscriptions);
  }
  scopedSubscriptions?.get(provider.kind)?.();
  const unsubscribe = provider.subscribe?.(() => listener(scope));
  if (unsubscribe) scopedSubscriptions?.set(provider.kind, unsubscribe);
  else scopedSubscriptions?.delete(provider.kind);
}

export function registerWebCapability(
  scope: WebCapabilityScope,
  provider: WebCapabilityProvider,
) {
  let scopedProviders = providers.get(scope);
  if (!scopedProviders) {
    scopedProviders = new Map();
    providers.set(scope, scopedProviders);
  }
  scopedProviders.set(provider.kind, provider);
  for (const listener of listeners.keys()) {
    connect(scope, provider, listener);
    listener(scope);
  }
  return () => {
    const currentProviders = providers.get(scope);
    if (currentProviders?.get(provider.kind) !== provider) return;
    currentProviders.delete(provider.kind);
    if (currentProviders.size === 0) providers.delete(scope);
    for (const [listener, subscriptions] of listeners) {
      const scopedSubscriptions = subscriptions.get(scope);
      scopedSubscriptions?.get(provider.kind)?.();
      scopedSubscriptions?.delete(provider.kind);
      if (scopedSubscriptions?.size === 0) subscriptions.delete(scope);
      listener(scope);
    }
  };
}

export function subscribeWebCapabilities(listener: CapabilityListener) {
  const subscriptions: ProviderSubscriptions = new Map();
  listeners.set(listener, subscriptions);
  for (const [scope, scopedProviders] of providers) {
    for (const provider of scopedProviders.values()) {
      connect(scope, provider, listener);
    }
  }
  return () => {
    listeners.delete(listener);
    for (const scopedSubscriptions of subscriptions.values()) {
      for (const unsubscribe of scopedSubscriptions.values()) unsubscribe();
    }
  };
}

export function webCapabilitySnapshot(
  scope: WebCapabilityScope,
): WebCapabilitySnapshot {
  const scopedProviders = providers.get(scope);
  if (!scopedProviders) return {};
  return Object.fromEntries(
    [...scopedProviders].map(([kind, provider]) => [kind, provider.snapshot()]),
  );
}

export function notifyWebCapabilities(scope: WebCapabilityScope) {
  for (const listener of listeners.keys()) listener(scope);
}
