import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  DefaultPackageManager,
  type PackageSource,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

export function packageDisabled(entry: PackageSource) {
  return typeof entry !== "string" && [entry.extensions, entry.skills, entry.prompts, entry.themes]
    .every((resources) => Array.isArray(resources) && resources.length === 0);
}

/** Read native configuration without resolving, installing, or executing resources. */
export function readConfiguredPackages(cwd: string, agentDir: string, projectTrusted: boolean) {
  const settings = SettingsManager.create(cwd, agentDir, { projectTrusted });
  const manager = new DefaultPackageManager({ cwd, agentDir, settingsManager: settings });
  const errors = settings.drainErrors();
  const packages = manager.listConfiguredPackages().map((pkg) => {
    const entries = pkg.scope === "project"
      ? settings.getProjectSettings().packages : settings.getGlobalSettings().packages;
    const entry = entries?.find((value) => (typeof value === "string" ? value : value.source) === pkg.source);
    let name: string | undefined;
    let installedVersion: string | undefined;
    let installed = false;
    const diagnostics: string[] = errors.filter((error) => error.scope === pkg.scope)
      .map(() => "Pi could not read this scope's settings.");
    if (pkg.installedPath) {
      try {
        const entryStat = statSync(pkg.installedPath);
        installed = entryStat.isDirectory() || entryStat.isFile();
        const path = join(pkg.installedPath, "package.json");
        if (statSync(path).size <= 64 * 1024) {
          const manifest: unknown = JSON.parse(readFileSync(path, "utf8"));
          if (manifest && typeof manifest === "object") {
            if ("name" in manifest && typeof manifest.name === "string") name = manifest.name;
            if ("version" in manifest && typeof manifest.version === "string") installedVersion = manifest.version;
          }
        }
      } catch {
        // A local skill or extension directory need not have a package manifest.
      }
    }
    if (!installed) diagnostics.push("Configured package path was not found.");
    const npmVersion = pkg.source.startsWith("npm:") ? pkg.source.slice(4).match(/.+@([^@/]+)$/u)?.[1] : undefined;
    return {
      source: pkg.source,
      scope: pkg.scope,
      baseDir: pkg.installedPath,
      configured: true,
      enabled: entry ? !packageDisabled(entry) : true,
      installed,
      ...(name ? { name } : {}),
      ...(installedVersion ? { installedVersion } : {}),
      ...(npmVersion ? { configuredVersion: npmVersion } : {}),
      diagnostics,
    };
  });
  return { packages, errors };
}
