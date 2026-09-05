import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import {
  missingPiCodingAgentDiagnostic,
  PI_CODING_AGENT_ENTRY_ENV,
  PI_CODING_AGENT_PACKAGE,
  resolvePiCodingAgentEntry,
  resolveStandaloneJitiAliases,
  validatePiCodingAgentEntry,
} from "../../web/host/pi-coding-agent-entry.ts";

const OFFICIAL_0_84_1_EXPORTS = {
  ".": {
    types: "./dist/index.d.ts",
    import: "./dist/index.js",
  },
  "./rpc-entry": { import: "./dist/rpc-entry.js" },
  "./client": {
    types: "./dist/client/index.d.ts",
    import: "./dist/client/index.js",
  },
} as const;

const HOST_0_85_EXPORTS = {
  ...OFFICIAL_0_84_1_EXPORTS,
  "./unix": { import: "./dist/unix.js" },
} as const;

function officialPackageEntryTail(path: string) {
  return path.split(/[\\/]/u).slice(-4).join("/");
}

async function writePiPackage(
  root: string,
  options: {
    marker: string;
    exports?: Record<string, unknown>;
  },
) {
  await mkdir(join(root, "dist"), { recursive: true });
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: PI_CODING_AGENT_PACKAGE,
      type: "module",
      exports: options.exports ?? OFFICIAL_0_84_1_EXPORTS,
    }),
  );
  const entry = join(root, "dist", "index.js");
  await writeFile(
    entry,
    `export const PI_ENTRY_STUB = ${JSON.stringify(options.marker)};\n`,
  );
  await writeFile(join(root, "dist", "cli.js"), "#!/usr/bin/env node\n");
  return { root, entry, cli: join(root, "dist", "cli.js") };
}

async function isolatedLayout() {
  const root = await mkdtemp(join(tmpdir(), "openpi-pi-entry-"));
  const caller = join(root, "unrelated", "caller.js");
  await mkdir(join(root, "unrelated"), { recursive: true });
  await writeFile(caller, "");
  const host = await writePiPackage(join(root, "host-pi"), {
    marker: "host-0.85",
    exports: HOST_0_85_EXPORTS,
  });
  const peerRoot = join(
    root,
    "openpi",
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
  );
  const peer = await writePiPackage(peerRoot, {
    marker: "local-0.84.1",
    exports: OFFICIAL_0_84_1_EXPORTS,
  });
  const openpiFile = join(root, "openpi", "bin", "openpi.js");
  await mkdir(join(root, "openpi", "bin"), { recursive: true });
  await writeFile(
    join(root, "openpi", "package.json"),
    JSON.stringify({ name: "@tt-a1i/openpi", type: "module" }),
  );
  await writeFile(openpiFile, "");
  return {
    root,
    caller,
    fromUrl: pathToFileURL(openpiFile).href,
    isolatedFromUrl: pathToFileURL(caller).href,
    host,
    peer,
    openpiFile,
  };
}

test("validated handoff must be the official package entry, not any existing file", async () => {
  const layout = await isolatedLayout();
  const junk = join(layout.root, "random.js");
  try {
    await writeFile(junk, "export {}\n");
    assert.equal(validatePiCodingAgentEntry(junk), undefined);
    assert.equal(
      resolvePiCodingAgentEntry({
        source: "host",
        env: { [PI_CODING_AGENT_ENTRY_ENV]: junk },
        argv1: layout.host.cli,
        fromUrl: layout.fromUrl,
      }),
      realpathSync(layout.host.entry),
    );
    assert.equal(
      resolvePiCodingAgentEntry({
        source: "standalone",
        env: { [PI_CODING_AGENT_ENTRY_ENV]: junk },
        argv1: layout.host.cli,
        fromUrl: layout.fromUrl,
      }),
      realpathSync(layout.peer.entry),
    );
  } finally {
    await rm(layout.root, { recursive: true, force: true });
  }
});

test("host uses argv Pi B even when env hands a valid Pi A", async () => {
  const layout = await isolatedLayout();
  try {
    assert.equal(
      resolvePiCodingAgentEntry({
        source: "host",
        env: { [PI_CODING_AGENT_ENTRY_ENV]: layout.host.cli },
        argv1: layout.peer.cli,
        fromUrl: layout.fromUrl,
      }),
      realpathSync(layout.peer.entry),
    );
  } finally {
    await rm(layout.root, { recursive: true, force: true });
  }
});

test("standalone uses a validated explicit handoff before its own peer", async () => {
  const layout = await isolatedLayout();
  try {
    assert.equal(
      resolvePiCodingAgentEntry({
        source: "standalone",
        env: { [PI_CODING_AGENT_ENTRY_ENV]: layout.host.cli },
        argv1: layout.peer.cli,
        fromUrl: layout.fromUrl,
      }),
      realpathSync(layout.host.entry),
    );
  } finally {
    await rm(layout.root, { recursive: true, force: true });
  }
});

