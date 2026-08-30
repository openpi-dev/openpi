"use strict";

// This file is launched by sandbox.ts in Node permission mode. It deliberately
// has no filesystem/network/child-process permissions and receives workflow
// source only over a validated IPC channel.
const vm = require("node:vm");
const sendIpc =
  typeof process.send === "function" ? process.send.bind(process) : undefined;
// If a future V8 escape exposes `process`, remove the convenient bridges to
// builtins, native bindings, parent signalling, and addons before any workflow
// source is compiled. The parent still enforces the authenticated IPC protocol.
for (const capability of [
  "getBuiltinModule",
  "binding",
  "_linkedBinding",
  "dlopen",
  "kill",
  "abort",
  "send",
]) {
  try {
    Object.defineProperty(process, capability, {
      value: undefined,
      writable: false,
      configurable: false,
    });
  } catch {
    // The VM boundary and permission mode remain mandatory controls.
  }
}

const BOOTSTRAP = String.raw`
(function bootstrapWorkflowApi() {
  "use strict";
  const callHost = globalThis.__hostBridge;
  delete globalThis.__hostBridge;
  let nextRequestId = 0;
  const unconsumed = new Set();
  const inFlight = new Set();

  function deepFreeze(value, depth = 0) {
    if (!value || typeof value !== "object" || depth > 32 || Object.isFrozen(value)) return value;
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key], depth + 1);
    return value;
  }

  function requestAgent(promptValue, optionsValue = {}) {
    const id = ++nextRequestId;
    unconsumed.add(id);
    let started;
    const begin = () => {
      unconsumed.delete(id);
      if (!started) {
        let payload;
        try {
          payload = JSON.stringify({
            id,
            prompt: typeof promptValue === "string" ? promptValue : String(promptValue ?? ""),
            options: optionsValue && typeof optionsValue === "object" ? optionsValue : {},
          });
        } catch (error) {
          started = Promise.reject(new Error("agent() arguments must be serializable: " + error.message));
          return started;
        }
        inFlight.add(id);
        // Re-wrap in a context-realm promise: chaining a host promise would
        // expose the host Function constructor through .constructor.constructor.
        started = new Promise((resolve, reject) => {
          callHost("agent", payload).then(resolve, reject);
        })
          .then((json) => JSON.parse(json))
          .finally(() => inFlight.delete(id));
      }
      return started;
    };
    return Object.freeze({
      then(resolve, reject) {
        return begin().then(resolve, reject);
      },
      catch(reject) {
        return begin().catch(reject);
      },
      finally(callback) {
        return begin().finally(callback);
      },
      get [Symbol.toStringTag]() {
        return "Promise";
      },
    });
  }

  async function mapLimited(items, concurrency, invoke) {
    const results = new Array(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (true) {
        const index = next++;
        if (index >= items.length) return;
        results[index] = await invoke(items[index], index);
      }
    });
    await Promise.all(workers);
    return results;
  }

  const maxConcurrency = globalThis.__maxConcurrency;
  delete globalThis.__maxConcurrency;

  async function parallel(items, options = {}) {
    if (!Array.isArray(items)) throw new Error("parallel() expects an array of zero-argument agent thunks");
    const requested = options && typeof options.concurrency === "number"
      ? Math.floor(options.concurrency)
      : maxConcurrency;
    if (!Number.isFinite(requested) || requested < 1) {
      throw new Error("parallel(): concurrency must be a positive integer");
    }
    const concurrency = Math.min(maxConcurrency, requested);
    return mapLimited(items, concurrency, async (item) => {
      if (typeof item !== "function") {
        throw new Error("parallel() items must be zero-argument functions");
      }
      // A thunk that throws settles to null instead of rejecting the whole
      // batch, so one bad item never discards every completed sibling's
      // result. agent() itself never throws (it returns { ok:false }); this
      // only catches user thunk code, e.g. JSON.parse on a non-JSON output.
      try {
        return await item();
      } catch {
        return null;
      }
    });
  }

  async function pipeline(items, ...stages) {
    if (!Array.isArray(items)) throw new Error("pipeline() expects an array of items as its first argument");
    for (const stage of stages) {
      if (typeof stage !== "function") throw new Error("pipeline() stages must be functions");
    }
    // Snapshot: mapLimited re-reads items[index] every iteration, so a stage
    // that mutates the array it was given would manufacture nulls for items
    // that never existed (truncating) or silently extend the run (appending).
    const work = items.slice();
    // Each item walks every stage on its own, with no barrier in between: item
    // A can be in stage 3 while item B is still in stage 1. Wall-clock is the
    // slowest single chain rather than the sum of each stage's slowest item.
    //
    // In-flight items are capped even though the host semaphore already
    // serializes agent calls, because the host counts an agent call against the
    // run budget when it is SUBMITTED, not when it runs. Releasing every chain
    // at once would burn the budget on calls that are merely queued.
    return mapLimited(work, Math.min(maxConcurrency, work.length || 1), async (item, index) => {
      let value = item;
      // A throwing stage drops just this item to null and skips its remaining
      // stages; siblings are unaffected. Matches parallel()'s thunk semantics.
      //
      // The throw is narrated rather than swallowed: without it a script bug
      // (a typo on an undefined field), a deliberate skip, and a genuinely
      // failed agent are all one indistinguishable null, and the "how many
      // dropped" count every script is told to report becomes a guess.
      try {
        for (const stage of stages) {
          value = await stage(value, item, index);
        }
        return value;
      } catch (error) {
        callHost(
          "log",
          JSON.stringify({
            text:
              "pipeline: item " +
              index +
              " dropped — " +
              ((error && error.message) || String(error)),
            kind: "pipeline-drop",
          }),
        );
        return null;
      }
    });
  }

  function phase(title) {
    callHost("phase", JSON.stringify({ title: String(title) }));
  }

  function log(message) {
    const text =
      typeof message === "string"
        ? message
        : message === undefined
          ? ""
          : (() => {
              try {
                return typeof message === "object" && message !== null
                  ? JSON.stringify(message)
                  : String(message);
              } catch {
                return String(message);
              }
            })();
    callHost("log", JSON.stringify({ text }));
  }

  // Synchronous read of a plain JSON string the host refreshes as agents
  // settle, so a loop condition evaluated right after an awaited agent call
  // sees that agent's spend. Returning a primitive keeps the host realm sealed.
  // (No backticks in this file's comments: BOOTSTRAP is a template literal.)
  function usage() {
    let raw;
    try {
      raw = JSON.parse(callHost("usage", ""));
    } catch {
      raw = undefined;
    }
    const read = (key) => {
      const value = raw && typeof raw === "object" ? raw[key] : undefined;
      return typeof value === "number" && Number.isFinite(value) ? value : 0;
    };
    const readLimit = (key) => {
      const limits = raw && typeof raw === "object" ? raw.limits : undefined;
      const value = limits && typeof limits === "object" ? limits[key] : undefined;
      return typeof value === "number" && Number.isFinite(value) ? value : 0;
    };
    // Every field is coerced, so a missing or malformed snapshot reads as zero
    // rather than undefined: a script doing arithmetic on it gets 0, not NaN.
    return deepFreeze({
      input: read("input"),
      output: read("output"),
      cacheRead: read("cacheRead"),
      cacheWrite: read("cacheWrite"),
      total: read("total"),
      cost: read("cost"),
      agents: read("agents"),
      limits: {
        concurrency: readLimit("concurrency"),
        maxAgentCalls: readLimit("maxAgentCalls"),
        callsUsed: readLimit("callsUsed"),
        callsRemaining: readLimit("callsRemaining"),
      },
    });
  }

  const argsEnvelope = JSON.parse(globalThis.__argsJson);
  const args = argsEnvelope.defined ? deepFreeze(argsEnvelope.value) : undefined;
  delete globalThis.__argsJson;
  const stringify = JSON.stringify;
  function serializeResult(value) {
    const seen = new WeakSet();
    return stringify(value === undefined ? null : value, (_key, item) => {
      if (typeof item === "bigint") return item.toString() + "n";
      if (item && typeof item === "object") {
        if (seen.has(item)) return "[circular]";
        seen.add(item);
      }
      return item;
    });
  }
  Object.defineProperties(globalThis, {
    agent: { value: requestAgent, writable: false, configurable: false },
    parallel: { value: parallel, writable: false, configurable: false },
    pipeline: { value: pipeline, writable: false, configurable: false },
    phase: { value: phase, writable: false, configurable: false },
    log: { value: log, writable: false, configurable: false },
    usage: { value: usage, writable: false, configurable: false },
    args: { value: args, writable: false, configurable: false },
    __workflowCheck: {
      value: Object.freeze(() => ({
        unconsumed: unconsumed.size,
        inFlight: inFlight.size,
      })),
      writable: false,
      configurable: false,
    },
    __workflowSerialize: {
      value: Object.freeze(serializeResult),
      writable: false,
      configurable: false,
    },
  });
})();
`;

