# Workflow dashboard refresh investigation

- Status: validated at the source and regression-test boundary
- Created / verified: 2026-09-07
- Baseline: `c8f2c13d49f2e6cd3b389dfff72ccc2eaca970c1`
- Fix boundary: the dashboard and regression tests delivered with this record
- Issue: [#420](https://github.com/openpi-dev/openpi/issues/420)
- Supersedes: none

## Observations

At the baseline, the dashboard's 120 ms spinner interval calls `refresh()`,
which calls `loadRunEntries()`. The loader scans persisted runs and synchronously
normalizes their records and hydrates result/transcript artifacts before filtering
by session and request time. Returning from phase detail also calls this loader.

A live local Pi process reached approximately 101% CPU. A three-second macOS
sample found its main thread in a timer callback, with file opens, JSON parsing,
string processing and GC. The sample did not resolve JavaScript function names,
so it does not independently identify the dashboard callback.

A read-only probe of the real loader against approximately 13 MB of local history,
using a nonmatching session and the current request time, returned no entries.
Three Node measurements were 3522, 3327 and 3952 ms. After the scoped change,
measurements were 798, 3 and 3 ms. These exploratory measurements include cache
and concurrent-load effects; they are not a controlled speedup claim or a formal
Benchmark. No provider calls were needed for the probe.

## Reproducible regression boundary

`tests/extensions/workflows/dashboard.test.ts` exercises the real dashboard with
Node mock timers and filesystem call observation. Against the baseline, ten
animation ticks plus returning from detail read history eleven times, and opening
an overview read both side artifacts. With the fix, steady ticks and navigation
perform neither historical reads nor directory scans. A persisted transcript is
loaded when opened and reused on render. Completion is still read once from the
canonical record after its live owner leaves; newly retained runs are surfaced,
and excluded old retention entries are not retried on every tick.

The fix caches history only for the dashboard instance lifetime, uses live
in-memory projections for progress, and filters raw record metadata before
normalizing unrelated history. Reopening the dashboard refreshes the disk snapshot.
Reports explicitly hydrate their selected run. No persisted format or model tool
contract changes.

## Interpretation and limits

Synchronous multi-second work at animation cadence is sufficient to block the
shared JavaScript thread and delay keyboard handling. Separating stable animation
from historical loading removes this reproduced cause. It does not establish that
all ordinary conversation-view lag has the same cause.

Initial history discovery still reads workflow metadata synchronously once;
opening a large historical transcript can still incur a one-time load. Historical
changes from other processes become visible on reopening the dashboard. This
record does not claim real-terminal acceptance after reload, release publication,
or elimination of every performance bottleneck. Private sessions, transcripts and
raw process samples remain outside the repository.
