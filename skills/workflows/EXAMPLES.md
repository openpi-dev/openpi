# Workflow examples

## Independent scan and verification pipeline

Each file advances to verification as soon as its own scan completes:

```js
export const meta = {
  name: "reliability-review",
  description: "Review modules for reliability risks, then report",
  phases: [{ title: "Scan" }, { title: "Verify" }, { title: "Report" }],
}
const FINDINGS = {
  type: "object",
  properties: {
    issues: { type: "array", items: { type: "string" } },
    ok: { type: "boolean" },
  },
  required: ["issues", "ok"],
}
phase("Scan")
const checked = await pipeline(
  args.files,
  (file) => agent(`Trace ${file} for reliability risks with file:line evidence.`, {
    agent_type: "explorer", label: `scan:${file}`, phase: "Scan", schema: FINDINGS,
  }),
  (scan, file) => scan.ok
    ? agent(`Verify the candidate issues in ${file}.`, {
        agent_type: "reviewer", label: `verify:${file}`, phase: "Verify", inputs: [scan.ref],
      })
    : null,
)
const verified = checked.filter((result) => result && result.ok)
const dropped = checked.length - verified.length
if (dropped) log(`${dropped}/${checked.length} file(s) dropped before verification`)
phase("Report")
const report = await agent("Synthesize recommendations from the verified findings.", {
  agent_type: "advisor", label: "report", phase: "Report",
  inputs: verified.map((result) => result.ref),
})
log(`done — ${verified.length} verified, ${usage().total} tokens`)
return { verified: verified.length, dropped, report: report.ok ? report.output : report.error }
```

## When a barrier is correct

Use `parallel()` when one synthesis prompt must compare every independent result:

```js
const findings = await parallel(files.map((file) => () =>
  agent(`Inspect ${file}.`, { agent_type: "explorer", label: file })
))
const usable = findings.filter((result) => result && result.ok)
return agent("Deduplicate and rank all findings.", {
  agent_type: "advisor",
  inputs: usable.map((result) => result.ref),
})
```
