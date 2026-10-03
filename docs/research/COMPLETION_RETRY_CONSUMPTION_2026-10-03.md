---
status: validated
created: 2026-10-03
last-verified: 2026-10-04
applies-to: OpenPI main c7862b852d866123e2b32c79d309bd49a3cf515f and the scoped fix for issue 647
related-issues:
  - https://github.com/openpi-dev/openpi/issues/647
related-prs:
  - https://github.com/openpi-dev/openpi/pull/649
supersedes: none
---

# Completion claims and late transport retries

## Verified facts

The shared inbox removes an envelope from `pending` when transport claims it. Before this fix, producer consumption inspected only `pending`, and `retry` unconditionally re-admitted the caller's envelopes. Consequently, `claim → consume → retry` revived a completion already returned by a status/wait path. `claim → acknowledge/clear → retry` also revived an invalidated claim. A production Background Terminal adapter regression reproduced the same duplicate after `drain → consume → restore`.

The scoped fix removes matching producer identities from both maps and permits retry only while the exact envelope still owns its in-flight slot. This also rejects an old batch after a replacement claim reuses the same delivery id. Unconsumed siblings retain their original order ahead of newly pending work. Existing owner and epoch checks still govern admission.

## Validation and limits

Three new regressions failed before the runtime change. After the change, the inbox and Background Terminal, Subagent, and Workflow delivery suites passed; a further regression covers replacement claims. Tests exercise the actual shared module and adapters without model calls, timers, or external services. Full repository gates are recorded in the linked PR.

No installed Pi, provider, or manual TUI smoke is claimed. This preserves an existing runtime consumption/cleanup invariant; it adds no tool, persisted state, configuration, or model reasoning policy. Workflow's durable per-run transport receipt recovery remains owned by its existing adapter.

## Native Pi follow-up — 2026-10-04

The preceding validation describes the original source-only run. Subsequent native Print/RPC verification used Windows, Node 24.14.0, Bun 1.3.14, and the repository-locked Pi 0.99.1. The isolated checkout was local integration commit `19db59aee8f01947d4a8b6ce4e88a72bf0ccb059`, whose parents are PR #649's `7919678282376702f31632bfba14c4c72fb517fd` and PR #650's `ebf9759c4698fee1f652a4ee557a5d68ec3876cd`. Native `pi list` reported that checkout as its single OpenPI source before and after the run. The user's global Pi 0.85.1 still pointed to their unchanged `868b7cc30c3c2a0f53de568b04034cd7843f44d7` checkout; it was not evidence for these fixes.

In native Print Session `01a1026d-fcc9-7388-a0ba-c1ae0bfafe5e`, a temporary command exercised the production Background Terminal and Subagent delivery adapters with the real Session owner. Injected transport failures verified that consumed in-flight results stay retracted, unconsumed siblings retry, and cleanup prevents resurrection. Snapshots and failures were synthetic; no real network outage was induced.

In native RPC Session `01a1027f-f4fa-76d0-8eee-f9b238126151`, the user's configured `openai/gpt-5.6-sol` model (isolated thinking level `low`) called a temporary local verifier once. That verifier used Pi's native `ctx.executeTool` validation, hooks, and permissions to execute the production tools:

| Check | Observed terminal evidence |
| --- | --- |
| `bg_start` then `bg_status`, `process.exit(0)` | `bt-1`: `done`, exit code `0` |
| `bg_start` then `bg_status`, `process.exit(7)` | `bt-2`: `failed`, exit code `7` |
| `bg_start` then `bg_kill`, 60-second process | `bt-3`: `killed`, `killed: true` |
| Child-free `workflow`, top-level return | `wf_d6361ed6bcca`: `completed`, exact result `OPENPI_NATIVE_WORKFLOW_OK` |

All three created PIDs were absent after shutdown. Original user settings, models, and auth bytes were unchanged; temporary copies were removed. The verifier is local evidence, not a new package tool or workflow policy.

Stable local evidence identity: `pi-reliability-20261003`, archived outside Git at `F:/code/openpi-local-evidence/pi-reliability-20261003`. The bounded receipts are `retry-smoke-receipt.json` (SHA-256 `88b910bde750ec618fc66df80ede540159f71f44555ca3b2a2bb02c5fea80bd5`) and `native-smoke-2-receipt.json` (SHA-256 `566c7094df3485fd8593101ae37228ac182425885528e57a3fdf10199218ae0c`); `verification-manifest.json` identifies their scripts, raw events, source provenance, configuration checks, and cleanup checks. Raw provider/session evidence remains private and local. This is not a formal Benchmark or manual TUI acceptance.

Earlier ordinary-model attempts were retained as failed or incomplete evidence: one prompt did not activate optional tools, and two rounds exceeded 120/180-second verifier deadlines. One of those rounds started three real processes but did not complete explicit status/cancellation observation; native Session shutdown removed them. These attempts do not establish a provider/runtime defect and are not counted as passed. The successful nested-call run above proves runtime tool execution, while autonomous multi-round model orchestration and automatic idle-parent delivery remain outside this smoke's validated boundary.
