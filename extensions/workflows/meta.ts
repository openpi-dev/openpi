import {
  parse,
  type ArrayExpression,
  type ExportNamedDeclaration,
  type Expression,
  type Identifier,
  type Literal,
  type ObjectExpression,
  type Program,
  type Property,
  type VariableDeclaration,
} from "acorn";

/** Static workflow metadata and source preparation helpers. */

export interface WorkflowPhase {
  title: string;
  detail?: string;
}

export interface WorkflowMeta {
  name?: string;
  description?: string;
  phases: WorkflowPhase[];
}

export interface PreparedWorkflowScript {
  /** Script body with the metadata declaration removed. */
  source: string;
  meta: WorkflowMeta;
}

function parseProgram(source: string): Program {
  return parse(source, {
    ecmaVersion: "latest",
    sourceType: "module",
    allowReturnOutsideFunction: true,
  });
}

function isIdentifier(node: Expression, name?: string): node is Identifier {
  return (
    node.type === "Identifier" && (name === undefined || node.name === name)
  );
}

function isLiteral(node: Expression): node is Literal {
  return node.type === "Literal";
}

function isProperty(
  node: ObjectExpression["properties"][number],
): node is Property {
  return node.type === "Property";
}

function propertyName(property: Property) {
  if (property.computed || property.kind !== "init" || property.method) {
    return undefined;
  }
  if (isIdentifier(property.key)) return property.key.name;
  if (isLiteral(property.key) && typeof property.key.value === "string") {
    return property.key.value;
  }
  return undefined;
}

/**
 * Convert an Acorn expression to data without evaluating source. Only plain
 * object/array/primitive literals are accepted. Getters, methods, spreads,
 * computed keys, templates, identifiers, and calls all fail closed.
 */
function literalValue(node: Expression, depth = 0): unknown {
  if (depth > 8) throw new Error("workflow metadata is nested too deeply");
  if (isLiteral(node)) {
    if (
      node.value === null ||
      typeof node.value === "string" ||
      typeof node.value === "number" ||
      typeof node.value === "boolean"
    ) {
      return node.value;
    }
    throw new Error("workflow metadata contains an unsupported literal");
  }
  if (node.type === "ArrayExpression") {
    const arrayNode: ArrayExpression = node;
    return arrayNode.elements.map((element) => {
      if (!element || element.type === "SpreadElement") {
        throw new Error(
          "workflow metadata arrays cannot contain holes or spreads",
        );
      }
      return literalValue(element, depth + 1);
    });
  }
  if (node.type === "ObjectExpression") {
    const objectNode: ObjectExpression = node;
    const value: Record<string, unknown> = Object.create(null);
    for (const item of objectNode.properties) {
      if (!isProperty(item)) {
        throw new Error("workflow metadata objects cannot contain spreads");
      }
      const key = propertyName(item);
      if (key === undefined || item.shorthand) {
        throw new Error(
          "workflow metadata keys and values must be plain literals",
        );
      }
      value[key] = literalValue(item.value, depth + 1);
    }
    return value;
  }
  throw new Error("workflow metadata must contain only static literals");
}

function sanitizeMeta(value: unknown): WorkflowMeta {
  const meta: WorkflowMeta = { phases: [] };
  if (!value || typeof value !== "object") return meta;
  const raw = value as {
    name?: unknown;
    description?: unknown;
    phases?: unknown;
  };
  if (typeof raw.name === "string") meta.name = raw.name.slice(0, 160);
  if (typeof raw.description === "string") {
    meta.description = raw.description.slice(0, 2_000);
  }
  if (Array.isArray(raw.phases)) {
    for (const item of raw.phases.slice(0, 64)) {
      if (!item || typeof item !== "object") continue;
      const phase = item as { title?: unknown; detail?: unknown };
      if (typeof phase.title !== "string" || !phase.title.trim()) continue;
      meta.phases.push({
        title: phase.title.slice(0, 160),
        ...(typeof phase.detail === "string"
          ? { detail: phase.detail.slice(0, 2_000) }
          : {}),
      });
    }
  }
  return meta;
}

function metadataDeclaration(statement: Program["body"][number]) {
  if (statement.type !== "ExportNamedDeclaration") return undefined;
  const exported: ExportNamedDeclaration = statement;
  if (
    exported.source ||
    exported.specifiers.length > 0 ||
    exported.declaration?.type !== "VariableDeclaration"
  ) {
    throw new Error(
      "workflow scripts may only export a static `const meta = {...}` declaration",
    );
  }
  const declaration: VariableDeclaration = exported.declaration;
  if (declaration.kind !== "const" || declaration.declarations.length !== 1) {
    throw new Error(
      "workflow metadata must be declared as `export const meta = {...}`",
    );
  }
  const declarator = declaration.declarations[0];
  if (
    declarator.id.type !== "Identifier" ||
    declarator.id.name !== "meta" ||
    !declarator.init
  ) {
    throw new Error("workflow scripts may only export a `meta` declaration");
  }
  return { exported, initializer: declarator.init };
}

/**
 * Parse a workflow as JavaScript, reject module syntax other than the metadata
 * API, statically decode metadata, and remove that declaration from the body.
 * Source inside strings, comments, regexes, and templates is never rewritten.
 */
export function prepareWorkflowScript(source: string): PreparedWorkflowScript {
  const program = parseProgram(source);
  let meta: WorkflowMeta = { phases: [] };
  let metadataRange: { start: number; end: number } | undefined;

  for (const statement of program.body) {
    if (statement.type === "ImportDeclaration") {
      throw new Error("workflow scripts cannot use static imports");
    }
    if (
      statement.type === "ExportDefaultDeclaration" ||
      statement.type === "ExportAllDeclaration"
    ) {
      throw new Error(
        "workflow scripts may only export a static `const meta = {...}` declaration",
      );
    }
    const declaration = metadataDeclaration(statement);
    if (!declaration) continue;
    if (metadataRange)
      throw new Error("workflow metadata may only be declared once");
    meta = sanitizeMeta(literalValue(declaration.initializer));
    metadataRange = {
      start: declaration.exported.start,
      end: declaration.exported.end,
    };
  }

  if (!metadataRange) return { source, meta };
  // Preserve line numbers for parse/runtime errors while removing every byte of
  // executable metadata. A semicolon keeps adjacent statements separated.
  const removed = source.slice(metadataRange.start, metadataRange.end);
  const replacement = `;${removed.slice(1).replace(/[^\n\r]/g, " ")}`;
  return {
    source:
      source.slice(0, metadataRange.start) +
      replacement +
      source.slice(metadataRange.end),
    meta,
  };
}

const metaCache = new Map<string, WorkflowMeta>();
const META_CACHE_LIMIT = 32;

/** Safe metadata extraction for render paths. Invalid/partial scripts are empty. */
export function extractMeta(script: string): WorkflowMeta {
  const cached = metaCache.get(script);
  if (cached) return cached;
  let meta: WorkflowMeta = { phases: [] };
  try {
    meta = prepareWorkflowScript(script).meta;
  } catch {
    // Renderers must tolerate partial model output and invalid scripts.
  }
  if (metaCache.size >= META_CACHE_LIMIT) metaCache.clear();
  metaCache.set(script, meta);
  return meta;
}
