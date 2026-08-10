import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, lstatSync, readFileSync } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  type FileHandle,
} from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DefaultPackageManager,
  getAgentDir,
  SettingsManager,
  type ProgressEvent,
} from "@earendil-works/pi-coding-agent";
import { sanitizeTerminalText } from "../shared/terminal-text.ts";

export const PI_INTERCOM_SOURCE = "npm:pi-intercom";
const PI_INTERCOM_CONFIG_LOCK = "config.json.openpi-install.lock";
const PI_INTERCOM_FS_HELPER = fileURLToPath(
  new URL("./intercom-fs-helper.cjs", import.meta.url),
);

export interface PiIntercomStatus {
  readonly configured: boolean;
  readonly installed: boolean;
  readonly active: boolean;
  readonly version?: string;
  readonly confirmSend?: boolean;
  readonly inboundTrigger?: "always" | "replies" | "never";
  readonly diagnostic?: string;
  readonly reloadRequired?: boolean;
}

interface OptionalFile {
  readonly exists: boolean;
  readonly text?: string;
}

interface PreparedIntercomConfig {
  readonly path: string;
  readonly nextText: string;
  readonly changed: boolean;
}

interface IntercomDirectoryGuard {
  readonly directory: string;
  readonly handle?: FileHandle;
  readonly dev: number | bigint;
  readonly ino: number | bigint;
}

interface PiIntercomInstallOptions {
  readonly agentDir?: string;
  /** Download/repair package files without making the package active. */
  readonly install: (source: typeof PI_INTERCOM_SOURCE) => Promise<void>;
  /** Persist the package source only after the safe config commit. */
  readonly persist?: (source: typeof PI_INTERCOM_SOURCE) => Promise<void>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isErrno = (error: unknown, code: string) =>
  error instanceof Error && "code" in error && error.code === code;

const boundedError = (error: unknown) =>
  sanitizeTerminalText(error instanceof Error ? error.message : String(error))
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 2_000);

export function isPiIntercomPackageSource(source: string) {
  return /^npm:pi-intercom(?:@[^/\s]+)?$/.test(source.trim());
}

function intercomDirectory(agentDir: string) {
  return join(agentDir, "intercom");
}

function intercomConfigPath(agentDir: string) {
  return join(intercomDirectory(agentDir), "config.json");
}

async function ensureIntercomDirectory(agentDir: string) {
  const directory = intercomDirectory(agentDir);
  try {
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(
        `Refusing non-directory or symlinked pi-intercom path at ${directory}.`,
      );
    }
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(
        `Refusing non-directory or symlinked pi-intercom path at ${directory}.`,
      );
    }
  }
  return directory;
}

const sameIdentity = (
  left: { dev: number | bigint; ino: number | bigint },
  right: { dev: number | bigint; ino: number | bigint },
) => left.dev === right.dev && left.ino === right.ino;