test("invalid handoff is ignored: host fail-closes without argv, standalone uses own peer", async () => {
  const layout = await isolatedLayout();
  const junk = join(layout.root, "random.js");
  try {
    await writeFile(junk, "export {}\n");
    assert.equal(
      resolvePiCodingAgentEntry({
        source: "host",
        env: { [PI_CODING_AGENT_ENTRY_ENV]: junk },
        argv1: "",
        fromUrl: layout.fromUrl,
      }),
      undefined,
    );
    assert.equal(
      resolvePiCodingAgentEntry({
        source: "host",
        env: { [PI_CODING_AGENT_ENTRY_ENV]: layout.host.cli },
        argv1: junk,
        fromUrl: layout.fromUrl,
      }),
      undefined,
    );
    assert.equal(
      resolvePiCodingAgentEntry({
        source: "standalone",
        env: { [PI_CODING_AGENT_ENTRY_ENV]: junk },
        argv1: layout.host.cli,
        fromUrl: layout.fromUrl,
      }),
      realpathSync(layout.peer.entry),
    );
  } finally {
    await rm(layout.root, { recursive: true, force: true });
  }
});

test("host source prefers argv over a local OpenPI peer", async () => {
  const layout = await isolatedLayout();
  try {
    assert.equal(
      resolvePiCodingAgentEntry({
        source: "host",
        env: {},
        argv1: layout.host.cli,
        fromUrl: layout.fromUrl,
      }),
      realpathSync(layout.host.entry),
    );
  } finally {
    await rm(layout.root, { recursive: true, force: true });
  }
});

test("standalone source uses the install peer and official 0.84.1 exports", async () => {
  const layout = await isolatedLayout();
  try {
    assert.equal(
      resolvePiCodingAgentEntry({
        source: "standalone",
        env: {},
        argv1: layout.host.cli,
        fromUrl: layout.fromUrl,
      }),
      realpathSync(layout.peer.entry),
    );
    const aliases = resolveStandaloneJitiAliases({
      env: {},
      fromUrl: layout.fromUrl,
    });
    assert.deepEqual(aliases, {
      [PI_CODING_AGENT_PACKAGE]: realpathSync(layout.peer.entry),
    });
  } finally {
    await rm(layout.root, { recursive: true, force: true });
  }
});

test("standalone does not inherit an ancestor tree peer", async () => {
  const root = await mkdtemp(join(tmpdir(), "openpi-pi-entry-"));
  try {
    const ancestor = await writePiPackage(
      join(root, "node_modules", "@earendil-works", "pi-coding-agent"),
      { marker: "ancestor" },
    );
    const isolatedFile = join(root, "isolated-openpi", "bin", "openpi.js");
    await mkdir(join(root, "isolated-openpi", "bin"), { recursive: true });
    await writeFile(
      join(root, "isolated-openpi", "package.json"),
      JSON.stringify({ name: "@tt-a1i/openpi", type: "module" }),
    );
    await writeFile(isolatedFile, "");
    assert.equal(
      resolvePiCodingAgentEntry({
        source: "standalone",
        env: {},
        argv1: ancestor.cli,
        fromUrl: pathToFileURL(isolatedFile).href,
      }),
      undefined,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("standalone fail-closes without a peer and does not walk PATH", async () => {
  const layout = await isolatedLayout();
  try {
    assert.equal(
      resolvePiCodingAgentEntry({
        source: "standalone",
        env: {},
        argv1: layout.host.cli,
        fromUrl: layout.isolatedFromUrl,
      }),
      undefined,
    );
    assert.match(
      missingPiCodingAgentDiagnostic(),
      /pi install npm:@tt-a1i\/openpi/u,
    );
    assert.match(
      missingPiCodingAgentDiagnostic(),
      /current process argv identity/u,
    );
    assert.match(
      missingPiCodingAgentDiagnostic(),
      /explicit standalone handoff, not a host fallback/u,
    );
  } finally {
    await rm(layout.root, { recursive: true, force: true });
  }
});

test("real checkout 0.84.1 exports resolve from this install", () => {
  const aliases = resolveStandaloneJitiAliases({
    env: {},
    fromUrl: new URL("../../bin/openpi.js", import.meta.url).href,
  });
  const entry = aliases[PI_CODING_AGENT_PACKAGE];
  assert.ok(entry);
  const officialEntry = realpathSync(
    fileURLToPath(
      new URL(
        "../../node_modules/@earendil-works/pi-coding-agent/dist/index.js",
        import.meta.url,
      ),
    ),
  );
  assert.equal(entry, officialEntry);
  assert.equal(
    officialPackageEntryTail(entry),
    "@earendil-works/pi-coding-agent/dist/index.js",
  );
  assert.equal(
    officialPackageEntryTail(
      "D:\\a\\openpi\\openpi\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\index.js",
    ),
    "@earendil-works/pi-coding-agent/dist/index.js",
  );
  const manifest = JSON.parse(
    readFileSync(
      new URL(
        "../../node_modules/@earendil-works/pi-coding-agent/package.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as { version?: string; exports?: { "."?: { import?: string } } };
  assert.equal(manifest.version, "0.84.1");
  assert.equal(manifest.exports?.["."]?.import, "./dist/index.js");
});
