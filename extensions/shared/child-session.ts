import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DefaultPackageManager,
  DefaultResourceLoader,
  getAgentDir,
  type LoadExtensionsResult,
  type PackageSource,
  ProjectTrustStore,
  type ResolvedPaths,
  type SessionShutdownEvent,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  OPENPI_OWNER_SOURCE_PATHS,
  OPENPI_TOOL_SURFACE,
  type OpenPiToolOwner,
} from "./tool-surface.ts";

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
export const CHILD_SAFE_PACKAGE_TOOL_NAMES = [
  "fd",
  "rg",
  "git_show",
  "git_diff",
  "git_log",
] as const;

/**
 * pi-intercom resources are unsafe inside concurrent in-process child sessions.
 * It stores session identity and optional supervisor bridge metadata in
 * process.env, which is shared by every Direct/Workflow child in this process.
 * Loading it in children can therefore cross-wire identities; the parent
 * extension remains loaded and fully usable.
 */
function manifestNamesPiIntercom(manifestPath: string) {
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
    return (
      typeof manifest === "object" &&
      manifest !== null &&
      !Array.isArray(manifest) &&
      (manifest as Record<string, unknown>).name === "pi-intercom"
    );
  } catch (error) {
    throw new Error(
      `Cannot verify child package identity from ${manifestPath}`,
      { cause: error },
    );
  }
}

function installedPathNamesPiIntercom(installedPath: string) {
  try {
    const stats = statSync(installedPath);
    if (stats.isDirectory()) {
      const manifestPath = path.join(installedPath, "package.json");
      if (existsSync(manifestPath)) {
        return manifestNamesPiIntercom(manifestPath);
      }
      if (path.basename(installedPath) === "pi-intercom") {
        throw new Error(
          `Cannot verify child package identity from ${installedPath}`,
        );
      }
      return false;
    }
    if (!stats.isFile()) {
      throw new Error(
        `Cannot verify child package identity from ${installedPath}`,
      );
    }

    let current = path.dirname(installedPath);
    let hasIntercomDirectoryName = false;
    while (true) {
      hasIntercomDirectoryName ||= path.basename(current) === "pi-intercom";
      const manifestPath = path.join(current, "package.json");
      if (existsSync(manifestPath)) {
        return manifestNamesPiIntercom(manifestPath);
      }
      const parent = path.dirname(current);
      if (parent === current) {
        if (hasIntercomDirectoryName) {
          throw new Error(
            `Cannot verify child package identity from ${installedPath}`,
          );
        }
        return false;
      }
      current = parent;
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("Cannot verify child package identity")
    ) {
      throw error;
    }
    throw new Error(
      `Cannot verify child package identity from ${installedPath}`,
      { cause: error },
    );
  }
}

function piMatchesPublishedIntercomSource(options: {
  source: string;
  cwd: string;
  agentDir: string;
}) {
  const settingsManager = SettingsManager.inMemory({
    packages: [options.source],
  });
  const packageManager = new DefaultPackageManager({
    cwd: options.cwd,
    agentDir: options.agentDir,
    settingsManager,
  });
  return (
    packageManager.removeSourceFromSettings("npm:pi-intercom") ||
    packageManager.removeSourceFromSettings(
      "git:https://github.com/nicobailon/pi-intercom",
    )
  );
}

function createPiIntercomPackageMatcher(options: {
  cwd: string;
  agentDir: string;
}) {
  const sourceMatches = new Map<string, boolean>();
  const installedPathMatches = new Map<string, boolean>();
  return (source: string, installedPath?: string) => {
    let sourceMatch = sourceMatches.get(source);
    if (sourceMatch === undefined) {
      sourceMatch = piMatchesPublishedIntercomSource({
        source,
        cwd: options.cwd,
        agentDir: options.agentDir,
      });
      sourceMatches.set(source, sourceMatch);
    }
    if (sourceMatch || installedPath === undefined) return sourceMatch;

    const resolvedPath = path.resolve(installedPath);
    let installedPathMatch = installedPathMatches.get(resolvedPath);
    if (installedPathMatch === undefined) {
      installedPathMatch = installedPathNamesPiIntercom(resolvedPath);
      installedPathMatches.set(resolvedPath, installedPathMatch);
    }
    return installedPathMatch;
  };
}

