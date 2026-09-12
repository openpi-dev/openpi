---
decision-status: accepted
created: 2026-09-07
last-reviewed: 2026-09-07
applies-to: OpenPI loopback Web workbench; implementation based on 88a6530
owner: OpenPI maintainers
related-issues: "#448"
related-prs: none
supersedes: none
---

# Decision 0003: Direct browser access to the local Web entry

## Context

The maintainer requested that any browser on the user's computer can use the terminal-displayed loopback address without a pairing code or a token copied from an automatically opened tab. Previously the public shell rendered while API requests failed, producing apparently inert workspace controls. [Issue #448](https://github.com/openpi-dev/openpi/issues/448) tracks the reproduction and implementation.

## Decision

The production root document issues the current Host's ephemeral bearer credential in a dynamically generated HTML meta element. This establishes local document access as the bootstrap boundary; token possession is no longer a separate browser-pairing requirement. API endpoints retain bearer authentication. The server remains bound to the exact canonical 127.0.0.1 address and port.

The root rejects foreign Origin/Referer, cross-site and same-site Fetch Metadata, and non-document/non-navigation destinations when provided. Its Origin requirement does not inherit API allowedOrigins exceptions. Missing metadata is permitted for legacy clients and local HTTP tools; local programs are within the local-machine trust boundary. Browser same-origin isolation, no CORS grant, no-store, CSP frame-ancestors, DENY framing, same-origin resource/opener policies and nosniff remain complementary protections. No ambient cross-port cookie is introduced.

Clients prefer the current document credential over stale fragment or tab storage, strip fragment credentials, and treat storage as optional. Legacy fragment entry remains available for the separate Vite development server. No credential is inserted into static build artifacts, resource URLs, or new logs. A page reload after Host restart obtains its new credential; in-flight pages do not silently replay failed mutations.

## Evidence boundary

Host tests distinguish document navigation from fetch metadata and verify credential denial, including an API-allowed foreign origin. Client tests cover stale credentials and unavailable storage. Production browser tests use independent clean contexts and the bare address. These tests do not claim protection against a malicious browser extension, a compromised local process or an XSS vulnerability in trusted same-origin code. CI and final implementation identity are linked from the Issue.

## Alternatives considered

Manual pairing and fragment-only links conflict with the approved entry experience. Removing API authentication broadens the boundary unnecessarily. Cookies are shared across ports and introduce ambient authority to this local control surface. A bootstrap proxy through Vite would need a separate reviewed trust boundary and is not introduced.

## Consequences

The printed local address works in a newly opened browser. Cross-site links or embedded views may be denied; the user can type the canonical address directly. LAN, remote authentication, arbitrary loopback aliases, automatic mutation retries, and startup performance are outside this decision.

## Amendments

None.
