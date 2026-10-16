# Decision Examples and Common Traps

These examples generalize observed maintenance problems. They are not mandatory solutions or universal thresholds.

## Automatic output and snapshots

**Situation:** a test demands an exact sequence of automatically chosen route coordinates. A shorter valid route fails it.

Separate user-authored ports, positions and paths from algorithm-selected bends. Automatic choices can usually be checked through connectivity, port direction, obstacle avoidance, readability or bounded work; preserve explicit constraints. Verify the assertion against a valid alternative and the original bad route.

Some snapshots remain valuable. Public serialization, protocol bytes, generated-source consistency and promised deterministic output can require exact comparison. Regenerating golden files establishes consistency, not visual quality.

## Shared rule matrices

**Situation:** 22 icons are each rendered through five entrypoints.

If the entrypoints actually share the drawing function and rules, exercise the complete catalog through one real path and retain default, override, hiding and local special cases at each entrypoint. Check schema, preprocessing and layout branches; retain combinations with distinct handling. Identical parameter names do not justify cutting a cross-product.

The same reasoning applies to locales, providers, codecs and runtime versions: distinguish shared rules from real interactions. Disclose combinations no longer traversed rather than claiming identical coverage.

## Source assertions and architecture rules

**Situation:** a test meant to prevent missing release files only searches source code for filenames.

A stronger check untracks or removes required inputs in a temporary repository and observes explicit rejection without output creation. If behavior protection already exists, remove the source assertion without adding a replacement merely to preserve test count.

Static checks can enforce real architectural or safety constraints, such as preventing database imports in a restricted layer or excluding files from a release package. Check dependency relationships or artifact facts rather than import formatting, private names or incidental call counts.

## Semantic identity and incidental representation

**Situation:** a delivery receipt returns a Windows long path while the test fixture uses an 8.3 alias for the same file, a workflow test fails after its dependency list is reordered, an exact-byte comparison fails only under inherited tool configuration, or a checkout check accepts or rejects a tree because of a directory-name substring.

Choose equality from the contract. For an existing output, resolve paths with appropriate native semantics or compare file identity; still reject the wrong target. A directory-name substring is not checkout identity. Compare the checkout's real path, and still reject zero matches, several matches, and a match that is not this checkout. Parse workflow dependencies and assert required relationships rather than YAML formatting or irrelevant order. Keep exact spelling, ordering or bytes when the public contract promises them. Normalization must not hide distinct case-sensitive files, symlink restrictions or authored-path preservation requirements.

When an exact-byte, exact-environment, or exact-process assertion fails, inspect inherited tool configuration, such as a filesystem monitor, an untracked-file cache, locale, or umask, before calling the failure a product regression. Re-run that check once with the configuration neutralized. If the semantic contract holds only after neutralization, rewrite the assertion and run it with the inherited setting still active, or pin the fixture's configuration when the exact bytes or process behavior are themselves contractual. State both outcomes. Neutralization is diagnostic: do not require a change to the developer's own configuration, and a neutralized pass does not prove the product leaves user state untouched while the inherited setting remains active.

## Failures and shared mistakes

**Situation:** AI-generated implementation and tests agree, but the business result is wrong.

Establish expectations from user examples, compatibility fixtures or an independent calculation. Copying the production algorithm into expected-value generation does not provide an independent oracle. Identify the observable mistake the regression must catch.

**Situation:** a historical test fails.

Compare with the baseline in the same environment to separate existing failures from regressions. Changed requirements call for updated contracts and assertions; product regressions call for implementation fixes; environment failures call for environment repair and visible reporting. If the same check passes only after inherited tool configuration is neutralized, apply the semantic-identity decision above rather than editing the developer's own configuration or treating the neutralized run as the product result. A cumbersome test is not, by itself, a reason to ignore its failure.

## Unstable waits and performance

**Situation:** an asynchronous test fails intermittently and turns green on retry.

Prefer real readiness signals and inspect ownership and cleanup. Distinguish a product race from a test timing assumption. Timeouts should reflect the protected deadline and execution environment: an unreasonable test timeout can be widened, while a contractual product deadline still needs coverage. Widening does not apply when the failure is an unmet precondition before the measured phase. Quarantine needs a reason, replacement protection and a clear restoration condition; it is not a pass.

**Situation:** a test for persisting network-failure backoff also requires a fresh subprocess to start and finish within a tiny deadline, or two named deadlines are both derived from one timeout input.

Separate failure-state persistence from hard process-deadline enforcement when they are independent contracts. Deadlines derived from the same input are one budget, even when their names differ. A test of that shared budget shows which contract failed only when it observes the earlier event before the deadline: drive the first observation deterministically, then let the later wait hit the remaining budget. Widening the shared duration does not separate the contracts. Exercise real cancellation and persisted state at the cheapest effective layer, and retain a real process check for deadline enforcement. Preserve an integration case where startup or cache preparation consumes the same deadline budget: separate unit tests cannot establish that those phases compose correctly. Injecting a controlled startup delay can distinguish an incidental speed assumption from a genuine deadline-accounting bug.

**Situation:** sharing a browser page or extracted package reduces setup time.

Check storage, globals, timers, network, files and cleanup for isolation. Start rejection cases from clean inputs. Reuse must not conceal leaks when cleanup is part of the behavior under test. A faster case does not establish a faster parallel pipeline.

## Test doubles and test layers

Cheap, controllable tests suit pure rules and fault injection. Packaged relative paths, filesystem casing, browser layout and real process lifecycles need corresponding environments. Preserve necessary integration paths without sending every rule through the UI or public CLI.

Mocked filesystem success does not establish Windows support; skipped Chrome tests do not establish browser acceptance; generated screenshots do not establish readability. Report these as separate claims.

## Implementation and pre-commit review

**Ordinary bug fix:** find existing coverage and extend it with an input reproducing the user's failure. Avoid expanding the task into a test-system redesign.

**Copy-only change or equivalent internal refactor:** reuse existing protection and run affected checks when needed. Do not manufacture string assertions to give every commit a new test.

**Rare output-loss or permission failure:** low frequency does not mean low value. Improve fixtures and scheduling while preserving assertions that distinguish the actual failure.

**Request for faster feedback:** prefer targeted checks and applicable existing evidence. Shortening the local loop does not remove required release checks or authorize committing, pushing or publishing.
