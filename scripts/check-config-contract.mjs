import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseExpressionAt } from "acorn";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const CONFIG_FIELD_CONTRACT = [
  {
    path: "capabilities.discovery",
    writerTokens: ["params.capability_discovery"],
    statusTokens: ["config.capabilities.discovery"],
    readmeTerms: ["Capability discovery"],
    setupTerms: ["Capability discovery"],
  },
  {
    path: "suggestions.enabled",
    writerTokens: ["enabled: suggestionsEnabled"],
    statusTokens: ["config.suggestions.enabled"],
    readmeTerms: ["Next-action Suggestion"],
    setupTerms: ["Next-action suggestions"],
  },
  {
    path: "suggestions.model",
    optional: true,
    configTokens: ["readonly model?: SuggestionModelConfig"],
    writerTokens: ["...(model ? { model } : {})"],
    statusTokens: ["config.suggestions.model"],
    readmeTerms: ["Registry 模型"],
    setupTerms: ["available model"],
  },
  {
    path: "workflows.concurrency",
    writerTokens: ["params.workflow_concurrency"],
    statusTokens: ["config.workflows.concurrency"],
    readmeTerms: ["Workflow 并发"],
    setupTerms: ["Workflows default"],
  },
  {
    path: "workflows.maxAgentCalls",
    writerTokens: ["params.workflow_max_agent_calls"],
    statusTokens: ["config.workflows.maxAgentCalls"],
    readmeTerms: ["总调用"],
    setupTerms: ["total agent calls"],
  },
  {
    path: "ui.showHeader",
    writerTokens: ["params.ui_show_header"],
    statusTokens: ["config.ui.showHeader"],
    readmeTerms: ["大型 Header"],
    setupTerms: ["large decorative header"],
  },
  {
    path: "ui.customFooter",
    writerTokens: ["params.ui_custom_footer"],
    statusTokens: ["config.ui.customFooter"],
    readmeTerms: ["Dashboard Footer"],
    setupTerms: ["custom dashboard footer"],
  },
  {
    path: "ui.footerStyle",
    writerTokens: ["params.ui_footer_style !== undefined", "...footer,"],
    statusTokens: ["config.ui.footerStyle"],
    readmeTerms: ["powerline"],
    setupTerms: ["powerline"],
  },
  {
    path: "ui.footerLines",
    writerTokens: ["params.ui_footer_lines !== undefined", "...footer,"],
    statusTokens: ["config.ui.footerLines"],
    readmeTerms: ["footerLines"],
    setupTerms: ["footerLines"],
  },
  {
    path: "ui.subagentResultDisplay",
    writerTokens: ["params.subagent_result_display"],
    statusTokens: ["config.ui.subagentResultDisplay"],
    readmeTerms: ["Subagent / Bash / Write/Edit"],
    setupTerms: ["Subagent results default"],
  },
  {
    path: "ui.bashToolDisplay",
    writerTokens: ["params.bash_tool_display"],
    statusTokens: ["config.ui.bashToolDisplay"],
    readmeTerms: ["Subagent / Bash / Write/Edit"],
    setupTerms: ["Bash and Write/Edit default"],
  },
  {
    path: "ui.fileMutationDisplay",
    writerTokens: ["params.file_mutation_display"],
    statusTokens: ["config.ui.fileMutationDisplay"],
    readmeTerms: ["Subagent / Bash / Write/Edit"],
    setupTerms: ["Write/Edit default"],
  },
  {
    path: "postEdit.command",
    writerTokens: ["params.post_edit_command"],
    statusTokens: ["config.postEdit.command"],
    readmeTerms: ["Post-edit 命令"],
    setupTerms: ["post-edit command"],
  },
  {
    path: "subagents.roleModels",
    writerTokens: ["params.subagent_role_models"],
    statusTokens: ["config.subagents.roleModels"],
    readmeTerms: ["内置角色模型"],
    setupTerms: ["Built-in Agent roles"],
  },
];

