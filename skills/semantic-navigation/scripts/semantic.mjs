#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MAX_INPUT = 8 * 1024 * 1024;
const MAX_FRAME = 4 * 1024 * 1024;
const MAX_WIRE = 16 * 1024 * 1024;
const MAX_ITEMS = 10000;
const limitation =
  "Only the requested document and observed server report are bound. Dependencies, configuration, environment and other documents are not frozen; this is not project-wide verification or edit causation.";
const help = {
  usage:
    "node semantic.mjs < request.json (JSON result on stdout; no files written)",
  request: {
    operation: "definition | references | diagnostics",
    root: "absolute project directory",
    server: {
      command: "explicit executable (no shell)",
      args: ["explicit arguments"],
    },
    document: { path: "file within root", languageId: "e.g. typescript" },
    position: {
      line: "1-based integer (navigation only)",
      column: "1-based UTF-16 code units",
    },
    includeDeclaration: "optional boolean for references; default true",
    timeoutMs: "optional total request budget 100..60000; default 15000",
  },
  compare: {
    operation: "compare",
    before: "complete snapshot object",
    after: "complete snapshot object",
  },
  limits: {
    inputBytes: MAX_INPUT,
    documentBytes: MAX_FRAME,
    frameBytes: MAX_FRAME,
    totalProtocolBytes: MAX_WIRE,
    resultItems: MAX_ITEMS,
    cleanupMs: 2000,
  },
  notes: [
    "Server is trusted executable code, not sandboxed. Use only a trusted installed server; this client sends read-only LSP requests and refuses applyEdit.",
    "No downloads, server discovery, configuration writes or project-clean claims.",
    limitation,
  ],
};
const stable = (value) =>
  JSON.stringify(value, (_, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => a.localeCompare(b)),
        )
      : item,
  );
const errorText = (error) =>
  error instanceof Error ? error.message : String(error);
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const validPosition = (p) =>
  p &&
  Number.isInteger(p.line) &&
  p.line >= 0 &&
  Number.isInteger(p.character) &&
  p.character >= 0;
const validRange = (r) =>
  r &&
  validPosition(r.start) &&
  validPosition(r.end) &&
  (r.end.line > r.start.line ||
    (r.end.line === r.start.line && r.end.character >= r.start.character));
const validDiagnostic = (d) =>
  d &&
  validRange(d.range) &&
  typeof d.message === "string" &&
  (d.severity === undefined ||
    (Number.isInteger(d.severity) && d.severity >= 1 && d.severity <= 4)) &&
  (d.code === undefined ||
    typeof d.code === "string" ||
    typeof d.code === "number") &&
  (d.source === undefined || typeof d.source === "string");

function compare(before, after) {
  const complete = (s) =>
    s?.schemaVersion === 1 &&
    s.status === "complete" &&
    s.reportKind === "full" &&
    typeof s.root === "string" &&
    isAbsolute(s.root) &&
    s.document &&
    typeof s.document.uri === "string" &&
    s.document.uri.startsWith("file:") &&
    typeof s.document.languageId === "string" &&
    Number.isInteger(s.document.version) &&
    /^[a-f0-9]{64}$/.test(s.document.sha256) &&
    typeof s.server?.command === "string" &&
    Array.isArray(s.server.args) &&
    s.server.args.every((a) => typeof a === "string") &&
    typeof s.observedAt === "string" &&
    s.environmentLimitation === limitation &&
    Array.isArray(s.diagnostics) &&
    s.diagnostics.length <= MAX_ITEMS &&
    s.diagnostics.every(validDiagnostic);
  const identity = (s) => ({
    root: s.root,
    uri: s.document.uri,
    languageId: s.document.languageId,
    server: s.server,
    environmentLimitation: s.environmentLimitation,
  });
  if (
    !complete(before) ||
    !complete(after) ||
    stable(identity(before)) !== stable(identity(after))
  )
    return {
      status: "unknown",
      reason:
        "Snapshots are incomplete, invalid, or have incompatible document/server metadata.",
      limitation,
    };
  const sameSource = before.document.sha256 === after.document.sha256;
  const signature = (d) =>
    stable([d.source ?? null, d.code ?? null, d.severity ?? null, d.message]);
  const groups = new Map();
  for (const [side, snapshot] of [
    ["before", before],
    ["after", after],
  ])
    for (const diagnostic of snapshot.diagnostics) {
      const key = signature(diagnostic);
      if (!groups.has(key)) groups.set(key, { before: [], after: [] });
      groups.get(key)[side].push(diagnostic);
    }
  const unchanged = [],
    ambiguous = [],
    newlyObserved = [],
    resolvedObserved = [];
  for (const group of groups.values()) {
    if (!group.before.length) newlyObserved.push(...group.after);
    else if (!group.after.length) resolvedObserved.push(...group.before);
    else if (
      sameSource &&
      stable(group.before.map(stable).sort()) ===
        stable(group.after.map(stable).sort())
    )
      unchanged.push(group);
    else ambiguous.push(group);
  }
  return {
    status: "compared",
    sameSource,
    unchanged,
    ambiguous,
    newlyObserved,
    resolvedObserved,
    limitation,
  };
}