function packageSourceValue(source: PackageSource) {
  return typeof source === "string" ? source : source.source;
}

const CHILD_DISABLED_OPENPI_EXTENSION =
  "-extensions/git-info/index.ts" as const;
const OPENPI_GIT_INFO_EXTENSION_PATH = realpathSync.native(
  fileURLToPath(new URL("../git-info/index.ts", import.meta.url)),
);

function canonicalExistingPath(value: string) {
  try {
    return realpathSync.native(value);
  } catch {
    return undefined;
  }
}

function excludeOpenPiGitInfoExtension(
  resources: LoadExtensionsResult,
): LoadExtensionsResult {
  return {
    ...resources,
    extensions: resources.extensions.filter(
      (extension) =>
        canonicalExistingPath(extension.resolvedPath) !==
        OPENPI_GIT_INFO_EXTENSION_PATH,
    ),
  };
}

function installedPathNamesOpenPi(installedPath: string) {
  try {
    const stats = statSync(installedPath);
    if (stats.isDirectory()) {
      const manifestPath = path.join(installedPath, "package.json");
      if (!existsSync(manifestPath)) return false;
      const manifest = JSON.parse(
        readFileSync(manifestPath, "utf8"),
      ) as unknown;
      return (
        typeof manifest === "object" &&
        manifest !== null &&
        !Array.isArray(manifest) &&
        (manifest as Record<string, unknown>).name === "@tt-a1i/openpi"
      );
    }
    let current = stats.isFile() ? path.dirname(installedPath) : undefined;
    while (current) {
      const manifestPath = path.join(current, "package.json");
      if (existsSync(manifestPath)) {
        const manifest = JSON.parse(
          readFileSync(manifestPath, "utf8"),
        ) as unknown;
        return (
          typeof manifest === "object" &&
          manifest !== null &&
          !Array.isArray(manifest) &&
          (manifest as Record<string, unknown>).name === "@tt-a1i/openpi"
        );
      }
      const parent = path.dirname(current);
      if (parent === current) return false;
      current = parent;
    }
    return false;
  } catch {
    return false;
  }
}

function piMatchesPublishedOpenPiSource(options: {
  source: string;
  cwd: string;
  agentDir: string;
}) {
  const settingsManager = SettingsManager.inMemory({
    packages: [options.source],
  });
  const packageManager = new DefaultPackageManager({
    cwd: options.cwd,
    agentDir: options.agentDir,
    settingsManager,
  });
  return (
    packageManager.removeSourceFromSettings("npm:@tt-a1i/openpi") ||
    packageManager.removeSourceFromSettings(
      "git:https://github.com/openpi-dev/openpi",
    ) ||
    packageManager.removeSourceFromSettings(
      "git:https://github.com/tt-a1i/openpi",
    )
  );
}

function createOpenPiPackageMatcher(options: {
  cwd: string;
  agentDir: string;
}) {
  const sourceMatches = new Map<string, boolean>();
  const installedPathMatches = new Map<string, boolean>();
  return (source: string, installedPath?: string) => {
    let sourceMatch = sourceMatches.get(source);
    if (sourceMatch === undefined) {
      sourceMatch = piMatchesPublishedOpenPiSource({ source, ...options });
      sourceMatches.set(source, sourceMatch);
    }
    if (sourceMatch || installedPath === undefined) return sourceMatch;

    const resolvedPath = path.resolve(installedPath);
    let installedPathMatch = installedPathMatches.get(resolvedPath);
    if (installedPathMatch === undefined) {
      installedPathMatch = installedPathNamesOpenPi(resolvedPath);
      installedPathMatches.set(resolvedPath, installedPathMatch);
    }
    return installedPathMatch;
  };
}

