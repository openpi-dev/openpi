# Harness-strength comparison protocol

This protocol turns Issue #45's question into a reproducible comparison. It is a
protocol, not a result: no arm is preferred and no conclusion is valid until a
dated run records all required identities and evidence.

**Status:** draft · **Created:** 2026-09-06 · **Verified:** 2026-09-06

**Source boundary:** OpenPI repository protocols and the fixed Issue #45
question; no benchmark result or external harness claim is adopted here.

**Related Issue:** [#45](https://github.com/openpi-dev/openpi/issues/45)

**Related PR:** pending (this document is the protocol slice)

**Supersedes:** none

## Question and fixed arms

For the same task, model, provider, workspace image, and verifier, compare the
execution cost and failure recovery of:

| Arm | Tool/profile contract |
| --- | --- |
| `bare-pi` | Pi's native coding tools only (`read`, `bash`, `edit`, `write`) |
| `openpi-explicit` | OpenPI installed from the pinned checkout, capability discovery `explicit`, no capability group loaded unless the task requests it |
| `openpi-adaptive` | The same OpenPI revision with `adaptive` discovery enabled; record every group loaded and the turn that loaded it |
| `omp` | OMP at a pinned revision and frozen tool/config profile |

An arm is invalid if it silently changes provider, model, thinking level,
workspace contents, network policy, or verifier. If an arm cannot run, record a
`setup_failure`; do not substitute a different arm or drop the sample.

## Frozen identity

Every run writes one receipt with these fields before execution starts:

```json
{
  "protocol": "openpi-harness-strength-v1",
  "runId": "uuid",
  "arm": "openpi-explicit",
  "source": {"name": "openpi", "revision": "git-sha", "install": "checkout"},
  "provider": {"id": "provider-id", "model": "model-id", "thinking": "level"},
  "task": {"id": "task-id", "revision": "task-sha", "promptHash": "sha256"},
  "verifier": {"id": "verifier-id", "revision": "verifier-sha"},
  "environment": {"os": "...", "runtime": "...", "workspaceImage": "..."},
  "startedAt": "RFC-3339"
}
```

Raw prompts, credentials, Session files, and full logs stay outside Git. The
receipt stores hashes and stable archive references instead of sensitive data.

## Accounting

Record each model turn and the final aggregate. Keep provider-reported fields
separate from locally measured fields:

- provider usage: input, output, cache read/write, total tokens, request count;
- local cost: wall time, CPU time, peak RSS, retry count, tool-call count;
- harness projection: static system/tool bytes, dynamic tool-result bytes,
  capability loads, compactions, branch changes, and child/workflow work;
- outcome: `success`, `verifier_failure`, `model_failure`, `harness_failure`,
  `setup_failure`, `timeout`, `cancelled`, or `unknown`.

Static tax is measured from the first provider-bound request before task output;
dynamic tax is the sum of subsequent model-visible additions and recovery
requests. Do not infer provider billing from local byte counts.

## Failure and recovery classification

The verifier must emit one terminal result and, when applicable, a structured
failure receipt:

1. `success`: task verifier passes and all required artifacts are present;
2. `verifier_failure`: the agent settles but the independent verifier rejects;
3. `model_failure`: malformed/invalid model behavior prevents a valid attempt;
4. `harness_failure`: tool, lifecycle, persistence, or cleanup contract fails;
5. `setup_failure`: the frozen arm cannot be launched;
6. `timeout` / `cancelled`: the operator or bound ends execution;
7. `unknown`: evidence is insufficient to distinguish the above.

For every non-success result, record the first failure boundary, retries,
recovery action, whether the same task was re-run, and the evidence reference.
Never convert a retry into a second independent sample.

## Sample design

Use a fixed task matrix with at least one search/edit/test task, one task that
needs a long-running process, and one task requiring recovery after a failed
command. Run each task-arm pair with a fresh workspace and fresh Session. Keep
the task order randomized by a published seed, and repeat the matrix enough to
report a confidence interval rather than a single mean.

The primary report must show per-arm distributions for success rate, wall time,
provider tokens, static tax, dynamic tax, retry/recovery cost, and failure
class. Averages without sample counts and raw bounded receipts are incomplete.

## Verification and evidence

The verifier is independent of the harness and must be pinned by identity. It
may inspect the candidate workspace, test output, and declared artifacts, but it
must not read the harness's hidden success label. Each receipt records:

- verifier exit status and normalized result;
- artifact paths plus hashes and byte sizes;
- bounded stdout/stderr references;
- source/model/task/verifier identities;
- limitations, omitted evidence, and archive location.

The canonical report links the GitHub Issue and this protocol, names the exact
source/model/task/verifier revisions, and states which fields were unavailable.
No result is published from a dry run or from a receipt with missing identity,
usage accounting, failure classification, or evidence reference.

## Ablation and interpretation guardrails

Before attributing a gain to a harness feature, repeat the same arm with that
feature removed or disabled while preserving the rest of the profile. If the
result still satisfies the task and cost/failure evidence is unchanged, remove
the feature from the claimed explanation. Capability loading, structured
results, compaction, and recovery are separate ablations; do not bundle them
into a single “OpenPI” cause.

This protocol does not prescribe a default harness, does not add runtime
routing, and does not turn a benchmark result into a product requirement.
