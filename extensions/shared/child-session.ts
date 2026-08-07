import * as path from "node:path";
import {
  DefaultResourceLoader,
  getAgentDir,
  ProjectTrustStore,
  SettingsManager,
  type AgentSession,
  type SessionShutdownEvent,
} from "@earendil-works/pi-coding-agent";

export const CHILD_SHUTDOWN_TIMEOUT_MS = 5_000;

/**
 * The only package tools a headless child may keep. Read-only discovery tools
 * are safe for children; every other tool this package registers is parent-only
 * because it orchestrates work, mutates shared runtime state, drives the parent
 * UI, or asks the user. This is the allowlist half of a fail-closed boundary:
 * anything registered by this package and not listed here MUST be excluded, and
 * `child-session.test.ts` scans the extensions to enforce exactly that — so a
 * future tool cannot silently leak into children by being forgotten. The scan
 * covers both inline-named registrations and factory-style ones (e.g.
 * `registerTool(createEditToolDefinition(...))`); an unrecognized factory
 * registration fails the guard rather than escaping it.
 */
export const CHILD_SAFE_PACKAGE_TOOL_NAMES = ["fd", "rg"] as const;

/**
 * Tools that headless children must not receive. Children run without a UI and
 * cannot orchestrate, so every parent-only tool this package ships is denied.
 * Grouped by owning extension; keep in sync with the extensions (guarded by the
 * drift test in child-session.test.ts).
 */
export const CHILD_EXCLUDED_TOOL_NAMES = [
  // subagents — children cannot spawn/observe more agents
  "subagent_spawn",
  "subagent_wait",
  "subagent_cancel",
  "subagent_send",
  "subagent_check",
  "subagent_list",
  // workflows — children cannot recursively orchestrate or manage runs
  "workflow",
  "workflow_stop",
  "workflow_status",
  // ask-user — headless children have no user to ask
  "ask_user",
  // tasks — the parent session owns its work-intent ledger
  "tasks_add",
  "tasks_update",
  "tasks_list",
  // goal — the parent session owns its persistent goal
  "get_goal",
  "create_goal",
  "update_goal",
  // setup — configuration is a package-owned, parent-only choice
  "configure_my_pi_setup",
  // background-terminals — a child's processes would be invisible to the
  // parent's /ps and could outlive the child, so children cannot start them
  "bg_start",
  "bg_status",
  "bg_list",
  "bg_kill",
  "bg_watch",
  // context-pivot — compaction of the conversation is a parent-only decision
  "context_pivot",
] as const;

/**
 * Fresh SDK options avoid turning the denylist into an accidental allowlist.
 *
 * `tools` narrows further, for an agent type that fixes a child's capabilities
 * (see `../subagents/src/agent-types.ts`). It can only ever REMOVE: pi admits a
 * tool when `(!allowed || allowed.has(name)) && !excluded.has(name)`, so an
 * allowlist naming an excluded tool still cannot obtain it, and the boundary
 * above stays authoritative. Omitting `tools` keeps today's behavior.
 *
 * Remove parent-only tools before exposing or enforcing a requested allowlist.
 * Undefined preserves the normal child tool set; an empty array deliberately
 * means no tools.
 */
export function effectiveChildToolAllowlist(tools?: readonly string[]) {
  return tools?.filter(
    (tool) => !CHILD_EXCLUDED_TOOL_NAMES.includes(tool as never),
  );
}

export function childToolPolicy(tools?: readonly string[]) {
  const effectiveTools = effectiveChildToolAllowlist(tools);
  return {
    excludeTools: [...CHILD_EXCLUDED_TOOL_NAMES],
    ...(effectiveTools ? { tools: effectiveTools } : {}),
  };
}

export interface ChildResourceOptions {
  cwd: string;
  projectTrusted: boolean;
  appendSystemPrompt?: string[];
  agentDir?: string;
}

/** Load normal global/package resources and trust-gated project resources. */
export async function createChildResources(options: ChildResourceOptions) {
  const agentDir = options.agentDir ?? getAgentDir();
  const settingsManager = SettingsManager.create(options.cwd, agentDir, {
    projectTrusted: options.projectTrusted,
  });
  const loader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir,
    settingsManager,
    ...(options.appendSystemPrompt
      ? { appendSystemPrompt: options.appendSystemPrompt }
      : {}),
  });
  await loader.reload();
  return { loader, settingsManager };
}

