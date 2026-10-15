# Browser-compatible Web Host ports

- Status: validated source and isolated transport observation
- Created / verified: 2026-10-07
- Source: `origin/main` at `3cb2ecfe1bfbb98252651885311d309f83749428`
- Issue: [#694](https://github.com/openpi-dev/openpi/issues/694)
- Supersedes: none

## Verified facts

The original `WebHost.start()` retained any OS-assigned TCP port. An isolated
Node HTTP listener successfully bound `127.0.0.1:6000`, while native Fetch
rejected its URL with cause `bad port` before HTTP dispatch. A full Windows
test run also encountered that Fetch error after automatic Host allocation.
[Fetch port blocking](https://fetch.spec.whatwg.org/#port-blocking) applies to
HTTP(S) even when the TCP listener is healthy.

## Fix and verification boundary

`listenBrowserPort` rejects explicitly configured blocked ports. Automatic
allocation closes blocked listeners and retries at most eight times before
reporting failure. Readiness is published only after a usable port is retained.
Deterministic transport tests cover rejection, retry with a real listener and
Fetch request, exhaustion cleanup, and original bind errors. These are isolated
source tests, not installed Pi, live model, or graphical browser acceptance.
No new runtime authority or persisted configuration is introduced.
