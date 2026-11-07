import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const cli = resolve("skills/semantic-navigation/scripts/semantic.mjs");
const fake = String.raw`
let buffer = Buffer.alloc(0);
const mode = process.argv[2];
const send = (msg) => { const b=Buffer.from(JSON.stringify({jsonrpc:'2.0',...msg})); process.stdout.write('Content-Length: '+b.length+'\r\n\r\n'); process.stdout.write(b); };
process.stdin.on('data', data => {
 buffer=Buffer.concat([buffer,data]);
 while(true) {
  const i=buffer.indexOf('\r\n\r\n'); if(i<0)return;
  const n=Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0,i).toString())[1]);
  if(buffer.length<i+4+n)return;
  const msg=JSON.parse(buffer.subarray(i+4,i+4+n)); buffer=buffer.subarray(i+4+n);
  if(msg.method==='initialize') {
   if(mode==='timeout')continue;
   if(mode==='missing-result'){send({id:msg.id});continue;}
   if(mode==='bad-frame'){ process.stdout.write('Content-Length: 99999999\r\n\r\n'); continue; }
   send({id:msg.id,result:{serverInfo:{name:'fixture',version:'1'},capabilities:mode==='unsupported'?{}:{definitionProvider:true,referencesProvider:true,diagnosticProvider:{interFileDependencies:false,workspaceDiagnostics:false}}}});
  } else if(msg.method==='textDocument/definition') {
   send({id:99,method:'workspace/applyEdit',params:{edit:{changes:{}}}});
   globalThis.navigation=msg;
  } else if(msg.id===99) {
   if(msg.result?.applied!==false)process.exit(19);
   send({id:globalThis.navigation.id,result:mode==='null'?null:{uri:'file:///exact-target.ts',range:{start:globalThis.navigation.params.position,end:globalThis.navigation.params.position}}});
  } else if(msg.method==='textDocument/references') send({id:msg.id,result:[]});
  else if(msg.method==='textDocument/diagnostic') send({id:msg.id,result:mode==='unchanged'?{kind:'unchanged',resultId:'x'}:{kind:'full',items:[{range:{start:{line:0,character:0},end:{line:0,character:1}},severity:1,code:42,source:'fixture',message:'problem'}]}});
  else if(msg.method==='shutdown'){if(Object.hasOwn(msg,'params'))send({id:msg.id,error:{code:-32602,message:'shutdown requires absent params'}});else send({id:msg.id,result:null});}
  else if(msg.method==='exit'){if(mode==='exit1'){console.error('context canceled');process.exit(1);}else process.exit(0);}
 }
});
`;
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "semantic-navigation-"));
  const server = join(root, "server.cjs");
  writeFileSync(server, fake);
  writeFileSync(join(root, "source.ts"), "😀x\n");
  const request = (operation = "definition", mode = "ok") => ({
    operation,
    root,
    server: { command: process.execPath, args: [server, mode] },
    document: { path: "source.ts", languageId: "typescript" },
    position: { line: 1, column: 3 },
    timeoutMs: 2000,
  });
  return {
    root,
    request,
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}
function run(input: unknown) {
  const result = spawnSync(process.execPath, [cli], {
    input: JSON.stringify(input),
    encoding: "utf8",
    timeout: 10000,
  });
  assert.equal(result.error, undefined);
  return { code: result.status, output: JSON.parse(result.stdout) };
}

test("navigation retains UTF-16 positions, refuses edits, and reports actual nonzero exit separately", () => {
  const f = fixture();
  try {
    const { code, output } = run(f.request("definition", "exit1"));
    assert.equal(code, 0);
    assert.equal(output.request.status, "completed");
    assert.equal(output.request.result.uri, "file:///exact-target.ts");
    assert.deepEqual(output.request.result.range.start, {
      line: 0,
      character: 2,
    });
    assert.equal(output.lifecycle.shutdown, "acknowledged");
    assert.equal(output.lifecycle.exit.code, 1);
    assert.match(output.lifecycle.stderrTail, /context canceled/);
    const empty = run(f.request("definition", "null")).output;
    assert.equal(empty.request.result, null);
    assert.equal(empty.request.noLocation, true);
  } finally {
    f.close();
  }
});

test("unsupported, incomplete, timeout and malformed protocol never become empty success", () => {
  const f = fixture();
  try {
    assert.equal(
      run(f.request("diagnostics", "unsupported")).output.request.status,
      "unsupported",
    );
    const incomplete = run(f.request("diagnostics", "unchanged")).output;
    assert.equal(incomplete.request.status, "failed");
    assert.equal(incomplete.snapshot.status, "unknown");
    const malformed = run(f.request("definition", "missing-result")).output;
    assert.equal(malformed.request.status, "failed");
    assert.match(malformed.request.error, /Missing response result/);
    assert.ok(malformed.lifecycle.exit);
    const timeout = run({
      ...f.request("definition", "timeout"),
      timeoutMs: 100,
    }).output;
    assert.equal(timeout.request.status, "failed");
    assert.match(timeout.request.error, /timeout/);
    assert.ok(timeout.lifecycle.exit);
    assert.equal(
      run(f.request("definition", "bad-frame")).output.request.status,
      "failed",
    );
  } finally {
    f.close();
  }
});

test("diagnostic comparisons preserve same-message replacement and duplicate occurrences", () => {
  const f = fixture();
  try {
    const before = run(f.request("diagnostics")).output.snapshot;
    assert.equal(before.status, "complete");
    assert.match(before.document.sha256, /^[a-f0-9]{64}$/);
    const after = structuredClone(before);
    after.document.sha256 = "b".repeat(64);
    after.diagnostics[0].range.start.character = 2;
    after.diagnostics[0].range.end.character = 3;
    after.diagnostics.push(structuredClone(after.diagnostics[0]));
    const compared = run({ operation: "compare", before, after }).output;
    assert.equal(compared.ambiguous.length, 1);
    assert.equal(compared.ambiguous[0].before.length, 1);
    assert.equal(compared.ambiguous[0].after.length, 2);
    assert.equal(compared.newlyObserved.length, 0);
    assert.equal(compared.resolvedObserved.length, 0);
    assert.equal(compared.unchanged.length, 0);
    const same = run({ operation: "compare", before, after: before }).output;
    assert.equal(same.unchanged.length, 1);
    const replaced = structuredClone(after);
    replaced.diagnostics[0].message = "different problem";
    replaced.diagnostics[1].message = "different problem";
    const delta = run({ operation: "compare", before, after: replaced }).output;
    assert.equal(delta.newlyObserved.length, 2);
    assert.equal(delta.resolvedObserved.length, 1);
    const mismatched = structuredClone(before);
    mismatched.server.args.push("--other-config");
    assert.equal(
      run({ operation: "compare", before, after: mismatched }).output.status,
      "unknown",
    );
    assert.equal(
      run({
        operation: "compare",
        before,
        after: { ...before, status: "unknown" },
      }).output.status,
      "unknown",
    );
  } finally {
    f.close();
  }
});
