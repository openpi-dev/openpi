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

- [`0003-local-web-browser-entry.md`](0003-local-web-browser-entry.md) — direct local browser entry with authenticated APIs and isolated document bootstrap ([#448](https://github.com/openpi-dev/openpi/issues/448)).

- [`0004-capability-name-discovery.md`](0004-capability-name-discovery.md) — named delegate/workflow discovery with model-owned execution judgment and unchanged authority ([#655](https://github.com/openpi-dev/openpi/issues/655)).

- [`0005-supported-pi-versions.md`](0005-supported-pi-versions.md) — proposed minimum/locked/latest host verification and the boundary of the open-ended peer range ([#328](https://github.com/openpi-dev/openpi/issues/328)).