function openPiPackageSources(
  packageManager: DefaultPackageManager,
  options: { cwd: string; agentDir: string },
) {
  const isOpenPiPackage = createOpenPiPackageMatcher(options);
  const sources = {
    user: new Set<string>(),
    project: new Set<string>(),
  };
  for (const configured of packageManager.listConfiguredPackages()) {
    if (isOpenPiPackage(configured.source, configured.installedPath)) {
      sources[configured.scope].add(configured.source);
    }
  }
  return sources;
}

function disablesOpenPiGitInfo(pattern: string) {
  return (
    pattern.startsWith("-") &&
    pattern.slice(1).replace(/^\.\//, "") ===
      CHILD_DISABLED_OPENPI_EXTENSION.slice(1)
  );
}

function disableOpenPiGitInfo(source: PackageSource): PackageSource {
  if (typeof source !== "string") {
    if (source.extensions?.length === 0) return source;
    if (source.autoload === false && source.extensions === undefined) {
      return source;
    }
  }
  const configured = typeof source === "string" ? { source } : source;
  const extensions = [...(configured.extensions ?? [])];
  if (!extensions.some(disablesOpenPiGitInfo)) {
    extensions.push(CHILD_DISABLED_OPENPI_EXTENSION);
  }
  return { ...configured, extensions };
}

function blockedPackageSources(
  packageManager: DefaultPackageManager,
  resolvedPaths: ResolvedPaths,
  options: { cwd: string; agentDir: string },
) {
  const isPiIntercomPackage = createPiIntercomPackageMatcher(options);
  const blocked = {
    user: new Set<string>(),
    project: new Set<string>(),
  };
  for (const configured of packageManager.listConfiguredPackages()) {
    if (isPiIntercomPackage(configured.source, configured.installedPath)) {
      blocked[configured.scope].add(configured.source);
    }
  }

  const resources = [
    ...resolvedPaths.extensions,
    ...resolvedPaths.skills,
    ...resolvedPaths.prompts,
    ...resolvedPaths.themes,
  ];
  for (const resource of resources) {
    const { metadata } = resource;
    if (
      metadata.origin !== "package" ||
      metadata.scope === "temporary" ||
      !isPiIntercomPackage(metadata.source, metadata.baseDir)
    ) {
      continue;
    }
    blocked[metadata.scope].add(metadata.source);
  }
  return blocked;
}

function createEphemeralChildSettings(
  sourceSettings: SettingsManager,
  blockedSources: { user: Set<string>; project: Set<string> },
  openPiSources: { user: Set<string>; project: Set<string> },
  projectTrusted: boolean,
) {
  const globalSettings = sourceSettings.getGlobalSettings();
  const projectSettings = sourceSettings.getProjectSettings();
  const settingsForScope = (
    settings: typeof globalSettings,
    scope: "user" | "project",
  ) => ({
    ...settings,
    packages: settings.packages
      ?.filter(
        (source) => !blockedSources[scope].has(packageSourceValue(source)),
      )
      .map((source) =>
        openPiSources[scope].has(packageSourceValue(source))
          ? disableOpenPiGitInfo(source)
          : source,
      ),
  });
  const contents = {
    global: JSON.stringify(settingsForScope(globalSettings, "user")),
    project: JSON.stringify(settingsForScope(projectSettings, "project")),
  };
  const storage: Parameters<typeof SettingsManager.fromStorage>[0] = {
    withLock(scope, update) {
      const next = update(contents[scope]);
      if (next !== undefined) contents[scope] = next;
    },
  };
  return SettingsManager.fromStorage(storage, { projectTrusted });
}

async function createChildSettingsManager(options: {
  cwd: string;
  agentDir: string;
  projectTrusted: boolean;
}) {
  const sourceSettings = SettingsManager.create(options.cwd, options.agentDir, {
    projectTrusted: options.projectTrusted,
  });
  const packageManager = new DefaultPackageManager({
    cwd: options.cwd,
    agentDir: options.agentDir,
    settingsManager: sourceSettings,
  });
  const resolvedPaths = await packageManager.resolve(async () => "skip");
  const blockedSources = blockedPackageSources(packageManager, resolvedPaths, {
    cwd: options.cwd,
    agentDir: options.agentDir,
  });
  const openPiSources = openPiPackageSources(packageManager, {
    cwd: options.cwd,
    agentDir: options.agentDir,
  });

  return createEphemeralChildSettings(
    sourceSettings,
    blockedSources,
    openPiSources,
    options.projectTrusted,
  );
}

/**
 * Tools that headless children must not receive. Children run without a UI and
 * cannot orchestrate, so every parent-only tool this package ships is denied.
 * Grouped by owning extension; keep in sync with the extensions (guarded by the
 * drift test in child-session.test.ts).
 */
export const CHILD_EXCLUDED_TOOL_NAMES = [
  // capability discovery mutates the parent model-facing tool surface
  "openpi_load_tools",
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
  // ask-user — headless children have no user to ask or handoff to
  "ask_user",
  "human_handoff",
  // plan-mode — completion controls the parent session's write gate and UI
  "plan_ready",
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

const PARENT_ONLY_OPENPI_EXTENSION_PATHS = new Set(
  (Object.keys(OPENPI_TOOL_SURFACE) as OpenPiToolOwner[])
    .filter((owner) => {
      const { entry, deferred } = OPENPI_TOOL_SURFACE[owner];
      const toolNames = [...entry, ...deferred];
      return (
        toolNames.length > 0 &&
        toolNames.every((name) =>
          CHILD_EXCLUDED_TOOL_NAMES.includes(name as never),
        )
      );
    })
    .map((owner) => canonicalExistingPath(OPENPI_OWNER_SOURCE_PATHS[owner]))
    .filter(
      (extensionPath): extensionPath is string => extensionPath !== undefined,
    ),
);

function isVerifiedParentOnlyOpenPiExtension(extension: {
  path: string;
  resolvedPath: string;
  sourceInfo: { path: string };
}) {
  return [
    extension.path,
    extension.resolvedPath,
    extension.sourceInfo.path,
  ].some((candidate) => {
    const canonicalPath = canonicalExistingPath(candidate);
    return (
      canonicalPath !== undefined &&
      PARENT_ONLY_OPENPI_EXTENSION_PATHS.has(canonicalPath)
    );
  });
}

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
  const settingsManager = await createChildSettingsManager({
    cwd: options.cwd,
    agentDir,
    projectTrusted: options.projectTrusted,
  });
  const loader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir,
    settingsManager,
    extensionsOverride(base) {
      const withoutGitInfo = excludeOpenPiGitInfoExtension(base);
      return {
        ...withoutGitInfo,
        extensions: withoutGitInfo.extensions.filter(
          (extension) => !isVerifiedParentOnlyOpenPiExtension(extension),
        ),
      };
    },
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
  getActiveToolNames?(): string[];
  getAllTools?(): { name: string }[];
  setActiveToolsByName?(toolNames: string[]): void;
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
  let active: Set<string> | undefined;
  if (
    session.getActiveToolNames &&
    session.getAllTools &&
    session.setActiveToolsByName
  ) {
    const requestedSet = requested ? new Set(requested) : undefined;
    const available = new Set(session.getAllTools().map(({ name }) => name));
    const activeNames = session.getActiveToolNames();
    active = new Set(activeNames);
    for (const name of CHILD_SAFE_PACKAGE_TOOL_NAMES) {
      if (
        available.has(name) &&
        !active.has(name) &&
        (requestedSet === undefined || requestedSet.has(name))
      ) {
        activeNames.push(name);
        active.add(name);
      }
    }
    if (activeNames.length !== session.getActiveToolNames().length) {
      session.setActiveToolsByName(activeNames);
    }
  }
  if (!requested) return;

  if (!active && session.getActiveToolNames) {
    active = new Set(session.getActiveToolNames());
  }
  if (!active) {
    throw new Error(
      "Child tool preflight failed: the bound child session does not expose active-tool introspection.",
    );
  }

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
  abort?(): Promise<unknown>;
  dispose(): void;
}

export interface ChildShutdownResult {
  ok: boolean;
  errors: string[];
  timedOut: boolean;
}

const childShutdowns = new WeakMap<object, Promise<ChildShutdownResult>>();

function shutdownError(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(
    0,
    4096,
  );
}

/** Await an operation but never longer than `timeoutMs`; return whether it settled. */
export async function waitBounded(
  operation: Promise<unknown>,
  timeoutMs: number,
) {
  const result = await waitUntil(
    operation,
    Date.now() + timeoutMs,
    "Operation",
  );
  return !result.timedOut;
}

/** Await an operation until a shared deadline and retain failure information. */
async function waitUntil(
  operation: Promise<unknown>,
  deadline: number,
  label: string,
): Promise<{ error?: string; timedOut: boolean }> {
  const remaining = Math.max(0, deadline - Date.now());
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ error: string; timedOut: true }>((resolve) => {
    // This timer owns the awaited deadline contract. Keep it referenced so a
    // short-lived Node 22 process cannot exit with the promise still pending.
    timer = setTimeout(
      () => resolve({ error: `${label} timed out`, timedOut: true }),
      remaining,
    );
  });
  const completed = operation.then(
    () => ({ timedOut: false as const }),
    (error) => ({
      error: `${label} failed: ${shutdownError(error)}`,
      timedOut: false as const,
    }),
  );
  const result = await Promise.race([completed, timeout]);
  if (timer) clearTimeout(timer);
  return result;
}