async function openIntercomDirectoryGuard(agentDir: string) {
  const directory = await ensureIntercomDirectory(agentDir);
  const current = await lstat(directory, { bigint: true });
  if (process.platform === "win32") {
    return {
      directory,
      dev: current.dev,
      ino: current.ino,
    } satisfies IntercomDirectoryGuard;
  }
  const flags =
    constants.O_RDONLY |
    (constants.O_DIRECTORY ?? 0) |
    (constants.O_NOFOLLOW ?? 0);
  const handle = await open(directory, flags);
  try {
    const identity = await handle.stat({ bigint: true });
    const latest = await lstat(directory, { bigint: true });
    if (
      !identity.isDirectory() ||
      !latest.isDirectory() ||
      latest.isSymbolicLink() ||
      !sameIdentity(identity, latest)
    ) {
      throw new Error(
        `pi-intercom directory identity changed while opening ${directory}.`,
      );
    }
    return {
      directory,
      handle,
      dev: identity.dev,
      ino: identity.ino,
    } satisfies IntercomDirectoryGuard;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function assertIntercomDirectoryIdentity(guard: IntercomDirectoryGuard) {
  const current = await lstat(guard.directory, { bigint: true });
  const held = guard.handle
    ? await guard.handle.stat({ bigint: true })
    : { dev: guard.dev, ino: guard.ino, isDirectory: () => true };
  if (
    !held.isDirectory() ||
    !current.isDirectory() ||
    current.isSymbolicLink() ||
    !sameIdentity(held, current) ||
    held.dev !== guard.dev ||
    held.ino !== guard.ino
  ) {
    throw new Error(
      `pi-intercom directory identity changed during installation at ${guard.directory}.`,
    );
  }
}

async function readOptionalFile(path: string): Promise<OptionalFile> {
  try {
    const [text, metadata] = await Promise.all([
      readFile(path, "utf8"),
      lstat(path),
    ]);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(
        `Refusing non-regular pi-intercom config path at ${path}.`,
      );
    }
    return { exists: true, text };
  } catch (error) {
    if (isErrno(error, "ENOENT")) return { exists: false };
    throw error;
  }
}

function parseIntercomConfig(file: OptionalFile) {
  if (!file.exists) return {};

  let value: unknown;
  try {
    value = JSON.parse(file.text!);
  } catch (error) {
    throw new Error(
      `Refusing to overwrite invalid pi-intercom config (${boundedError(error)}).`,
    );
  }
  if (!isRecord(value)) {
    throw new Error("Refusing to overwrite non-object pi-intercom config.");
  }
  if (
    Object.hasOwn(value, "confirmSend") &&
    typeof value.confirmSend !== "boolean"
  ) {
    throw new Error(
      'Refusing to overwrite pi-intercom config: "confirmSend" must be boolean.',
    );
  }
  if (
    Object.hasOwn(value, "inboundTrigger") &&
    value.inboundTrigger !== "always" &&
    value.inboundTrigger !== "replies" &&
    value.inboundTrigger !== "never"
  ) {
    throw new Error(
      'Refusing to overwrite pi-intercom config: "inboundTrigger" must be "always", "replies", or "never".',
    );
  }
  return value;
}

export async function preparePiIntercomSafeDefaults(
  agentDir = getAgentDir(),
  guard?: IntercomDirectoryGuard,
): Promise<PreparedIntercomConfig> {
  if (guard) await assertIntercomDirectoryIdentity(guard);
  else await ensureIntercomDirectory(agentDir);
  const path = intercomConfigPath(agentDir);
  const original = await readOptionalFile(path);
  if (guard) await assertIntercomDirectoryIdentity(guard);
  const current = parseIntercomConfig(original);
  if (original.exists) {
    const missing = [
      ...(!Object.hasOwn(current, "confirmSend") ? ["confirmSend"] : []),
      ...(!Object.hasOwn(current, "inboundTrigger") ? ["inboundTrigger"] : []),
    ];
    if (missing.length > 0) {
      throw new Error(
        `Existing pi-intercom config is missing ${missing.join(" and ")}; OpenPI will not rewrite an existing preference file. Add confirmSend=true and inboundTrigger=\"replies\", then retry.`,
      );
    }
    return { path, nextText: original.text!, changed: false };
  }

  return {
    path,
    nextText: `${JSON.stringify(
      { confirmSend: true, inboundTrigger: "replies" },
      null,
      2,
    )}\n`,
    changed: true,
  };
}

function helperRuntime() {
  const executable = basename(process.execPath).toLowerCase();
  return executable === "node" ||
    executable === "node.exe" ||
    executable === "bun" ||
    executable === "bun.exe"
    ? process.execPath
    : "node";
}

function runIntercomDirectoryHelper(options: {
  readonly guard: IntercomDirectoryGuard;
  readonly operation: "create" | "remove-owned";
  readonly name: "config.json" | typeof PI_INTERCOM_CONFIG_LOCK;
  readonly payload: string;
}) {
  const encoded = Buffer.from(options.payload, "utf8").toString("base64");
  return new Promise<void>((resolve, reject) => {
    execFile(
      helperRuntime(),
      [
        PI_INTERCOM_FS_HELPER,
        options.operation,
        String(options.guard.dev),
        String(options.guard.ino),
        options.name,
        encoded,
      ],
      {
        cwd: options.guard.directory,
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "" },
        maxBuffer: 16 * 1_024,
        timeout: 5_000,
        windowsHide: true,
      },
      (error, _stdout, stderr) => {
        if (!error) {
          resolve();
          return;
        }
        const marker = stderr.match(/OPENPI:([A-Z]+):([^\r\n]*)/u);
        const failure = new Error(
          marker
            ? `pi-intercom filesystem helper refused ${options.operation}: ${boundedError(marker[2])}`
            : `pi-intercom filesystem helper failed: ${boundedError(error)}`,
          { cause: error },
        );
        if (marker?.[1] === "EEXIST") {
          Object.assign(failure, { code: "EEXIST" });
        }
        reject(failure);
      },
    );
  });
}