async function observe(input) {
  assert(
    ["definition", "references", "diagnostics"].includes(input.operation),
    "Unknown operation",
  );
  assert(
    typeof input.root === "string" && isAbsolute(input.root),
    "root must be absolute",
  );
  const root = await realpath(input.root);
  assert((await stat(root)).isDirectory(), "root must be a directory");
  assert(
    typeof input.server?.command === "string" &&
      input.server.command.length > 0 &&
      Array.isArray(input.server.args) &&
      input.server.args.every((a) => typeof a === "string"),
    "server requires command and string args array",
  );
  assert(
    typeof input.document?.path === "string" &&
      typeof input.document.languageId === "string" &&
      input.document.languageId.length > 0,
    "document requires path and languageId",
  );
  const file = await realpath(resolve(root, input.document.path));
  const rel = relative(root, file);
  assert(
    rel !== ".." &&
      !rel.startsWith("../") &&
      !rel.startsWith("..\\") &&
      !isAbsolute(rel),
    "document must be within root",
  );
  assert((await stat(file)).size <= MAX_FRAME, "Document exceeds byte limit");
  const bytes = await readFile(file);
  assert(bytes.length <= MAX_FRAME, "Document exceeds byte limit");
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  const uri = pathToFileURL(file).href;
  const timeoutMs = input.timeoutMs ?? 15000;
  assert(
    Number.isInteger(timeoutMs) && timeoutMs >= 100 && timeoutMs <= 60000,
    "timeoutMs must be 100..60000",
  );
  let position;
  if (input.operation !== "diagnostics") {
    const p = input.position;
    assert(
      p &&
        Number.isInteger(p.line) &&
        p.line >= 1 &&
        Number.isInteger(p.column) &&
        p.column >= 1,
      "position requires positive 1-based line and column",
    );
    const lines = text.split(/\r\n|\n|\r/);
    assert(
      p.line <= lines.length && p.column <= lines[p.line - 1].length + 1,
      "Position outside document",
    );
    position = { line: p.line - 1, character: p.column - 1 };
  }
  assert(
    input.includeDeclaration === undefined ||
      typeof input.includeDeclaration === "boolean",
    "includeDeclaration must be boolean",
  );
  const output = {
    operation: input.operation,
    request: { status: "failed" },
    lifecycle: { shutdown: "not-requested", exit: null, termination: "none" },
    limitation,
  };
  let child,
    timer,
    failed,
    exitResolve,
    initialized = false,
    opened = false;
  let buffer = Buffer.alloc(0),
    wireBytes = 0,
    stderr = "",
    nextId = 0;
  const pending = new Map();
  const exitPromise = new Promise((resolveExit) => {
    exitResolve = resolveExit;
  });
  const rejectAll = (error) => {
    failed ??= error;
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  };
  const terminate = (signal = "SIGTERM") => {
    if (child && !output.lifecycle.exit) {
      output.lifecycle.termination = signal;
      child.kill(signal);
    }
  };
  const fail = (error) => {
    output.lifecycle.error = errorText(error);
    rejectAll(error);
    terminate();
  };
  const interrupt = (signal) => fail(new Error(`Interrupted by ${signal}`));
  const onInt = () => interrupt("SIGINT"),
    onTerm = () => interrupt("SIGTERM");
  const send = (message) => {
    if (failed) throw failed;
    const data = Buffer.from(JSON.stringify(message));
    assert(data.length <= MAX_FRAME, "Outgoing frame exceeds byte limit");
    child.stdin.write(
      Buffer.concat([
        Buffer.from(`Content-Length: ${data.length}\r\n\r\n`),
        data,
      ]),
    );
  };
  const request = (method, params) =>
    new Promise((resolveRequest, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve: resolveRequest, reject });
      try {
        send({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        pending.delete(id);
        reject(error);
      }
    });
  const notify = (method, params) => send({ jsonrpc: "2.0", method, params });
  try {
    child = spawn(input.server.command, input.server.args, {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    child.on("error", (error) => {
      fail(error);
      exitResolve();
    });
    child.on("exit", (code, signal) => {
      output.lifecycle.exit = { code, signal };
      rejectAll(new Error(`Server exited (${code ?? signal})`));
      exitResolve();
    });
    child.stdin.on("error", fail);
    child.stderr.on("data", (data) => {
      stderr = (stderr + data.toString()).slice(-8192);
    });
    child.stdout.on("data", (data) => {
      try {
        wireBytes += data.length;
        assert(wireBytes <= MAX_WIRE, "Protocol exceeds total byte limit");
        buffer = Buffer.concat([buffer, data]);
        while (true) {
          const end = buffer.indexOf("\r\n\r\n");
          if (end < 0) {
            assert(buffer.length <= 8192, "Protocol header exceeds limit");
            return;
          }
          assert(end <= 8192, "Protocol header exceeds limit");
          const lengths = [
            ...buffer
              .subarray(0, end)
              .toString()
              .matchAll(/^Content-Length:\s*(\d+)\s*$/gim),
          ];
          assert(lengths.length === 1, "Invalid Content-Length header");
          const length = Number(lengths[0][1]);
          assert(length <= MAX_FRAME, "Protocol frame exceeds limit");
          if (buffer.length < end + 4 + length) return;
          const message = JSON.parse(
            buffer.subarray(end + 4, end + 4 + length).toString("utf8"),
          );
          buffer = buffer.subarray(end + 4 + length);
          assert(
            message && message.jsonrpc === "2.0",
            "Invalid JSON-RPC message",
          );
          if (message.method && message.id !== undefined) {
            // No server request may mutate files or ask the client to run commands.
            if (
              message.method === "workspace/configuration" &&
              Array.isArray(message.params?.items)
            )
              send({
                jsonrpc: "2.0",
                id: message.id,
                result: message.params.items.map(() => null),
              });
            else if (message.method === "workspace/workspaceFolders")
              send({
                jsonrpc: "2.0",
                id: message.id,
                result: [{ uri: pathToFileURL(root).href, name: root }],
              });
            else if (message.method === "workspace/applyEdit")
              send({
                jsonrpc: "2.0",
                id: message.id,
                result: { applied: false, failureReason: "Read-only client" },
              });
            else
              send({
                jsonrpc: "2.0",
                id: message.id,
                error: {
                  code: -32601,
                  message: "Unsupported by read-only client",
                },
              });
          } else if (message.id !== undefined) {
            const waiter = pending.get(message.id);
            if (waiter) {
              assert(
                message.error || Object.hasOwn(message, "result"),
                "Missing response result",
              );
              pending.delete(message.id);
              if (message.error)
                waiter.reject(
                  new Error(
                    `LSP ${message.error.code}: ${message.error.message}`,
                  ),
                );
              else {
                assert(
                  Object.hasOwn(message, "result"),
                  "Missing response result",
                );
                waiter.resolve(message.result);
              }
            }
          }
        }
      } catch (error) {
        fail(error);
      }
    });
    process.on("SIGINT", onInt);
    process.on("SIGTERM", onTerm);
    timer = setTimeout(() => fail(new Error("Request timeout")), timeoutMs);
    const init = await request("initialize", {
      processId: process.pid,
      rootUri: pathToFileURL(root).href,
      workspaceFolders: [{ uri: pathToFileURL(root).href, name: root }],
      capabilities: {
        general: { positionEncodings: ["utf-16"] },
        textDocument: {
          definition: { linkSupport: true },
          diagnostic: { relatedDocumentSupport: false },
        },
      },
    });
    assert(
      init?.capabilities &&
        (!init.capabilities.positionEncoding ||
          init.capabilities.positionEncoding === "utf-16"),
      "Server did not negotiate UTF-16",
    );
    initialized = true;
    notify("initialized", {});
    const capability = {
      definition: "definitionProvider",
      references: "referencesProvider",
      diagnostics: "diagnosticProvider",
    }[input.operation];
    if (!init.capabilities[capability])
      output.request = {
        status: "unsupported",
        reason: `Server did not advertise ${capability}`,
      };
    else {
      notify("textDocument/didOpen", {
        textDocument: {
          uri,
          languageId: input.document.languageId,
          version: 1,
          text,
        },
      });
      opened = true;
      if (input.operation === "diagnostics") {
        const provider = init.capabilities.diagnosticProvider;
        const report = await request("textDocument/diagnostic", {
          textDocument: { uri },
          ...(provider.identifier === undefined
            ? {}
            : { identifier: provider.identifier }),
        });
        assert(
          report?.kind === "full" && Array.isArray(report.items),
          "Expected full single-document diagnostic report",
        );
        assert(
          !report.relatedDocuments ||
            Object.keys(report.relatedDocuments).length === 0,
          "Related-document report is outside requested scope",
        );
        assert(
          report.items.length <= MAX_ITEMS &&
            report.items.every(validDiagnostic),
          "Invalid or excessive diagnostics",
        );
        output.snapshot = {
          schemaVersion: 1,
          status: "complete",
          reportKind: "full",
          root,
          document: {
            uri,
            languageId: input.document.languageId,
            version: 1,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          },
          server: {
            command: input.server.command,
            args: input.server.args,
            serverInfo: init.serverInfo ?? null,
          },
          observedAt: new Date().toISOString(),
          diagnostics: report.items,
          environmentLimitation: limitation,
        };
        output.request = { status: "completed" };
      } else {
        const result = await request(`textDocument/${input.operation}`, {
          textDocument: { uri },
          position,
          ...(input.operation === "references"
            ? {
                context: {
                  includeDeclaration: input.includeDeclaration ?? true,
                },
              }
            : {}),
        });
        const locations =
          result === null ? [] : Array.isArray(result) ? result : [result];
        assert(
          locations.length <= MAX_ITEMS &&
            locations.every(
              (l) =>
                l &&
                ((typeof l.uri === "string" && validRange(l.range)) ||
                  (input.operation === "definition" &&
                    typeof l.targetUri === "string" &&
                    validRange(l.targetRange) &&
                    validRange(l.targetSelectionRange))),
            ),
          "Invalid or excessive locations",
        );
        output.request = {
          status: "completed",
          result,
          noLocation: result === null || locations.length === 0,
        };
      }
    }
  } catch (error) {
    output.request = { status: "failed", error: errorText(error) };
  } finally {
    clearTimeout(timer);
    if (child) {
      if (!failed && initialized) {
        const shutdownTimer = setTimeout(
          () => fail(new Error("Shutdown timeout")),
          500,
        );
        try {
          if (opened)
            notify("textDocument/didClose", { textDocument: { uri } });
          await request("shutdown");
          output.lifecycle.shutdown = "acknowledged";
          notify("exit");
          child.stdin.end();
        } catch (error) {
          output.lifecycle.shutdown = errorText(error);
        }
        clearTimeout(shutdownTimer);
      }
      const wait = (ms) =>
        new Promise((done) => {
          const t = setTimeout(done, ms);
          exitPromise.then(() => {
            clearTimeout(t);
            done();
          });
        });
      await wait(500);
      if (!output.lifecycle.exit) {
        terminate();
        await wait(500);
      }
      if (!output.lifecycle.exit) {
        terminate("SIGKILL");
        await wait(500);
      }
      if (!output.lifecycle.exit) output.lifecycle.cleanup = "exit-unconfirmed";
      child.stdout.destroy();
      child.stderr.destroy();
      child.stdin.destroy();
      child.unref();
    }
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
  }
  output.lifecycle.stderrTail = stderr;
  if (
    output.request.status !== "completed" &&
    input.operation === "diagnostics"
  )
    output.snapshot = {
      schemaVersion: 1,
      status: "unknown",
      reason: output.request.reason ?? output.request.error,
    };
  return output;
}

async function main() {
  if (process.argv.length === 3 && process.argv[2] === "--help") return help;
  assert(
    process.argv.length === 2,
    "Use --help or supply one JSON request on stdin",
  );
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    assert(size <= MAX_INPUT, "Input exceeds byte limit");
    chunks.push(chunk);
  }
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  assert(input && typeof input === "object", "Expected JSON object");
  return input.operation === "compare"
    ? compare(input.before, input.after)
    : observe(input);
}
try {
  const output = await main();
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  if (output.request?.status === "failed" || output.status === "unknown")
    process.exitCode = 1;
} catch (error) {
  process.stdout.write(
    `${JSON.stringify({ request: { status: "failed", error: errorText(error) } })}\n`,
  );
  process.exitCode = 1;
}