/**
 * Request abort when needed, emit child session_shutdown once, and dispose
 * once. The whole sequence shares one deadline and reports timeout/failure
 * instead of silently turning failed cleanup into success.
 */
export function shutdownAndDisposeChildSession(
  session: DisposableChildSession,
  options: {
    timeoutMs?: number;
    abort?: boolean;
    abortOperation?: Promise<unknown>;
  } = {},
) {
  const existing = childShutdowns.get(session);
  if (existing) return existing;

  const shutdown = (async (): Promise<ChildShutdownResult> => {
    const errors: string[] = [];
    let timedOut = false;
    const deadline =
      Date.now() + (options.timeoutMs ?? CHILD_SHUTDOWN_TIMEOUT_MS);

    if (options.abort || options.abortOperation) {
      let abortOperation = options.abortOperation;
      try {
        abortOperation ??= session.abort?.();
      } catch (error) {
        errors.push(`Agent abort failed: ${shutdownError(error)}`);
      }
      if (abortOperation) {
        const result = await waitUntil(abortOperation, deadline, "Agent abort");
        if (result.error) errors.push(result.error);
        timedOut ||= result.timedOut;
      }
    }

    try {
      if (session.extensionRunner.hasHandlers("session_shutdown")) {
        const result = await waitUntil(
          session.extensionRunner.emit({
            type: "session_shutdown",
            reason: "quit",
          }),
          deadline,
          "Child session shutdown",
        );
        if (result.error) errors.push(result.error);
        timedOut ||= result.timedOut;
      }
    } catch (error) {
      errors.push(`Child session shutdown failed: ${shutdownError(error)}`);
    }

    try {
      session.dispose();
    } catch (error) {
      errors.push(`Child session disposal failed: ${shutdownError(error)}`);
    }

    return { ok: errors.length === 0, errors, timedOut };
  })();

  childShutdowns.set(session, shutdown);
  return shutdown;
}
