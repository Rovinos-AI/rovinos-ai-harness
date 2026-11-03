# ADR 0005: OAuth discovery egress policy

- **Status:** Accepted
- **Date:** 2026-11-03
- **Decision owners:** Maintainers

## Context

`resourceAdvertisesClientCredentials()` in `packages/mcp/src/oauth/protected-resource.ts`
used native `fetch` with automatic redirects and read protected-resource metadata without a byte
limit or an operation deadline. Its optional abort signal and `credentials: "omit"` did not bound
redirects, body size, or the destination reached after a redirect.

The sandbox egress proxy already checks exact host/port entries, resolves and rejects disallowed
addresses, and connects to a validated address. That enforcement is specific to the sandbox
runner's network path. The MCP client needs separate protection for its OAuth discovery requests,
without adding a package or a dependency edge from `@rovinos/mcp` to `@rovinos/sandbox`.

## Decision

Implement the discovery transport inside `@rovinos/mcp`. Each request hop resolves the destination,
validates every returned address against the selected profile, then pins the actual HTTP/TLS
socket to one validated address. For HTTPS, the connection uses the original URL hostname for TLS
SNI and certificate verification. Redirects are manual, and every new hop repeats URL, profile,
allowlist, DNS, and socket-pinning checks.

The protection applies only to requests made through this discovery transport. It does not claim
to prevent DNS rebinding or direct egress in later MCP SDK requests or other process networking.
The sandbox proxy remains separate and continues to enforce only the sandbox runner's route.

## Network profiles

| Profile | Behavior |
| --- | --- |
| `production` | Default. Permit public HTTPS destinations without an allowlist. Deny loopback, private, link-local, multicast, unspecified, IPv4-mapped private, and cloud-metadata addresses. An optional exact host/port allowlist narrows access. |
| `internal` | Explicitly selected by OAuth discovery configuration. Permit configured internal hosts and their private addresses while denying loopback, link-local, multicast, unspecified, and cloud-metadata destinations. Requires an exact host/port allowlist. |
| `local-development` | Explicitly selected by OAuth discovery configuration. Permit HTTP only to loopback endpoints; apply the same redirect, byte, and time limits. Does not generalize to arbitrary private or link-local addresses. |

The policy uses exact host/port entries rather than blanket rejection of internal networks or
wildcard host entries. Mixed DNS answers fail closed: every returned address must be permitted by
the selected profile and allowlist. Profiles are
explicit configuration and are never inferred from the URL or from the existing MCP server
`trust: internal` setting; `trust` only controls trace propagation and annotation use.

## Redirect and resource bounds

Use the existing `web.fetch` bounds:

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

The implementation must cover the regression moved here from issue #244: a valid protected-resource
probe redirect succeeds, while a malicious redirect to a disallowed destination is denied, with a
negative control proving the permitted path still works.

## Alternatives considered

1. **Validate the hostname before native `fetch`.** Rejected: the fetch implementation may resolve
   the hostname again at connection time, leaving a DNS-rebinding gap.
2. **Reuse the sandbox egress proxy directly from MCP.** Rejected: the proxy enforces the sandbox
   runner's route only, and importing `@rovinos/sandbox` would add a forbidden layer edge.
3. **Reject all private and internal addresses.** Rejected: legitimate internal MCP deployments
   need an explicit, narrow exception rather than blanket rejection.

## Implementation boundary

OAuth discovery uses the selected profile and limits only through the transport implemented in
`@rovinos/mcp`. Later MCP SDK HTTP requests use their existing transport and are outside the DNS
rebinding guarantee of this decision.
