# OAuth model providers

This extension registers two opt-in model providers backed by account OAuth:

- `google-antigravity` uses Google Cloud Code Assist and supports ordinary Pi
  tool calls.
- `cursor` uses Cursor AgentService and is experimental, chat-only support.
  It does not advertise or execute Cursor-native coding tools. If the server
  requests one, the request fails explicitly instead of bypassing Pi's tool and
  permission lifecycle.

After installing OpenPI, restart Pi or run `/reload`, then authenticate and
select a model:

```text
/login google-antigravity
/login cursor
/model
```

For source-checkout testing, follow the repository's
[development runtime provenance procedure](../../README.md#开发运行时区分-npm-与当前源码).
Remove any previously installed OpenPI source, install the checkout, and verify
that `pi list` reports this checkout as the only OpenPI source before reloading
Pi. Do not mix an installed OpenPI package with an explicitly loaded checkout
extension, because that does not prove which source owns the runtime behavior.

```sh
pi list
OLD_OPENPI_SOURCE=/absolute/path/to/old/openpi
pi remove "$OLD_OPENPI_SOURCE"
pi install "$PWD"
pi list
```

The model catalog is refreshed from the authenticated account and persisted by
Pi. A failed refresh retains the last successful account catalog; Antigravity
also has a validated static baseline, while Cursor keeps the server-side `Auto`
route as its baseline. No provider is contacted until it is selected.

Pi's interactive clipboard flow inserts an image's local path into the editor.
When Cursor is selected, a supported PNG/JPEG/GIF/WebP path at the start of an
interactive prompt is converted into an actual image attachment (up to 10 MiB)
before the request is sent. The absolute path is not exposed to the model.

The provider also adds an explicit chat-only rule so the normal Pi coding
system prompt cannot cause Cursor to attempt unavailable read or shell tools.

Cursor's token delta describes generated output only, so the provider does not
publish it as complete context usage. Pi 0.84.3+ can estimate an all-Cursor
history and trigger threshold compaction without provider usage. Older Pi hosts
retain the correct unknown-usage state but cannot automatically threshold-
compact a session with no usage-backed response. Project-wide Pi baseline
tracking is kept in [#328](https://github.com/openpi-dev/openpi/issues/328).

Cursor model discovery and chat use HTTP/2. They honor `PI_PROXY_CURSOR`, then
`PI_PROXY`, the standard `HTTPS_PROXY`/`HTTP_PROXY` variables, and `ALL_PROXY`;
`NO_PROXY` bypass rules apply. The proxy must support HTTP CONNECT and preserve
HTTP/2 ALPN negotiation to Cursor.
