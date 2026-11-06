---
name: semantic-navigation
description: Resolve symbol definitions or references when text search is ambiguous, or compare a file's language-server diagnostics before and after an edit, using an existing local stdio language server.
---

# Semantic navigation

Use Pi's ordinary `bash` tool to run the adjacent `scripts/semantic.mjs` client on demand. The model chooses the question, files and timing; each invocation starts and stops one language server.

Use an already installed server whose command and arguments are established by the project or user. Starting it executes local code with the authority of ordinary Bash. The client sends navigation and diagnostic requests, but is not a sandbox for the server. Pi's tool permissions and Plan Mode policy still apply; Plan Mode does not allow this Node command.

## Run a query

Read the command schema from `node <this-skill-directory>/scripts/semantic.mjs --help`. Send one JSON request on stdin, using a quoted heredoc to preserve literal paths and arguments. Set a Bash timeout longer than the request timeout so the client can finish cleanup.

```sh
node /absolute/path/to/semantic-navigation/scripts/semantic.mjs <<'JSON'
{
  "operation": "definition",
  "root": "/absolute/project",
  "server": {"command": "/absolute/path/to/server", "args": ["--stdio"]},
  "document": {"path": "src/example.ts", "languageId": "typescript"},
  "position": {"line": 12, "column": 8},
  "timeoutMs": 15000
}
JSON
```

Positions supplied to the client are one-based UTF-16 line/column coordinates; returned LSP ranges are zero-based. For `references`, choose `includeDeclaration` explicitly. Use the server's returned URI and range as evidence, then read the target source. A completed empty result means this server returned no locations; it does not prove that no references exist.

The client installs nothing and edits no source. If the server is unavailable, the requested capability is unsupported, or the request fails, retain that outcome and use available source-reading tools. Report the request outcome and process lifecycle separately: a response can complete even when shutdown is abnormal.

## Compare diagnostics

Use `operation: "diagnostics"` for a single-file pull-diagnostics snapshot. Save the returned `snapshot` before editing and collect another afterward with the same root, server and document. Compare them with `operation: "compare"`, supplying the snapshot objects as `before` and `after`.

Interpret the full comparison, including ambiguous groups and both sets of locations. When text changed, identical diagnostic messages can describe different occurrences. A newly observed or resolved diagnostic is an observation, not proof that the edit caused or fixed it.

These snapshots bind the opened text and server identity; they do not freeze project dependencies, configuration or other files. Keep those inputs stable for a useful comparison and disclose changes you know about. A full report covers the requested document only. Unsupported, incomplete, failed or incompatible evidence stays unknown; even an empty full report is not a whole-project check.