const CONFIG_MARKER_PATTERN = /<!--\s*config-contract:\s*([\s\S]*?)-->/gi;
const CONFIG_PATH_PATTERN =
  /\b[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*\b/g;

function staticPropertyName(property) {
  if (property.key.type === "Identifier") return property.key.name;
  if (
    property.key.type === "Literal" &&
    typeof property.key.value === "string"
  ) {
    return property.key.value;
  }
  return undefined;
}

function collectLeafPaths(node, prefix, paths) {
  for (const property of node.properties) {
    if (property.type !== "Property" || property.computed) {
      throw new Error("DEFAULT_SETUP_CONFIG contains a non-static property");
    }
    const name = staticPropertyName(property);
    if (!name)
      throw new Error("DEFAULT_SETUP_CONFIG contains an unnamed property");
    const path = prefix ? `${prefix}.${name}` : name;
    if (
      property.value.type === "ObjectExpression" &&
      property.value.properties.length > 0
    ) {
      collectLeafPaths(property.value, path, paths);
    } else {
      paths.push(path);
    }
  }
}

export function extractDefaultFieldPaths(source) {
  const declaration = source.indexOf("DEFAULT_SETUP_CONFIG");
  if (declaration < 0) throw new Error("DEFAULT_SETUP_CONFIG was not found");
  const equals = source.indexOf("=", declaration);
  const objectStart = source.indexOf("{", equals);
  if (equals < 0 || objectStart < 0) {
    throw new Error("DEFAULT_SETUP_CONFIG object was not found");
  }
  const expression = parseExpressionAt(source, objectStart, {
    ecmaVersion: "latest",
  });
  if (expression.type !== "ObjectExpression") {
    throw new Error("DEFAULT_SETUP_CONFIG is not an object");
  }
  const paths = [];
  collectLeafPaths(expression, "", paths);
  return paths.sort();
}

export function extractOptionalConfigPaths(source) {
  const declaration = source.indexOf("interface MyPiSetupConfig");
  if (declaration < 0) return [];
  const objectStart = source.indexOf("{", declaration);
  const objectEnd = source.indexOf(
    "export const DEFAULT_SETUP_CONFIG",
    objectStart,
  );
  if (objectStart < 0 || objectEnd < 0) return [];

  // ponytail: this small parser avoids making the contract check depend on a TypeScript compiler.
  const paths = [];
  const parents = [];
  for (const line of source.slice(objectStart + 1, objectEnd).split(/\r?\n/)) {
    const property =
      /^\s*readonly\s+([A-Za-z][A-Za-z0-9_]*)\s*(\?)?\s*:\s*(.*)$/.exec(line);
    if (property) {
      const path = [...parents, property[1]].join(".");
      if (property[2]) paths.push(path);
      if (property[3].trim().startsWith("{")) parents.push(property[1]);
    }
    if (/^\s*}\s*[,;]?\s*$/.test(line)) parents.pop();
  }
  return [...new Set(paths)].sort();
}

function containsAny(source, terms) {
  const normalized = source.toLowerCase();
  return terms.some((term) => normalized.includes(term.toLowerCase()));
}

function sourceSection(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  if (start < 0) return source;
  const end = source.indexOf(endMarker, start + startMarker.length);
  return source.slice(start, end < 0 ? source.length : end);
}

function requiredSourceSection(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  if (start < 0) return "";
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (end < 0) return "";
  return source.slice(start, end);
}

function containsAll(source, terms) {
  const normalized = source.toLowerCase();
  return terms.every((term) => normalized.includes(term.toLowerCase()));
}

function extractConfigMarkers(source) {
  const paths = [];
  for (const match of source.matchAll(CONFIG_MARKER_PATTERN)) {
    for (const path of match[1].matchAll(CONFIG_PATH_PATTERN)) {
      paths.push(path[0]);
    }
  }
  return [...new Set(paths)];
}

