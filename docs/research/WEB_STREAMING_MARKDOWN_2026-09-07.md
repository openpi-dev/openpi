# Web streaming Markdown reuse

- Status: validated for the deterministic component regression below; not a timing benchmark.
- Created and verified: 2026-09-07.
- Source boundary: main `5262158264803d4c7b260e1596c3a7ae69d91cb2` after React migration #384, and the scoped Markdown memoization tracked in [Issue #434](https://github.com/openpi-dev/openpi/issues/434). Final implementation and CI revision are linked from that Issue's PR.
- Supersedes: none.

## Observation and repair

A stream update changes Transcript's live entries and rebuilds rendered row elements. Without a component reuse boundary, unchanged historical Markdown enters the actual `react-markdown` parser again. The regression mounts the real Transcript and wraps, rather than replaces, the real Markdown renderer to count invocations.

For 24 mounted historical assistant replies and eight same-key live text updates:

| Invocation count | Before | After |
| --- | ---: | ---: |
| Initial history | 24 | 24 |
| History during eight updates | 192 | 0 |
| Initial and updated live reply | 9 | 9 |
| Total | 225 | 33 |

The failing baseline reported 216 historical invocations where only 24 initial invocations were expected. React `memo` on the Markdown component, using the existing string prop and default comparison, removes the repeated history work. The test also verifies unchanged snapshot reconstruction, same-key historical corrections, Session changes and remounting. Updated content still renders, and remounts parse again; no global content cache is introduced.

## Compatibility and limits

Only Markdown rendering reuse changes. Sanitization, GFM, soft breaks, URL checks and link-only image projection remain intact. The enclosing Transcript still updates tool evidence, actions, execution state and scroll position. Model-visible context/tools, permissions and persisted Session/configuration data are unaffected.

This is an invocation-count regression, not a browser timing or memory benchmark. It does not establish an end-to-end speedup, reduce the production bundle, eliminate list reconstruction or avoid parsing a growing live reply. React can legitimately render again after remounting or other lifecycle changes. A future change that gives Markdown additional inputs must retain React's normal prop comparison or explicitly account for those inputs.

Reproduce the focused evidence with `bunx vitest run tests/web/markdown-streaming.spec.ts tests/web/app-render.spec.ts`. Required full checks and browser/CI receipts belong to the linked PR; a package build or merge does not establish installed-runtime acceptance.