async function commitPreparedConfig(
  prepared: PreparedIntercomConfig,
  guard: IntercomDirectoryGuard,
) {
  if (!prepared.changed) return false;
  try {
    if (prepared.path !== join(guard.directory, "config.json")) {
      throw new Error("Refusing unexpected pi-intercom config path.");
    }
    await assertIntercomDirectoryIdentity(guard);
    await runIntercomDirectoryHelper({
      guard,
      operation: "create",
      name: "config.json",
      payload: prepared.nextText,
    });
    await assertIntercomDirectoryIdentity(guard);
    return true;
  } catch (error) {
    if (isErrno(error, "EEXIST")) {
      throw new Error(
        "pi-intercom config appeared while OpenPI was preparing the installation; retry instead of overwriting it.",
      );
    }
    throw error;
  }
}

async function withPiIntercomConfigLock<A>(
  agentDir: string,
  action: (guard: IntercomDirectoryGuard) => Promise<A>,
) {
  const guard = await openIntercomDirectoryGuard(agentDir);
  const lockPath = join(guard.directory, PI_INTERCOM_CONFIG_LOCK);
  const token = `${process.pid}:${randomUUID()}\n`;
  try {
    await assertIntercomDirectoryIdentity(guard);
    await runIntercomDirectoryHelper({
      guard,
      operation: "create",
      name: PI_INTERCOM_CONFIG_LOCK,
      payload: token,
    });
    await assertIntercomDirectoryIdentity(guard);
  } catch (error) {
    await guard.handle?.close().catch(() => undefined);
    if (isErrno(error, "EEXIST")) {
      throw new Error(
        `Another OpenPI pi-intercom installation is active, or a prior process left ${lockPath}. Retry after the active setup finishes; remove a stale lock only after confirming no setup is running.`,
      );
    }
    throw error;
  }

  try {
    try {
      return await action(guard);
    } finally {
      await assertIntercomDirectoryIdentity(guard);
      try {
        await runIntercomDirectoryHelper({
          guard,
          operation: "remove-owned",
          name: PI_INTERCOM_CONFIG_LOCK,
          payload: token,
        });
      } catch (error) {
        throw new Error(
          `Refusing uncertain pi-intercom install-lock cleanup at ${lockPath}: ${boundedError(error)}`,
        );
      }
    }
  } finally {
    await guard.handle?.close().catch(() => undefined);
  }
}

export async function installPiIntercomSafely(
  options: PiIntercomInstallOptions,
) {
  const agentDir = options.agentDir ?? getAgentDir();
  return withPiIntercomConfigLock(agentDir, async (guard) => {
    // Validate before spending network/disk work, but re-read after the package
    // download so a concurrent manual edit is never replaced from a stale
    // pre-download snapshot.
    await preparePiIntercomSafeDefaults(agentDir, guard);
    try {
      await options.install(PI_INTERCOM_SOURCE);
    } catch (error) {
      throw new Error(boundedError(error), { cause: error });
    }

    const prepared = await preparePiIntercomSafeDefaults(agentDir, guard);
    const committed = await commitPreparedConfig(prepared, guard);
    try {
      await options.persist?.(PI_INTERCOM_SOURCE);
    } catch (error) {
      const retained = committed
        ? " Safe defaults were retained because package activation may have reached disk."
        : " Existing pi-intercom preferences were preserved.";
      throw new Error(`${boundedError(error)}${retained}`, { cause: error });
    }
  });
}

function inspectInstalledPackage(installedPath: string | undefined) {
  if (!installedPath) return { installed: false as const };
  try {
    const directoryMetadata = lstatSync(installedPath);
    if (
      !directoryMetadata.isDirectory() ||
      directoryMetadata.isSymbolicLink()
    ) {
      throw new Error("installed package directory is not a regular directory");
    }
    const manifestPath = join(installedPath, "package.json");
    const manifestMetadata = lstatSync(manifestPath);
    if (!manifestMetadata.isFile() || manifestMetadata.isSymbolicLink()) {
      throw new Error("installed package manifest is not a regular file");
    }
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
    if (!isRecord(manifest) || manifest.name !== "pi-intercom") {
      return {
        installed: false as const,
        diagnostic: `Installed package identity mismatch at ${installedPath}.`,
      };
    }
    return {
      installed: true as const,
      ...(typeof manifest.version === "string"
        ? { version: manifest.version }
        : {}),
    };
  } catch (error) {
    return {
      installed: false as const,
      diagnostic: `Cannot verify installed pi-intercom package at ${installedPath}: ${boundedError(error)}`,
    };
  }
}

