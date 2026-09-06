# Workflow child failures and capability inheritance

- Status: validated for private run inspection and local regression reproduction; live provider acceptance tracked separately below
- Created / verified: 2026-09-07
- Observed runtime: `c8f2c13d49f2e6cd3b389dfff72ccc2eaca970c1`, the unique OpenPI source returned by `pi list`
- Repair base: `a7455cd378ef7befa9c7cf099c1fa1e4ee5dc3e3`
- Issue: [#424](https://github.com/openpi-dev/openpi/issues/424)
- Related performance repair: [#420](https://github.com/openpi-dev/openpi/issues/420), [PR #422](https://github.com/openpi-dev/openpi/pull/422)
- Supersedes: none

## Observed failures

Three private Workflow runs used eight audit shards. Their parent Session cwd was the home directory, while the prompts named a different Git checkout.

| Provider / model | Observed evidence |
| --- | --- |
| Cursor / cursor-grok-4.6-high-fast | Eight children rejected `partialToolCall` in chat-only mode; zero tool results; 18.6 seconds total |
| openai-codex / gpt-5.6-luna | Eight children ended with OpenPI's model-progress timeout; 141 tool results, 53 marked errors; 625.9 seconds total |
| seal / gpt-5.6-sol | Three HTTP 429 account-rate-limit errors, five aborted children; 140 tool results, 31 marked errors; 41 seconds total |

The abort initiator for the last five children is unknown. The first two scripts returned application-level `ok:false`; runtime `completed` means the scripts returned, not that the audit succeeded. The Codex children ran tools before timing out, so this was not solely a startup failure. No evidence establishes that eight concurrent children always fail or identifies the account's exact rate ceiling.

Private Session transcripts, credentials, role files, and raw Workflow records remain outside Git. This is a diagnostic record, not a public Benchmark or an archive of those private records.

## Reproduced mechanisms

1. The original Cursor adapter deliberately disabled tool transport and rejected tool-call events. Changing role assignments to a listed Cursor model could pass model resolution but still fail every tool-using child.
2. The user's custom `explorer` role listed only filesystem discovery and structured read-only Git tools. It had no Bash or network tool even though the task required live GitHub inspection. A model fallback does not change an explicit role tool list.
3. Git tools use execution cwd. The actual `runGit` implementation failed from home with “not a git repository” and succeeded from the repository. A path in natural-language instructions did not change Workflow cwd.
4. Empty Pi settings resolved native HTTP idle timeout to 300000 ms, but OpenPI imposed a separate 45000 ms model-visible-progress timeout. The two clocks measure different events: transport activity and retries can be silent in model output. A deterministic runner test advancing 46000 ms failed before the repair because abort was invoked, then completed successfully after removal of the additional clock.
5. Dashboard animation previously synchronously hydrated retained history every 120 ms. That independent event-loop problem was repaired in PR #422. Its contribution to each historical child timeout was not measured.

## Repair contract

Pi remains the provider/tool/lifecycle owner. Cursor advertises only Pi's supplied tool definitions through namespaced MCP descriptors. Matching Cursor calls become ordinary Pi tool calls; Pi executes them with its normal hooks and returns results through the next provider request. Cursor-native shell, edit, web, task, and unknown tool identities are not a second execution path. Approval probes do not execute tools.

Built-in roles inherit the parent's currently active child-eligible tool surface. An explicit custom role allowlist intersects it, and parent-only exclusions remain enforced. Active-tool visibility is not a filesystem sandbox or permission ledger. The read-only wording of an investigator role is task guidance in normal mode; Plan Mode remains a runtime restriction. Existing custom role files are preserved, so old explicit explorer lists remain restricted until the user deliberately edits them. Merely updating OpenPI will not remove a user's custom restriction.

Workflow `working_dir` resolves relative to the parent cwd and is validated before model invocation. Target-project resources use the target's trust decision; access to another directory does not imply trust in its extensions. Cwd and tool projection participate in operator and replay identity, and worktree operations use the selected repository. Inherited built-in calls run for real on resume; explicit bounded read-only custom calls retain the existing replay filesystem boundary.

Ordinary and Workflow children rely on Pi's native transport timeout/retry behavior. Quiet thinking, tool work, and retry backoff are not terminated by an extra 45-second output clock. Explicit cancellation and session disposal deadlines remain bounded. A 429 may still fail after native retries; concurrency configuration is a ceiling, not a provider account capacity claim.

## Validation and remaining limits

The local targeted timeout/lifecycle suite covers quiet turns beyond the former deadline, native provider error preservation, explicit cancellation, late completion, and bounded disposal. Capability tests cover parent intersection, missing eligible tools, selected cwd, target trust, invalid cwd before model invocation, replay behavior, and alternate-repository worktree cleanup.

Cursor transport fixtures use local HTTP/2 and exercise Pi tool execution and result resumption. They cannot alone prove the live Cursor service accepts the protocol. `bun run check` passed. The complete repository-discovered suite passed with Node file concurrency 2 (1435 passed, one platform skip) and Vitest (30/30). A default-concurrency run hit the existing Setup subprocess 8-second startup deadline under host load; that unrelated test was not modified. Two independent diff reviews reported no actionable findings. Live smoke receipts follow below. Merged source, an installed release, and the user's currently running Pi Session remain separate acceptance boundaries.

### Live Cursor smoke receipt

On 2026-09-07, an isolated Pi agent directory reported this repair worktree as its single OpenPI source. The user's configured runtime remained `c8f2c13`; no role file or user package setting was changed. The smoke used the existing authenticated Cursor account, with credentials kept private, and `cursor-grok-4.6-high-fast`.

| Scope | Result | Elapsed |
| --- | --- | --- |
| Native Pi Agent, one in-memory nonce tool | One tool execution, two provider requests, exact returned nonce | 9.4 s |
| Real Workflow `runAgent`, `read` plus `bash` | Read an absolute file outside cwd; Bash returned selected cwd and fetched Example Domain over HTTPS | 27.3 s |
| Eight concurrent real Workflow `runAgent` sessions | 8/8 successful; each executed one read, completed two model turns, and returned the correct external-file nonce | 12.0 s total |

These are bounded connectivity/lifecycle acceptance runs, not model-quality or throughput Benchmarks. The eight-child smoke invoked the production runner concurrently; selected-cwd DSL propagation is separately covered by execute-level tests. It does not prove long 44-PR audits fit provider rate limits, automatic choice of the right tool, every Cursor model, or the user's older custom role configuration. Cursor does not report complete usage, so zero provider counters are unknown accounting rather than a claim of free execution.
