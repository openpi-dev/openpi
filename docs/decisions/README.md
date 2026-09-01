# Decision records

Decision records capture project choices that constrain future implementation. Research and design records may recommend a choice, but only an accepted Decision adopts it.

## Adoption states

- `proposed`: under review and not authoritative;
- `accepted`: adopted within the stated scope;
- `rejected`: considered and explicitly not adopted;
- `superseded`: historical Decision replaced by a linked successor.

Decision adoption is separate from evidence validation. Record the supporting evidence boundary, credible alternatives, consequences, owner, related Issues and PRs, and replacement relationship.

Start from [`TEMPLATE.md`](TEMPLATE.md).

## Records

- [`0001-documentation-and-evidence-governance.md`](0001-documentation-and-evidence-governance.md) — repository knowledge categories, evidence states, and publication boundaries.
- [`0002-native-skill-lifecycle.md`](0002-native-skill-lifecycle.md) — use Pi's native Skill loading and Session lifecycle without an OpenPI body-recovery layer.
