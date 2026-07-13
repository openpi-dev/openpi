/**
 * Workflow script parsing helpers: strip `export` keywords so a script can run
 * as a plain async function body, and extract the `export const meta = {...}`
 * object for the progress UI without executing the rest of the script.
 */

export interface WorkflowPhase {
  title: string;
  detail?: string;
}

export interface WorkflowMeta {
  name?: string;
  description?: string;
  phases: WorkflowPhase[];
}

/**
 * Strip top-level `export` syntax so the script body can run inside an
 * AsyncFunction. `export const meta = {...}` becomes a plain `const meta`.
 */
export function stripExports(source: string): string {
  return source
    .replace(/^\s*export\s+\*[^\n;]*;?\s*$/gm, "")
    .replace(/^\s*export\s+\{[^}]*\}[^\n;]*;?\s*$/gm, "")
    .replace(/^(\s*)export\s+default\s+/gm, "$1")
    .replace(
      /^(\s*)export\s+(?=(?:const|let|var|function|async|class)\b)/gm,
      "$1",
    );
}

/** Skip a string literal starting at `index` (must point at the quote). */
function skipString(source: string, index: number): number {
  const quote = source[index];
  let i = index + 1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === quote) return i + 1;
    if (quote === "`" && ch === "$" && source[i + 1] === "{") {
      i = skipBraces(source, i + 1);
      continue;
    }
    i++;
  }
  return i;
}

/**
 * Skip a brace-balanced region starting at `index` (must point at `{`),
 * ignoring braces inside strings, template literals, and comments. Returns the
 * index just past the matching `}`, or `source.length` if unbalanced.
 */
function skipBraces(source: string, index: number): number {
  let depth = 0;
  let i = index;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipString(source, i);
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      const newline = source.indexOf("\n", i);
      if (newline === -1) return source.length;
      i = newline;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      if (end === -1) return source.length;
      i = end + 2;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return source.length;
}

function findMetaObjectSource(script: string): string | undefined {
  const marker = /export\s+const\s+meta\s*=\s*/.exec(script);
  if (!marker) return undefined;
  const start = marker.index + marker[0].length;
  if (script[start] !== "{") return undefined;
  const end = skipBraces(script, start);
  if (end >= script.length && script[script.length - 1] !== "}")
    return undefined;
  return script.slice(start, end);
}

function sanitizeMeta(value: unknown): WorkflowMeta {
  const meta: WorkflowMeta = { phases: [] };
  if (!value || typeof value !== "object") return meta;
  const raw = value as {
    name?: unknown;
    description?: unknown;
    phases?: unknown;
  };
  if (typeof raw.name === "string") meta.name = raw.name;
  if (typeof raw.description === "string") meta.description = raw.description;
  if (Array.isArray(raw.phases)) {
    for (const item of raw.phases) {
      if (!item || typeof item !== "object") continue;
      const phase = item as { title?: unknown; detail?: unknown };
      if (typeof phase.title !== "string") continue;
      meta.phases.push({
        title: phase.title,
        ...(typeof phase.detail === "string" ? { detail: phase.detail } : {}),
      });
    }
  }
  return meta;
}

const metaCache = new Map<string, WorkflowMeta>();
const META_CACHE_LIMIT = 32;

/**
 * Extract and sanitize the script's meta object. Safe on partial/invalid
 * scripts (returns empty meta). Results are cached per script string because
 * this runs from TUI render paths.
 */
export function extractMeta(script: string): WorkflowMeta {
  const cached = metaCache.get(script);
  if (cached) return cached;

  let meta: WorkflowMeta = { phases: [] };
  const objectSource = findMetaObjectSource(script);
  if (objectSource) {
    try {
      meta = sanitizeMeta(new Function(`return (${objectSource});`)());
    } catch {
      // Partial or non-literal meta: fall back to empty meta.
    }
  }

  if (metaCache.size >= META_CACHE_LIMIT) metaCache.clear();
  metaCache.set(script, meta);
  return meta;
}
