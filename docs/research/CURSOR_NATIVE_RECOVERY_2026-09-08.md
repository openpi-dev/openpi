# Cursor native request recovery

- Status: validated at the boundaries below; exploratory acceptance, not a Benchmark.
- Created / verified: 2026-09-08.
- Implementation source: `fcee687712220c8c32a18a6c334eb2b9f98a857c`; baseline: `993fd8e22ff5c7495c1b5c19f9d64c0b6b97c252`.
- Related Issue: [#234](https://github.com/openpi-dev/openpi/issues/234).
- Supersedes: none.

## Finding and source

The previous provider terminated a tool-enabled turn upon seeing a Cursor-native UI tool preview. It also terminated after replying to an unsupported native execution request. These are different protocol events: a preview does not authorize execution, and rejecting one exec need not terminate AgentService/Run.

[OMP's sendExecClientThrow implementation](https://github.com/can1357/oh-my-pi/blob/daf07999c2fee9b22edc7bf8fea1fb6272e0df5e/packages/ai/src/providers/cursor.ts#L2552) sends an in-band exception followed by a per-exec stream close. Its implementation comments identify this as the executor's no-handler path, allowing the server to surface the failure to the model. This informed the scoped fix; OMP's broader native-tool mapping was not adopted.

## Implemented boundary

With Pi tools advertised, previews are ignored and actual unsupported native execs receive the existing UNIMPLEMENTED reply plus exec stream close. The model can then request an advertised Pi MCP tool. Native tools are never executed. The fourth rejected native exec in one provider call ends the call with an explicit recovery-limit error. Malformed or unauthorized MCP requests still fail closed; chat-only behavior is unchanged.

Only the caller's AbortSignal establishes caller cancellation. A server error containing “aborted” or “canceled” remains an error, and its original message is settled before closing the HTTP/2 stream can replace it with a secondary abort event.

## Deterministic verification

New regression tests failed against the previous behavior and pass with the fix. They cover native previews and rejection followed by a complete Pi tool/result turn, bounded rejection including a late valid MCP frame, caller cancellation, and preservation of a server cancellation error.

- Cursor suite: 30 passed.
- `bun run check`: passed.
- `bun run test`: Node 1,465 passed, 1 skipped; Vitest 113 passed; no failures.

## Live exploratory acceptance

Both runs used the actual `makePiBackend` and SDK `createAgentSession`, with an isolated Pi configuration listing only this worktree as its OpenPI source. Existing Cursor credentials were supplied in memory. Child tools were limited to `read` and `bash`, with an untrusted synthetic cwd containing a random nonce file. The verifier compared the final text to the nonce after both tools completed. The native scenario explicitly asked the model to try native `read_file` first and recover through Pi if rejected.

| Scenario | Model | Elapsed | AgentService requests | Native rejections | Result |
| --- | --- | --- | --- | --- | --- |
| Ordinary Pi tools | cursor-grok-4.6-high-fast | 10.361 s | 2 | 0 | Completed; read and bash succeeded; exact nonce |
| Native request recovery | cursor-grok-4.6-high-fast | 15.507 s | 2 | 1 | Completed; read and bash succeeded; exact nonce |

Outbound protocol instrumentation counted the rejection; it did not infer recovery from prose. Each run had a 140-second outer bound and scoped backend disposal. Normalized receipts are preserved in [the adjacent JSON file](CURSOR_NATIVE_RECOVERY_2026-09-08.receipts.json). Two earlier harness setup attempts failed before any model request because isolated authentication was initially wired incorrectly; they are infrastructure setup failures, excluded from the two acceptance runs.

## Limits

This is two exploratory runs on one model, not a reliability or performance measurement. It does not establish long-task, fan-out, or all-model acceptance. Proxy tunnel timeouts and remote connection aborts remain separate transport failures. The fix neither proves nor assumes intentional third-party blocking by Cursor. Repository validation and live isolated acceptance do not mean the change is merged, released, or installed in the user's regular runtime. Credentials and private Session transcripts are not part of the published evidence.
