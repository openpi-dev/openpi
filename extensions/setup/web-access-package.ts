import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DefaultPackageManager,
  type PackageSource,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  EXA_WEB_ACCESS_PROFILE,
  isWebAccessSource,
  WEB_ACCESS_PACKAGE,
  type WebAccessAction,
} from "../shared/web-access.ts";

const sourceOf = (entry: PackageSource) =>
  typeof entry === "string" ? entry : entry.source;

async function matchingPackages(
  entries: PackageSource[],
  manager: DefaultPackageManager,
) {
  const matches: PackageSource[] = [];
  for (const entry of entries) {
    if (isWebAccessSource(sourceOf(entry))) {
      matches.push(entry);
      continue;
    }
    const path = manager.getInstalledPath(sourceOf(entry), "user");
    if (!path) continue;
    try {
      const manifest: unknown = JSON.parse(
        await readFile(join(path, "package.json"), "utf8"),
      );
      if (
        manifest &&
        typeof manifest === "object" &&
        "name" in manifest &&
        manifest.name === WEB_ACCESS_PACKAGE.name
      )
        matches.push(entry);
    } catch {
      // An unrelated package without a readable manifest is not this integration.
    }
  }
  return matches;
}

async function inspectPreferences(path: string) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.size > 128 * 1024)
      throw new Error("Web search preferences must be a regular JSON file.");
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Web search preferences must contain a JSON object.");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    // Do not echo preferences or JSON parse errors: they can contain secrets.
    throw new Error(
      "Cannot safely read web-search.json; existing preferences were preserved.",
    );
  }
}

/** One reviewed integration, using Pi's package manager and native settings.
 * No package is executed, reloaded, or added to OpenPI's capability groups here.
 */
export async function configureWebAccessPackage(options: {
  action: WebAccessAction;
  cwd: string;
  agentDir: string;
  confirm: (title: string, detail: string) => Promise<boolean>;
  signal?: AbortSignal;
}) {
  const { action, cwd, agentDir, signal } = options;
  const settings = SettingsManager.create(cwd, agentDir, {
    projectTrusted: false,
  });
  const manager = new DefaultPackageManager({
    cwd,
    agentDir,
    settingsManager: settings,
  });
  if (settings.drainErrors().length)
    throw new Error(
      "Pi settings could not be read; no package changes were made.",
    );
  const entries = settings.getGlobalSettings().packages ?? [];
  const existing = await matchingPackages(entries, manager);
  if (existing.some((entry) => sourceOf(entry) !== WEB_ACCESS_PACKAGE.source))
    throw new Error(
      "Another pi-web-access source or version is configured. Review it in Plugins before changing this integration.",
    );
  const preferencesPath = join(agentDir, "web-search.json");
  const hasPreferences =
    action !== "disable" && (await inspectPreferences(preferencesPath));
  if (action === "install-exa" && hasPreferences)
    throw new Error(
      "Existing web-search.json was preserved. Choose existing preferences to enable it without replacement.",
    );
  if (action === "install-existing" && !hasPreferences)
    throw new Error(
      "No existing web-search.json was found. Choose Exa for the first setup.",
    );
  if (action === "disable" && !existing.length)
    throw new Error(
      "This optional package is not configured in Pi's user settings.",
    );

  signal?.throwIfAborted();
  const detail =
    action === "disable"
      ? "Disable this package's resources in Pi user settings. Keep its files and preferences. The current Session keeps its loaded tools until you explicitly reload or start a new Session."
      : `${WEB_ACCESS_PACKAGE.source}\n${WEB_ACCESS_PACKAGE.repository}\nThird-party Pi packages execute local code. ${action === "install-exa" ? "Create private web-search.json with Exa search, direct page/PDF reading, dynamic tool activation, and raw search results by default. Browser cookies, Git clones, and video processing are disabled. Search queries go to Exa; pages are fetched directly." : "Keep the existing web-search.json byte for byte, including its selected services and permissions."}\nPi installs dependencies and saves the package in this service's user settings. No credentials are copied and no Session is automatically reloaded.`;
  if (
    !(await options.confirm(
      action === "disable" ? "Disable web search" : "Enable web search",
      detail,
    ))
  )
    throw new Error(
      "Web search setup was cancelled; no package changes were made.",
    );
  signal?.throwIfAborted();

  if (action === "install-exa") {
    await mkdir(agentDir, { recursive: true });
    // Exclusive creation prevents racing setup turns from replacing preferences.
    await writeFile(
      preferencesPath,
      `${JSON.stringify(EXA_WEB_ACCESS_PROFILE, null, 2)}\n`,
      {
        flag: "wx",
        mode: 0o600,
      },
    );
  }
  if (action !== "disable") {
    await manager.install(WEB_ACCESS_PACKAGE.source);
    signal?.throwIfAborted();
    const installedPath = manager.getInstalledPath(
      WEB_ACCESS_PACKAGE.source,
      "user",
    );
    if (!installedPath)
      throw new Error("Pi did not report the installed package path.");
    const manifest: unknown = JSON.parse(
      await readFile(join(installedPath, "package.json"), "utf8"),
    );
    if (
      !manifest ||
      typeof manifest !== "object" ||
      !("name" in manifest) ||
      !("version" in manifest) ||
      manifest.name !== WEB_ACCESS_PACKAGE.name ||
      manifest.version !== WEB_ACCESS_PACKAGE.version
    )
      throw new Error(
        "Installed web search package identity did not match; it was not enabled.",
      );
  }

  // Reload native settings after the potentially slow install; preserve other edits.
  await settings.reload();
  if (settings.drainErrors().length)
    throw new Error(
      "Pi settings changed unreadably; the package was not enabled.",
    );
  const packages = settings.getGlobalSettings().packages ?? [];
  const matches = await matchingPackages(packages, manager);
  if (matches.some((entry) => sourceOf(entry) !== WEB_ACCESS_PACKAGE.source))
    throw new Error(
      "Pi package selection changed during setup; review it before retrying.",
    );
  signal?.throwIfAborted();
  const next =
    action === "disable"
      ? {
          source: WEB_ACCESS_PACKAGE.source,
          extensions: [],
          skills: [],
          prompts: [],
          themes: [],
        }
      : {
          ...(typeof matches[0] === "object" ? matches[0] : {}),
          source: WEB_ACCESS_PACKAGE.source,
          extensions: ["**/*"],
          skills: [],
          prompts: [],
          themes: [],
        };
  settings.setPackages([
    ...packages.filter((entry) => !isWebAccessSource(sourceOf(entry))),
    next,
  ]);
  await settings.flush();
  if (settings.drainErrors().length)
    throw new Error(
      "Pi could not persist web search configuration; loading was not changed.",
    );
  const persisted = SettingsManager.create(cwd, agentDir, {
    projectTrusted: false,
  });
  if (
    persisted.drainErrors().length ||
    !persisted
      .getGlobalSettings()
      .packages?.some(
        (entry) =>
          typeof entry !== "string" &&
          entry.source === WEB_ACCESS_PACKAGE.source &&
          JSON.stringify(entry.extensions) === JSON.stringify(next.extensions),
      )
  )
    throw new Error(
      "Could not verify saved Pi package configuration; loading was not changed.",
    );
  return `Pi web search: ${action === "disable" ? "disabled in native configuration" : "installed and enabled in native configuration"}. Current Session loading is unchanged. Explicitly reload resources while idle, or start a new Session, to apply it.`;
}
