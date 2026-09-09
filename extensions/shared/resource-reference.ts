import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";

export const OPENPI_RESOURCE_REF_VERSION = 1 as const;

export type OpenPiResourceOwner = "subagent" | "workflow" | "background";
export type OpenPiResourceCompleteness =
  | "complete-owner-value"
  | "partial-owner-value";
export type OpenPiResourceLifetime =
  | "session-cache"
  | "workflow-run"
  | "session-temporary";

/** Metadata only: possession never grants read authority or extends lifetime. */
export interface OpenPiResourceRef {
  readonly version: typeof OPENPI_RESOURCE_REF_VERSION;
  readonly owner: {
    readonly kind: OpenPiResourceOwner;
    readonly id: string;
    readonly generation: string;
  };
  readonly resource: {
    readonly id: string;
    readonly revision: string;
    readonly path: string;
    readonly mediaType: string;
    readonly byteLength: number;
    readonly completeness: OpenPiResourceCompleteness;
    readonly sourceCoverage: string;
  };
  readonly lifetime: OpenPiResourceLifetime;
}

export type OpenPiResourceFailure =
  | "invalid-reference"
  | "owner-mismatch"
  | "stale-generation"
  | "owner-lost"
  | "unauthorized"
  | "unsafe-path"
  | "symlink-substitution"
  | "missing"
  | "stale-resource";

export type OpenPiResourceResolution =
  | { readonly ok: true; readonly path: string }
  | {
      readonly ok: false;
      readonly failure: OpenPiResourceFailure;
      readonly message: string;
    };

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const MAX_PATH_BYTES = 16 * 1024;