let initialized = false;
let token;
/**
 * Latest host usage snapshot as a JSON string, refreshed on init and on every
 * agent result. IPC is an ordered stream, so "the last one received" is the
 * newest and no sequence number is needed.
 */
let usageJson = "{}";
/** Emission cap for the narrator; see the log bridge in run(). */
let logCount = 0;
const pendingAgents = new Map();

function send(message) {
  sendIpc?.({ token, ...message });
}

function fail(error) {
  const message = error instanceof Error ? error.message : String(error);
  send({ kind: "error", error: message.slice(0, 16 * 1024) });
}

process.on("message", (message) => {
  if (!message || typeof message !== "object") return;
  if (!initialized) {
    if (
      message.kind !== "init" ||
      typeof message.token !== "string" ||
      typeof message.source !== "string" ||
      typeof message.argsJson !== "string" ||
      !Number.isSafeInteger(message.maxConcurrency) ||
      message.maxConcurrency < 1 ||
      message.maxConcurrency > 64
    ) {
      process.exitCode = 1;
      return;
    }
    initialized = true;
    token = message.token;
    if (typeof message.usageJson === "string") usageJson = message.usageJson;
    run(message.source, message.argsJson, message.maxConcurrency);
    return;
  }
  if (message.token !== token || message.kind !== "agentResult") return;
  if (typeof message.usageJson === "string") usageJson = message.usageJson;
  const pending = pendingAgents.get(message.id);
  if (!pending) return;
  pendingAgents.delete(message.id);
  if (typeof message.resultJson === "string")
    pending.resolve(message.resultJson);
  else
    pending.reject(
      new Error(
        typeof message.error === "string" ? message.error : "Agent IPC failed",
      ),
    );
});

