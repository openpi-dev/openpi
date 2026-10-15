# Installed-source native runtime acceptance

- Status: validated investigation; isolated native Session acceptance only
- Created: 2026-10-04
- Last verified: 2026-10-04
- Applies to: installed OpenPI source `d36b58b67f87d24b4926521b965bdccfff7719e4`; user Session loaded revision unknown
- Issues: [#651](https://github.com/openpi-dev/openpi/issues/651), [#652](https://github.com/openpi-dev/openpi/issues/652), [#654](https://github.com/openpi-dev/openpi/issues/654)
- Supersedes: none; adds acceptance evidence without rewriting implementation-stage records

## Source and experiment boundary

`pi list` reported one OpenPI package source, the local `~/work/openpi-main-runtime` checkout at the revision above. This investigation did not install, reload, alter user settings, or inspect private user Sessions. It does not establish which revision an existing interactive process has loaded.

A separate temporary agent directory and native SDK Session loaded the relevant extensions from that installed checkout. A loopback scripted provider drove actual tool dispatch and native Direct/Workflow child Sessions against synthetic files. There were eight loopback requests and zero external model calls. This validates runtime mechanisms, not model reasoning quality, all-package startup, or terminal pixels.

## Observed results

| Boundary | Observed result |
| --- | --- |
| Runtime snapshot | Bounded, redacted configured/selected/disk/loaded fields; synthetic dirty change and selected-model switch reflected; loaded revision and upstream route remain unknown |
| Direct completion | Actual child `read`; wait/check receipts agree; sealed evidence reference resolves; explicit consumption prevents duplicate automatic result |
| Workflow completion | Actual child `read`; inline/status receipts agree and consumption preserves owner semantics |
| Claim versus evidence | Scripted model says all tests passed; receipt still reports verification unknown, automatic verification not-run, process exit unknown, and shared-directory attribution unknown |
| Setup native renderer | Actual setup command produces default-collapsed message; expand/re-collapse works; persisted Session restoration reproduces the same component output |

The successful native run took 15.02 seconds. SDK import took 8.37 seconds and extension loading 1.39 seconds; the first snapshot took 1.03 seconds and subsequent snapshots 38/46 milliseconds. Direct spawn/wait took 455/281 milliseconds, Workflow execution/status 209/50 milliseconds, and setup rendering/restoration 1.10 seconds.

Separate owner/SDK/RPC/export checks passed 55/55 in 12.08 seconds; native renderer checks passed 5/5 in 10.74 seconds. These are individual local observations, not a matched performance benchmark.

## Preserved failures and unknowns

Early harness attempts used incorrect API/loading/evidence arguments; their failures were preserved and corrected in the harness, not treated as product defects. A default writable Workflow resume correctly selected fresh execution rather than claiming replay. An additional named read-only-role replay attempt was stopped after 92 seconds during SDK import, before provider requests, under a 180-second outer limit. Successful native replay remains unverified; deterministic replay tests do not replace that missing smoke.

Remaining acceptance includes the user's actual loaded Session, real TUI pixels and Ctrl+O host input, attached Web/RPC multi-client races, and real-model diagnostic error rate. No extra model experiment was run to manufacture an error-rate claim. These Issues retain their remaining boundaries rather than closing from isolated results alone.

The private evidence archive is `/tmp/openpi-installed-acceptance-20261004/`, with a bounded `acceptance-summary.json`, raw synthetic Session traces, failed attempts and a manifest. Raw Session data is not committed or published. Local archive availability does not constitute a public reproducibility package.