export function checkConfigContract({
  configSource,
  setupSource,
  statusSource,
  readme,
  setupDoc,
  contract = CONFIG_FIELD_CONTRACT,
}) {
  const fields = extractDefaultFieldPaths(configSource);
  const declaredOptionalFields = extractOptionalConfigPaths(configSource);
  const optionalFields = contract
    .filter((entry) => entry.optional)
    .map((entry) => entry.path);
  const allFields = [...new Set([...fields, ...optionalFields])];
  const fieldSet = new Set(fields);
  const entries = new Map(contract.map((entry) => [entry.path, entry]));
  const statusSection = sourceSection(
    statusSource,
    "export function formatSetupConfig",
    "export {",
  );
  // Keep writer checks inside the read-modify-write builder. A parameter name
  // in the tool schema is not evidence that the value reaches the saved
  // MyPiSetupConfig object.
  const writerSection = requiredSourceSection(
    setupSource,
    "const buildConfig = (current: MyPiSetupConfig) => {",
    "return config;",
  );
  const problems = [];

  for (const field of fields) {
    if (!entries.has(field)) {
      problems.push(`${field} is not registered in the contract table`);
    }
  }
  for (const field of declaredOptionalFields) {
    if (!entries.has(field)) {
      problems.push(
        `${field} optional field is not registered in the contract table`,
      );
    }
  }
  for (const entry of contract) {
    if (!fieldSet.has(entry.path) && !entry.optional) {
      problems.push(
        `${entry.path} is registered but absent from DEFAULT_SETUP_CONFIG`,
      );
      continue;
    }
    if (
      entry.optional &&
      !containsAny(configSource, entry.configTokens ?? [])
    ) {
      problems.push(`${entry.path} is missing from the config type`);
    }
    if (!containsAll(writerSection, entry.writerTokens)) {
      problems.push(`${entry.path} is missing from extensions/setup/`);
    }
    if (!containsAny(statusSection, entry.statusTokens)) {
      problems.push(`${entry.path} is missing from the status formatter`);
    }
    if (!containsAny(readme, entry.readmeTerms)) {
      problems.push(`${entry.path} is missing from README.md`);
    }
    if (!containsAny(setupDoc, entry.setupTerms)) {
      problems.push(`${entry.path} is missing from SETUP.md`);
    }
  }

  const expectedPaths = new Set(contract.map((entry) => entry.path));
  for (const [name, source] of [
    ["README.md", readme],
    ["SETUP.md", setupDoc],
  ]) {
    const markers = extractConfigMarkers(source);
    for (const path of allFields) {
      if (!markers.includes(path)) {
        problems.push(`${name} is missing config-contract marker ${path}`);
      }
    }
    for (const path of markers) {
      if (!expectedPaths.has(path)) {
        problems.push(`${name} references unknown config field ${path}`);
      }
    }
  }

  return { fields: allFields, problems };
}

export function assertConfigContract(input) {
  const result = checkConfigContract(input);
  if (result.problems.length > 0) {
    throw new Error(
      [
        "Configuration contract check failed:",
        ...result.problems.map((problem) => `- ${problem}`),
      ].join("\n"),
    );
  }
  return result;
}

function readRepositoryFiles() {
  const read = (path) => readFileSync(resolve(ROOT, path), "utf8");
  return {
    configSource: read("extensions/shared/setup-config.ts"),
    setupSource: read("extensions/setup/index.ts"),
    statusSource: read("extensions/shared/setup-config.ts"),
    readme: read("README.md"),
    setupDoc: read("SETUP.md"),
  };
}