/**
 * Whether Pi's persisted trust store explicitly trusts this directory (or a
 * containing one). Unreadable or invalid trust data fails closed.
 *
 * Use this when no live trust decision exists yet — notably at extension
 * registration, which runs before `session_start`.
 */
export function isProjectTrustedOnDisk(cwd: string, agentDir?: string) {
  try {
    const trustStore = new ProjectTrustStore(agentDir ?? getAgentDir());
    return trustStore.get(cwd) === true;
  } catch {
    return false;
  }
}

/**
 * Same-directory children inherit the live parent decision. An alternate cwd
 * is trusted only when Pi's persisted trust store explicitly trusts it (or a
 * containing directory); unreadable/invalid trust data fails closed.
 */
export function resolveStandaloneChildProjectTrust(options: {
  parentCwd: string;
  childCwd: string;
  parentTrusted: boolean;
  agentDir?: string;
}) {
  if (path.resolve(options.childCwd) === path.resolve(options.parentCwd)) {
    return options.parentTrusted;
  }
  return isProjectTrustedOnDisk(options.childCwd, options.agentDir);
}

interface ChildSessionStartup {
  bindExtensions(bindings: { mode: "print" }): Promise<void>;
  getActiveToolNames(): string[];
}

function boundedToolNames(names: readonly string[]) {
  const shown = names
    .slice(0, 8)
    .map((name) => JSON.stringify(name.slice(0, 128)))
    .join(", ");
  return names.length > 8 ? `${shown}, and ${names.length - 8} more` : shown;
}

/**
 * Start child extensions, then fail before the first prompt if an explicit
 * allowlist names a tool that the final bound registry cannot actually expose.
 * Parent-only names are deliberately ignored here: the denylist remains
 * authoritative, so naming one can never turn this check into a grant.
 */
export async function bindChildSessionExtensions(
  session: ChildSessionStartup,
  requestedTools?: readonly string[],
) {
  await session.bindExtensions({ mode: "print" });
  const requested = effectiveChildToolAllowlist(requestedTools);
  if (!requested) return;

  const active = new Set(session.getActiveToolNames());
  const missing = [...new Set(requested)].filter((name) => !active.has(name));
  if (missing.length === 0) return;

  throw new Error(
    `Child tool preflight failed: requested tool${missing.length === 1 ? "" : "s"} ${boundedToolNames(missing)} ${missing.length === 1 ? "is" : "are"} unavailable after child extensions initialized. Check the Agent Type tools list and child extension loading.`,
  );
}

interface ChildExtensionRunner {
  hasHandlers(eventType: string): boolean;
  emit(event: SessionShutdownEvent): Promise<unknown>;
}

export interface DisposableChildSession {
  readonly extensionRunner: ChildExtensionRunner;
  dispose(): void;
}

const childShutdowns = new WeakMap<object, Promise<void>>();

/** Await an operation but never longer than `timeoutMs`; never rejects. */
export function waitBounded(operation: Promise<unknown>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  return Promise.race([
    operation.then(
      () => undefined,
      () => undefined,
    ),
    timeout,
  ])
    .catch(() => {})
    .finally(() => {
      if (timer) clearTimeout(timer);
    });
}

/**
 * Emit child session_shutdown once, then dispose once. Hook failures and a
 * bounded hook deadline never prevent disposal.
 */
export function shutdownAndDisposeChildSession(
  session: DisposableChildSession,
  options: { timeoutMs?: number } = {},
) {
  const existing = childShutdowns.get(session);
  if (existing) return existing;

  const shutdown = (async () => {
    try {
      if (session.extensionRunner.hasHandlers("session_shutdown")) {
        await waitBounded(
          session.extensionRunner.emit({
            type: "session_shutdown",
            reason: "quit",
          }),
          options.timeoutMs ?? CHILD_SHUTDOWN_TIMEOUT_MS,
        );
      }
    } catch {
      // Extension runner inspection/emission is best-effort during teardown.
    } finally {
      try {
        session.dispose();
      } catch {
        // Disposal is terminal and must remain idempotent for callers.
      }
    }
  })();

  childShutdowns.set(session, shutdown);
  return shutdown;
}