function run(source, argsJson, maxConcurrency) {
  try {
    const sandbox = Object.create(null);
    sandbox.__argsJson = argsJson;
    sandbox.__maxConcurrency = maxConcurrency;
    sandbox.__hostBridge = (kind, payloadJson) => {
      if (kind === "phase") {
        send({ kind: "phase", payloadJson });
        return undefined;
      }
      if (kind === "log") {
        // Capped in the CHILD, where the memory is. process.send queues on the
        // IPC pipe, and a synchronous log loop never yields, so the queue grows
        // until the 128MB heap dies with SIGABRT — taking every completed
        // agent's output with it. Measured: 1e6 logs delivers ~2k of them and
        // then aborts the run. The cap is ~100x the 100-line display window, so
        // nothing a reader would have seen is lost.
        if (++logCount > 10000) return undefined;
        send({ kind: "log", payloadJson });
        return undefined;
      }
      if (kind === "usage") return usageJson;
      if (kind !== "agent")
        return Promise.reject(new Error("Unknown workflow operation"));
      let id;
      try {
        id = JSON.parse(payloadJson).id;
      } catch {
        return Promise.reject(new Error("Invalid agent request"));
      }
      return new Promise((resolve, reject) => {
        pendingAgents.set(id, { resolve, reject });
        send({ kind: "agent", payloadJson });
      });
    };

    const context = vm.createContext(sandbox, {
      name: "pi-workflow",
      codeGeneration: { strings: false, wasm: false },
    });
    new vm.Script(BOOTSTRAP, {
      filename: "workflow-bootstrap.js",
    }).runInContext(context, { timeout: 1000 });
    const workflow = vm.compileFunction(
      `"use strict";\nreturn (async function workflow() {\n${source}\n})();`,
      ["agent", "parallel", "pipeline", "phase", "log", "usage", "args"],
      { filename: "workflow-script.js", parsingContext: context },
    );
    context.__workflowBody = workflow;
    const invoke = `
      (() => {
        const workflowBody = globalThis.__workflowBody;
        delete globalThis.__workflowBody;
        globalThis.__workflowPromise = Promise.resolve(
          workflowBody(agent, parallel, pipeline, phase, log, usage, args),
        ).then(async (value) => {
          await Promise.resolve();
          const pending = __workflowCheck();
          if (pending.unconsumed > 0) {
            throw new Error("Workflow created " + pending.unconsumed + " unawaited agent() call(s)");
          }
          if (pending.inFlight > 0) {
            throw new Error("Workflow returned before " + pending.inFlight + " agent call(s) settled");
          }
          return __workflowSerialize(value);
        });
      })();
    `;
    new vm.Script(invoke, { filename: "workflow-invoke.js" }).runInContext(
      context,
      { timeout: 1000 },
    );
    Promise.resolve(context.__workflowPromise)
      .then((resultJson) => {
        if (typeof resultJson !== "string")
          throw new Error("Workflow result was not serializable");
        send({ kind: "result", resultJson });
      })
      .catch(fail);
  } catch (error) {
    fail(error);
  }
}
