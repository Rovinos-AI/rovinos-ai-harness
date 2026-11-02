# ADR 0004: OAuth discovery egress policy

- **Status:** Draft — owner review required before implementation
- **Date:** 2026-11-02
- **Decision owners:** Maintainers; approval pending

## Context

`resourceAdvertisesClientCredentials()` in `packages/mcp/src/oauth/protected-resource.ts`
uses native `fetch` with automatic redirects and reads protected-resource metadata without a
byte limit or an operation deadline. Its optional abort signal and `credentials: "omit"` do not
bound redirects, body size, or the destination reached after a redirect.

The sandbox egress proxy already checks exact host/port entries, resolves and rejects disallowed
addresses, and connects to a validated address. That enforcement is specific to the sandbox
runner's network path. It is not a shared policy interface for the MCP process, and importing
`@rovinos/sandbox` into `@rovinos/mcp` would violate the current package layers. The OAuth
discovery helper therefore needs an approved shared policy/transport contract before
implementation.

This ADR is a design proposal only. It does not approve an API, change runtime behavior, or
authorize implementation before owner review.

## Proposed decision

Route each OAuth discovery HTTP hop through one shared egress-policy transport. The policy must
be enforced by the component that opens the connection, not by a hostname check performed before
an unconstrained `fetch`. The MCP helper should receive this transport as a dependency and retain
responsibility for parsing discovery responses and deciding whether the advertised extension is
present.

The shared contract must let the caller:

- submit exactly one HTTP request, with redirects disabled, under a selected network profile and
  operation deadline;
- receive a streamed response so the caller can enforce a byte budget while reading;
- distinguish an allowed connection from a policy denial using closed, destination-free error
  codes; and
- cancel DNS, connection establishment, response streaming, and redirect handling with the same
  operation signal.

The transport must resolve and validate a destination, then connect to that validated address
without performing a second hostname resolution. TLS must still use the URL hostname for SNI and
certificate verification. A separate `check(hostname)` followed by ordinary `fetch` is
insufficient. The interface location and exact type shape require maintainer approval; it must
not add a forbidden `mcp` → `sandbox` dependency or turn the sandbox-specific allowlist into an
implicit global policy.

## Network profiles

| Profile | Proposed behavior |
| --- | --- |
| `production` | Default for deployed harnesses. Require HTTPS, reject URL credentials and unsafe/special-use destinations, and require every initial and redirect destination to pass deployment egress policy. A redirect does not inherit permission for a new host or port. |
| `internal` | Explicitly selected by deployment configuration. Permit configured internal hosts and address ranges, including legitimate private MCP services, while continuing to reject unconfigured destinations. Keep loopback, link-local, multicast, unspecified, and cloud metadata destinations denied unless a separately reviewed exception is provided. |
| `local-development` | Explicit opt-in, unavailable as an implicit production fallback. Permit HTTP only for loopback development endpoints; apply the same redirect, byte, and time limits. Do not generalize this exception to arbitrary private or link-local addresses. |

The policy should support exact host/port entries and explicit internal address ranges rather than
blanket rejection of internal networks or wildcard host entries. Mixed DNS answers fail closed:
every returned address must be allowed. The profile and allowlist must be configuration, not
inferred from the URL or from a redirect. Do not infer this profile from the existing MCP server
`trust: internal` setting: that setting controls trace propagation and annotation use, not network
authorization.

## Redirect and resource bounds

Use the existing `web.fetch` bounds as the initial proposed defaults, subject to owner approval:

- at most **5 redirects across one complete discovery operation**;
- at most **20 seconds total**, including both discovery requests, DNS, connection setup,
  redirects, and response-body reads; and
- at most **2 MiB of metadata body bytes per discovery operation**.

Follow redirects manually, one hop at a time. Parse each `Location` against the current URL and
re-run scheme, profile, allowlist, DNS/address, and connection checks before making the next
request. Reject HTTPS-to-HTTP downgrade outside the explicit loopback development profile.
Redirect loops terminate at the redirect limit.

Count bytes from streamed chunks; `Content-Length` is only an early rejection hint, never the
enforcement mechanism. Cancel a response when the aggregate body cap is exceeded. Redirect
response bodies are not metadata and should be cancelled rather than buffered. Apply the same
deadline and redirect budget to the initial protected-resource request and the metadata-hint
request, not a fresh budget for every hop.

Continue omitting credentials and do not forward authorization, cookies, or other sensitive
headers to a redirected origin. Preserve existing issuer/resource binding. Never include request
URLs, query strings, headers, tokens, metadata bodies, or upstream error text in logs, spans, or
error messages; diagnostics use bounded codes only.

## DNS-to-connection boundary and remaining limitation

Application-level URL and DNS checks alone cannot prevent DNS rebinding if the HTTP client resolves
the hostname again while connecting. The approved transport must bind the validated resolution
to the socket actually used for that hop, retain TLS hostname verification, and fail closed if
resolution changes or includes a disallowed address. The deployment must also prevent the MCP
process from bypassing the enforcing transport or its network egress boundary.

The current sandbox proxy provides connection pinning for traffic routed through the sandbox
runner. It does not constrain direct network requests made by the MCP process. Until a shared
transport is implemented and the MCP process's deployment route is enforced, this design cannot
claim DNS-rebinding protection for OAuth discovery. A native `fetch` preflight check or a proxy
environment variable without verified enforcement is not an acceptable substitute.

## Validation required after approval

Implementation should add adversarial tests for:

- loopback, private, link-local, IPv4-mapped IPv6, and mixed public/private DNS answers under all
  three profiles, including explicit internal and loopback exceptions;
- a DNS-change fixture proving the socket uses the validated address and does not resolve again;
- redirect loops, the redirect limit, HTTPS downgrade, disallowed redirect destinations, and
  cross-origin redirect handling;
- oversized and chunked metadata without `Content-Length`, byte-budget cancellation, operation
  deadline expiry during resolution and body reads, and caller cancellation; and
- canary assertions that credentials, headers, query strings, URLs, and metadata content are
  absent from logs, spans, and error text.

Run the applicable GitHub Actions `static`, `unit`, `integration`, and `gates` checks for the
implementation. **(verify)** The issue's former Azure stage names map to these same-named GitHub
Actions jobs; the Azure pipeline was retired. This design-only change adds no tests and does not
claim these checks have run.

## Alternatives considered

1. **Validate the hostname before native `fetch`.** Rejected: the fetch implementation may resolve
   the hostname again at connection time, leaving a DNS-rebinding gap.
2. **Reuse the sandbox egress proxy directly from MCP.** Rejected as the interface: the proxy
   currently enforces the sandbox runner's route only, is not in the MCP package's allowed import
   layers, and does not by itself define production, internal, and development profiles for OAuth.
   A shared transport may reuse reviewed enforcement logic after its contract and deployment
   topology are approved.
3. **Reject all private and internal addresses.** Rejected: legitimate internal MCP deployments
   need an explicit, narrow exception rather than blanket rejection.

## Scope and approval gate

This draft changes documentation only. Owner review must approve the shared egress-policy
interface, profile defaults, resource limits, and deployment enforcement boundary before runtime
code, tests, changesets, or a task-completion marker are added.