function readEffectiveSafety(agentDir: string):
  | Pick<PiIntercomStatus, "confirmSend" | "inboundTrigger">
  | {
      diagnostic: string;
    } {
  try {
    const directoryMetadata = lstatSync(intercomDirectory(agentDir));
    if (
      !directoryMetadata.isDirectory() ||
      directoryMetadata.isSymbolicLink()
    ) {
      throw new Error("Refusing symlinked pi-intercom config directory.");
    }
    const path = intercomConfigPath(agentDir);
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error("Refusing non-regular pi-intercom config file.");
    }
    const value = parseIntercomConfig({
      exists: true,
      text: readFileSync(path, "utf8"),
    });
    return {
      confirmSend:
        typeof value.confirmSend === "boolean" ? value.confirmSend : false,
      inboundTrigger:
        value.inboundTrigger === "always" ||
        value.inboundTrigger === "replies" ||
        value.inboundTrigger === "never"
          ? value.inboundTrigger
          : ("always" as const),
    };
  } catch (error) {
    return isErrno(error, "ENOENT")
      ? { confirmSend: false, inboundTrigger: "always" as const }
      : { diagnostic: boundedError(error) };
  }
}

function settingsErrorsMessage(
  errors: ReturnType<SettingsManager["drainErrors"]>,
) {
  return errors
    .map(({ scope, error }) => `${scope}: ${boundedError(error)}`)
    .join("; ")
    .slice(0, 2_000);
}

export function inspectPiIntercom(options: {
  readonly cwd: string;
  readonly active: boolean;
  readonly agentDir?: string;
}): PiIntercomStatus {
  const agentDir = options.agentDir ?? getAgentDir();
  const settingsManager = SettingsManager.create(options.cwd, agentDir, {
    projectTrusted: false,
  });
  const settingsErrors = settingsManager.drainErrors();
  if (settingsErrors.length > 0) {
    return {
      configured: false,
      installed: false,
      active: options.active,
      diagnostic: settingsErrorsMessage(settingsErrors),
    };
  }

  const packageManager = new DefaultPackageManager({
    cwd: options.cwd,
    agentDir,
    settingsManager,
  });
  const configuredPackage = packageManager
    .listConfiguredPackages()
    .find(({ source }) => isPiIntercomPackageSource(source));
  const safety = readEffectiveSafety(agentDir);
  const installed = inspectInstalledPackage(configuredPackage?.installedPath);
  return {
    configured: Boolean(configuredPackage),
    active: options.active,
    ...installed,
    ...safety,
  };
}

export async function installPiIntercom(options: {
  readonly cwd: string;
  readonly agentDir?: string;
  readonly onProgress?: (event: ProgressEvent) => void;
}) {
  const agentDir = options.agentDir ?? getAgentDir();
  const settingsManager = SettingsManager.create(options.cwd, agentDir, {
    projectTrusted: false,
  });
  const initialErrors = settingsManager.drainErrors();
  if (initialErrors.length > 0) {
    throw new Error(
      `Cannot install pi-intercom while Pi settings are invalid: ${settingsErrorsMessage(initialErrors)}`,
    );
  }

  const packageManager = new DefaultPackageManager({
    cwd: options.cwd,
    agentDir,
    settingsManager,
  });
  packageManager.setProgressCallback(options.onProgress);
  await installPiIntercomSafely({
    agentDir,
    install: (source) => packageManager.install(source),
    persist: async (source) => {
      packageManager.addSourceToSettings(source);
      await settingsManager.flush();
      const errors = settingsManager.drainErrors();
      if (errors.length > 0) {
        throw new Error(
          `Pi could not persist the package setting: ${settingsErrorsMessage(errors)}`,
        );
      }
    },
  });
}

export function formatPiIntercomStatus(status: PiIntercomStatus) {
  if (status.diagnostic) {
    return `Intercom: unavailable (${boundedError(status.diagnostic)})`;
  }
  if (!status.configured && !status.active) {
    return "Intercom: not installed · optional setup component";
  }

  const state = status.active
    ? "active"
    : status.installed
      ? status.reloadRequired
        ? "installed · /reload required"
        : "installed · inactive or filtered"
      : "configured · package files missing";
  const version = status.version ? ` ${status.version}` : "";
  const safety =
    status.confirmSend === undefined || status.inboundTrigger === undefined
      ? ""
      : ` · confirmSend ${status.confirmSend ? "on" : "off"} · inboundTrigger ${status.inboundTrigger}`;
  return `Intercom:${version} · ${state} · parent-only${safety}`;
}
