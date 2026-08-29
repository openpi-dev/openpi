# Engineering disciplines

This ledger is append-only. Add a new `OP-*` row at the end; do not renumber,
rewrite, or delete an earlier row. The checker enforces consecutive IDs and
verifies every referenced command. `CI=yes` means the command is directly or
transitively reached from the workflow's `bun run check` or `bun run test`.

| ID | Promise | Status | CI | Check |
| --- | --- | --- | --- | --- |
| OP-01 | Package configuration has one canonical setup entry point | enforced | yes | `bun run check` |
| OP-02 | Persisted config fields are wired to the typed setup writer | enforced | yes | `bun run check:config-contract` |
| OP-03 | Persisted config fields appear in the status projection | enforced | yes | `bun run check:config-contract` |
| OP-04 | Persisted config fields are documented in README and SETUP | enforced | yes | `bun run check:config-contract` |
| OP-05 | Discipline ledger references valid checks wired into CI | enforced | yes | `bun run check:discipline` |
| OP-06 | Child tool classification fails closed | enforced | yes | `bun run test` |
| OP-07 | Pi host packages remain peer dependencies | enforced | yes | `bun run test` |
| OP-08 | Node and Vitest suites remain non-empty | enforced | yes | `bun run test` |
| OP-09 | Repository formatting is checked | enforced | yes | `bun run format:check` |
| OP-10 | Lint warnings fail the validation round | enforced | yes | `bun run lint` |
| OP-11 | TypeScript is checked without emitting files | enforced | yes | `bun run typecheck` |
| OP-12 | Runtime provenance is verified before diagnosis | manual | no | `bun run provenance` |

`manual` rows are intentional: they document a contributor action that cannot
be proved by a repository-only check without changing the installed Pi state.