function safeIdentity(value: string) {
  return ID_PATTERN.test(value);
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function isOpenPiResourceRef(
  value: unknown,
): value is OpenPiResourceRef {
  if (!record(value) || !record(value.owner) || !record(value.resource)) {
    return false;
  }
  return (
    value.version === OPENPI_RESOURCE_REF_VERSION &&
    (value.owner.kind === "subagent" ||
      value.owner.kind === "workflow" ||
      value.owner.kind === "background") &&
    typeof value.owner.id === "string" &&
    safeIdentity(value.owner.id) &&
    typeof value.owner.generation === "string" &&
    safeIdentity(value.owner.generation) &&
    typeof value.resource.id === "string" &&
    safeIdentity(value.resource.id) &&
    typeof value.resource.revision === "string" &&
    /^[a-f0-9]{64}$/u.test(value.resource.revision) &&
    typeof value.resource.path === "string" &&
    Buffer.byteLength(value.resource.path, "utf8") <= MAX_PATH_BYTES &&
    typeof value.resource.mediaType === "string" &&
    Buffer.byteLength(value.resource.mediaType, "utf8") <= 256 &&
    typeof value.resource.byteLength === "number" &&
    Number.isSafeInteger(value.resource.byteLength) &&
    value.resource.byteLength >= 0 &&
    (value.resource.completeness === "complete-owner-value" ||
      value.resource.completeness === "partial-owner-value") &&
    typeof value.resource.sourceCoverage === "string" &&
    Buffer.byteLength(value.resource.sourceCoverage, "utf8") <= 256 &&
    (value.lifetime === "session-cache" ||
      value.lifetime === "workflow-run" ||
      value.lifetime === "session-temporary")
  );
}

function containedPath(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return (
    relative.length > 0 &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function inspectOwnedFile(
  rootValue: string,
  fileValue: string,
  allowMissingFile = false,
) {
  const root = path.resolve(rootValue);
  const file = path.resolve(fileValue);
  if (
    Buffer.byteLength(root, "utf8") > MAX_PATH_BYTES ||
    Buffer.byteLength(file, "utf8") > MAX_PATH_BYTES ||
    !containedPath(root, file)
  ) {
    return { ok: false as const, failure: "unsafe-path" as const };
  }

  try {
    const rootStat = lstatSync(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      return {
        ok: false as const,
        failure: "symlink-substitution" as const,
      };
    }
    const relative = path.relative(root, file);
    let cursor = root;
    for (const segment of relative.split(path.sep)) {
      cursor = path.join(cursor, segment);
      const stat = lstatSync(cursor);
      if (stat.isSymbolicLink()) {
        return {
          ok: false as const,
          failure: "symlink-substitution" as const,
        };
      }
      if (cursor !== file && !stat.isDirectory()) {
        return { ok: false as const, failure: "unsafe-path" as const };
      }
      if (cursor === file && !stat.isFile()) {
        return { ok: false as const, failure: "unsafe-path" as const };
      }
    }
    return { ok: true as const, root, file, stat: lstatSync(file) };
  } catch (error) {
    if (
      allowMissingFile &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      try {
        const parent = path.dirname(file);
        const parentStat = lstatSync(parent);
        if (parentStat.isDirectory() && !parentStat.isSymbolicLink()) {
          return { ok: true as const, root, file, stat: undefined };
        }
      } catch {
        // Fall through to the ordinary missing/unsafe result.
      }
    }
    return {
      ok: false as const,
      failure:
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? ("missing" as const)
          : ("unsafe-path" as const),
    };
  }
}

function resourceRevisionFile(file: string) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function resourceRevisionContent(content: string) {
  return createHash("sha256").update(content).digest("hex");
}

export function createOwnerFileResourceRef(options: {
  readonly owner: OpenPiResourceRef["owner"];
  readonly resourceId: string;
  readonly root: string;
  readonly file: string;
  readonly mediaType: string;
  readonly completeness: OpenPiResourceCompleteness;
  readonly sourceCoverage: string;
  readonly lifetime: OpenPiResourceLifetime;
  readonly expectedByteLength?: number;
  /**
   * Content that is about to be written atomically. This lets a producer
   * publish an exact reference before the target file exists while retaining
   * the same owner-root and path checks as an already-written file.
   */
  readonly content?: string;
}) {
  if (
    !safeIdentity(options.owner.id) ||
    !safeIdentity(options.owner.generation) ||
    !safeIdentity(options.resourceId) ||
    !options.mediaType ||
    Buffer.byteLength(options.mediaType, "utf8") > 256 ||
    !options.sourceCoverage ||
    Buffer.byteLength(options.sourceCoverage, "utf8") > 256
  ) {
    throw new Error("Invalid owner-bound resource identity");
  }
  const inspected = inspectOwnedFile(
    options.root,
    options.file,
    options.content !== undefined,
  );
  if (!inspected.ok) {
    throw new Error(`Cannot publish resource reference: ${inspected.failure}`);
  }
  const byteLength =
    options.content !== undefined
      ? Buffer.byteLength(options.content)
      : inspected.stat?.size;
  if (byteLength === undefined) {
    throw new Error("Cannot publish resource reference: missing");
  }
  if (
    options.expectedByteLength !== undefined &&
    byteLength !== options.expectedByteLength
  ) {
    throw new Error("Cannot publish resource reference: stale-resource");
  }
  const revision =
    options.content !== undefined
      ? resourceRevisionContent(options.content)
      : resourceRevisionFile(inspected.file);
  return {
    version: OPENPI_RESOURCE_REF_VERSION,
    owner: { ...options.owner },
    resource: {
      id: options.resourceId,
      revision,
      path: inspected.file,
      mediaType: options.mediaType,
      byteLength,
      completeness: options.completeness,
      sourceCoverage: options.sourceCoverage,
    },
    lifetime: options.lifetime,
  } satisfies OpenPiResourceRef;
}

/** Resolve through the owning extension's root and authority decision only. */
export function resolveOwnerFileResourceRef(
  value: unknown,
  options: {
    readonly owner: OpenPiResourceRef["owner"];
    readonly root: string;
    readonly ownerAlive: boolean;
    readonly authorized: boolean;
  },
): OpenPiResourceResolution {
  if (!isOpenPiResourceRef(value)) {
    return {
      ok: false,
      failure: "invalid-reference",
      message: "Resource reference shape is invalid",
    };
  }
  const ref = value;
  if (
    ref.owner.kind !== options.owner.kind ||
    ref.owner.id !== options.owner.id
  ) {
    return {
      ok: false,
      failure: "owner-mismatch",
      message: "Resource reference belongs to another owner",
    };
  }
  if (ref.owner.generation !== options.owner.generation) {
    return {
      ok: false,
      failure: "stale-generation",
      message: "Resource reference belongs to a stale owner generation",
    };
  }
  if (!options.ownerAlive) {
    return {
      ok: false,
      failure: "owner-lost",
      message: "Resource owner is no longer live",
    };
  }
  if (!options.authorized) {
    return {
      ok: false,
      failure: "unauthorized",
      message: "Current Pi trust/tool boundary does not authorize this read",
    };
  }
  const inspected = inspectOwnedFile(options.root, ref.resource.path);
  if (!inspected.ok) {
    return {
      ok: false,
      failure: inspected.failure,
      message: `Resource cannot be resolved: ${inspected.failure}`,
    };
  }
  if (!inspected.stat) {
    return {
      ok: false,
      failure: "missing",
      message: "Resource cannot be resolved: missing",
    };
  }
  if (inspected.stat.size !== ref.resource.byteLength) {
    return {
      ok: false,
      failure: "stale-resource",
      message: "Resource bytes no longer match the published reference",
    };
  }
  const revision = resourceRevisionFile(inspected.file);
  if (revision !== ref.resource.revision) {
    return {
      ok: false,
      failure: "stale-resource",
      message: "Resource revision no longer matches the published reference",
    };
  }
  return { ok: true, path: inspected.file };
}
