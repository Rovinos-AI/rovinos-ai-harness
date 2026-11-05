# ADR 0006: Live eval model gateway

- **Status:** Accepted
- **Date:** 2026-11-05
- **Decision owners:** Maintainers (issue #660)

## Context

Live evals default to Docker isolation, but trial containers use `--network none`
and receive no provider credentials. Giving them general network access or copying
credentials into their environment would weaken the eval boundary. A discovery
probe also does not validate the MCP-to-model-to-tool path (#690 and #697).

## Decision

Keep Docker trial networking disabled. The CLI owns a run-scoped live model session
and resolves provider secrets on the host. A small host-process gateway accepts
schema-validated model RPCs over a Unix socket. Each trial mounts only its socket
read-write, not the socket directory or any host credential file. The trial sends
model requests, never destination URLs, credentials, or HTTP headers.

Host-owned adapters select only configured provider endpoints. The transport checks
the exact destination and rejects redirects instead of following them. Unsupported
provider authentication or transport configurations fail before trial execution
with a closed code. Rejections are count/code metadata; request content, provider
errors, headers, and credentials are not diagnostic output.
Provider SDK debug logging is explicitly disabled, including when SDK logging
environment variables request verbose output.

Credentials remain in host memory and outgoing provider requests. Trial configuration
omits provider definitions. The socket response carries normalized model output,
not provider transport errors. Existing tokenization and policy enforcement remain
in the trial runtime; the gateway does not authorize tools or change MCP egress.

`--isolation inprocess --cassette off --live` is the simpler local path. It uses
the same bounded host model session directly, without a socket gateway or container.
The CLI emits `eval_live_inprocess_not_isolated`; this mode is not a security
isolation boundary.

## Opt-in, limits, and lifecycle

- Live calls require `--live`, including cassette recording. Without opt-in, Docker
  fails with `eval_docker_live_model_unavailable` and in-process execution fails
  with `eval_inprocess_live_model_unavailable`.
- `--max-model-calls` is a positive per-run provider request cap, defaulting to 100.
  Retries, repairs, concurrent trials, and live judge calls share the cap. Admission
  occurs before an outgoing request, and exhaustion fails the command with
  `eval_live_call_limit_exceeded`. This bounds requests, not monetary cost or tokens
  per request. Existing task budgets and `--max-cost-usd` remain additional controls.
- Cancellation aborts in-flight provider requests and closes trial gateways.
  Cleanup runs on success and failure; sockets are temporary resources, not artifacts.
- Live model configuration overrides in variant files are rejected. Select routes
  with `--model`, task models, or variant routes; endpoint and credential selection
  belong to the run's trusted host configuration.
- Docker cassette replay/record and Docker LLM judges remain unsupported and fail
  early with mode-specific codes.
- Docker live CLI trials use the invoking non-root host UID/GID for writable trial
  mounts. Unsupported host identities fail before trial execution rather than
  making the workspace writable by every user.

## Alternatives rejected

A container-network egress allowlist is fragile around DNS, redirects, and shared
CDNs, and would expose provider credentials to the trial. A proxy sidecar adds
operational complexity without improving this host-side credential boundary.
Neither is used.

## Validation and operational assumptions

Deterministic blocking tests use synthetic providers and credentials. They exercise
destination rejection, cancellation, limits, credential canaries, and the MCP
model-selected tool/result/second-turn path through the same gateway. The existing
privacy grader remains applicable to trial artifacts and telemetry.

Paid live tests are an optional, separately invoked lane, never part of `static`,
`unit`, `integration`, or `gates`. Run them only with a restricted staging credential
and disposable synthetic inputs, never personal developer keys or production data.
No live-provider success is inferred from deterministic fixture tests.

The host configuration, host process, provider SDK, Docker daemon, and selected
image are trusted. A configured provider receives model inputs under the existing
privacy policy. The socket is a model-call capability for its trial and does not
provide general host filesystem or network access. Local in-process execution
offers no protection against hostile suite code.