function runFixtureTests() {
  const fixtureContract = [
    {
      path: "alpha",
      writerTokens: ["alpha"],
      statusTokens: ["config.alpha"],
      readmeTerms: ["Alpha"],
      setupTerms: ["Alpha"],
    },
    {
      path: "nested.beta",
      writerTokens: ["beta"],
      statusTokens: ["config.nested.beta"],
      readmeTerms: ["Beta"],
      setupTerms: ["Beta"],
    },
    {
      path: "optional",
      optional: true,
      configTokens: ["readonly optional?: OptionalConfig"],
      writerTokens: ["optional"],
      statusTokens: ["config.optional"],
      readmeTerms: ["Optional"],
      setupTerms: ["Optional"],
    },
    {
      path: "empty",
      writerTokens: ["empty"],
      statusTokens: ["config.empty"],
      readmeTerms: ["Empty"],
      setupTerms: ["Empty"],
    },
  ];
  const configSource =
    "interface Example { readonly optional?: OptionalConfig; }\nexport const DEFAULT_SETUP_CONFIG = { alpha: true, nested: { beta: false }, empty: {} };";
  const setupSource = `const buildConfig = (current: MyPiSetupConfig) => {
  alpha beta empty optional
  return config;
};`;
  const base = {
    configSource,
    setupSource,
    statusSource:
      "config.alpha config.nested.beta config.empty config.optional",
    readme:
      "Alpha Beta Empty Optional <!-- config-contract: alpha nested.beta empty optional -->",
    setupDoc:
      "Alpha Beta Empty Optional <!-- config-contract: alpha nested.beta empty optional -->",
    contract: fixtureContract,
  };

  assert.deepEqual(
    extractDefaultFieldPaths(
      "export const DEFAULT_SETUP_CONFIG = { alpha: 1 };",
    ),
    ["alpha"],
  );
  assert.deepEqual(
    extractDefaultFieldPaths(
      "export const DEFAULT_SETUP_CONFIG = { nested: { beta: false, gamma: [] } };",
    ),
    ["nested.beta", "nested.gamma"],
  );
  assert.deepEqual(
    extractDefaultFieldPaths(
      "export const DEFAULT_SETUP_CONFIG = { empty: {} };",
    ),
    ["empty"],
  );
  assert.doesNotThrow(() => assertConfigContract(base));
  const optionalDriftSource = base.configSource.replace(
    "interface Example { readonly optional?: OptionalConfig; }",
    "export interface MyPiSetupConfig {\n  readonly optional?: OptionalConfig;\n  readonly hidden?: HiddenConfig;\n}",
  );
  const optionalDrift = checkConfigContract({
    ...base,
    configSource: `${optionalDriftSource}\nexport const DEFAULT_SETUP_CONFIG = { alpha: true, nested: { beta: false }, empty: {} };`,
  });
  assert.match(
    optionalDrift.problems.join("\n"),
    /hidden optional field is not registered/,
  );
  assert.throws(
    () =>
      assertConfigContract({
        ...base,
        readme: base.readme.replace("Beta", "").replace("nested.beta", ""),
      }),
    /README\.md/,
  );
  assert.throws(
    () => assertConfigContract({ ...base, setupSource: "alpha beta" }),
    /extensions\/setup/,
  );
  assert.throws(
    () =>
      assertConfigContract({
        ...base,
        setupSource: `${setupSource.replace("beta", "")}\nparams.nested_beta`,
      }),
    /extensions\/setup/,
  );
  assert.throws(
    () =>
      assertConfigContract({
        ...base,
        setupDoc: base.setupDoc.replace("Beta", "").replace("nested.beta", ""),
      }),
    /SETUP\.md/,
  );
  assert.throws(
    () =>
      assertConfigContract({
        ...base,
        configSource: base.configSource.replace(
          "empty: {}",
          "empty: {}, extra: true",
        ),
      }),
    /not registered in the contract table/,
  );
  assert.throws(
    () => assertConfigContract({ ...base, readme: "" }),
    /README\.md/,
  );
  assert.throws(
    () =>
      assertConfigContract({
        ...base,
        configSource: base.configSource.replace(
          "readonly optional?: OptionalConfig",
          "",
        ),
      }),
    /config type/,
  );
  assert.throws(
    () =>
      assertConfigContract({
        ...base,
        setupDoc: `${base.setupDoc} <!-- config-contract: unknown.setting -->`,
      }),
    /unknown config field/,
  );
  process.stdout.write("✓ config contract fixture tests (13)\n");
}

if (process.argv.includes("--self-test")) {
  runFixtureTests();
} else {
  const result = assertConfigContract(readRepositoryFiles());
  process.stdout.write(
    `✓ config contract (${result.fields.length} persisted fields)\n`,
  );
}
