import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PI_CODING_AGENT_PACKAGE = "@earendil-works/pi-coding-agent";
export const PI_CODING_AGENT_ENTRY_ENV = "OPENPI_PI_CODING_AGENT_ENTRY";
const PACKAGE_ROOT_SEARCH_DEPTH = 10;

type PackageManifest = {
  name?: unknown;
  main?: unknown;
  exports?: Record<string, { import?: unknown } | string>;
};

export function findPackageRoot(realPath: string, packageName: string) {
  let dir = dirname(realPath);
  for (let depth = 0; depth < PACKAGE_ROOT_SEARCH_DEPTH; depth++) {
    const manifestPath = join(dir, "package.json");
    if (existsSync(manifestPath)) {
      const manifest = readManifest(manifestPath);
      if (manifest?.name === packageName) return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

function readManifest(manifestPath: string) {
  try {
    return JSON.parse(readFileSync(manifestPath, "utf8")) as PackageManifest;
  } catch {
    return undefined;
  }
}

function officialEntry(root: string | undefined) {
  if (!root) return undefined;
  const manifest = readManifest(join(root, "package.json"));
  const target = manifest?.exports?.["."];
  const relative =
    typeof target === "string"
      ? target
      : typeof target?.import === "string"
        ? target.import
        : typeof manifest?.main === "string"
          ? manifest.main
          : "dist/index.js";
  const entry = join(root, relative);
  try {
    return existsSync(entry) && statSync(entry).isFile()
      ? realpathSync(entry)
      : undefined;
  } catch {
    return undefined;
  }
}

function walkFromFile(file: string) {
  try {
    const real = realpathSync(file);
    if (!statSync(real).isFile()) return undefined;
    return officialEntry(findPackageRoot(real, PI_CODING_AGENT_PACKAGE));
  } catch {
    return undefined;
  }
}

function fileFromUrl(fromUrl: string) {
  return fromUrl.startsWith("file:") ? fileURLToPath(fromUrl) : fromUrl;
}

function nearestPackageRoot(file: string) {
  let dir = dirname(file);
  for (let depth = 0; depth < PACKAGE_ROOT_SEARCH_DEPTH; depth++) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}

function peerAt(nodeModules: string) {
  const root = join(nodeModules, ...PI_CODING_AGENT_PACKAGE.split("/"));
  const manifest = readManifest(join(root, "package.json"));
  return manifest?.name === PI_CODING_AGENT_PACKAGE
    ? officialEntry(root)
    : undefined;
}

function resolveFromInstall(fromUrl: string) {
  let start = fileFromUrl(fromUrl);
  try {
    start = realpathSync(start);
  } catch {
    // Keep the unresolved path when the caller file is a test stub.
  }
  const packageRoot = nearestPackageRoot(start);
  if (!packageRoot) return undefined;

  const nested = peerAt(join(packageRoot, "node_modules"));
  if (nested) return nested;

  const parent = dirname(packageRoot);
  const grandparent = dirname(parent);
  const hoistedModules =
    basename(parent).startsWith("@") && basename(grandparent) === "node_modules"
      ? grandparent
      : basename(parent) === "node_modules"
        ? parent
        : undefined;
  return hoistedModules ? peerAt(hoistedModules) : undefined;
}

export function validatePiCodingAgentEntry(candidate: string | undefined) {
  if (!candidate) return undefined;
  return walkFromFile(candidate);
}

export function missingPiCodingAgentDiagnostic() {
  return [
    `OpenPI Web could not resolve ${PI_CODING_AGENT_PACKAGE} for this process.`,
    "Host resolution uses only the current process argv identity and fail-closes if that path is not the official package.",
    `${PI_CODING_AGENT_ENTRY_ENV} is an explicit standalone handoff, not a host fallback.`,
    `Standalone openpi web uses that handoff when valid, then the installed nested or hoisted peer (npm install ${PI_CODING_AGENT_PACKAGE}).`,
    "From a running Pi session use /web, which hands over the host Pi.",
    "Supported package install is `pi install npm:@tt-a1i/openpi`.",
  ].join(" ");
}

export function resolvePiCodingAgentEntry(options?: {
  source?: "host" | "standalone";
  env?: NodeJS.ProcessEnv;
  argv1?: string | undefined;
  fromUrl?: string;
}) {
  const source = options?.source ?? "host";
  if (source === "standalone") {
    const env = options?.env ?? process.env;
    const handed = validatePiCodingAgentEntry(env[PI_CODING_AGENT_ENTRY_ENV]);
    if (handed) return handed;
    return resolveFromInstall(options?.fromUrl ?? import.meta.url);
  }

  const argv1 = options?.argv1 === undefined ? process.argv[1] : options.argv1;
  return argv1 ? walkFromFile(argv1) : undefined;
}

export function resolveStandaloneJitiAliases(options?: {
  env?: NodeJS.ProcessEnv;
  argv1?: string | undefined;
  fromUrl?: string;
}) {
  const fromUrl = options?.fromUrl ?? import.meta.url;
  const entry = resolvePiCodingAgentEntry({
    ...options,
    fromUrl,
    source: "standalone",
  });
  return entry ? { [PI_CODING_AGENT_PACKAGE]: entry } : {};
}
