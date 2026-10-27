# Guarantees and limits

This page is the authoritative description of the harness's privacy and security
properties. A guarantee below describes a specific implementation path, not every
possible deployment. Read its assumptions and the known gaps before relying on it.

## Structural guarantees

### Telemetry schemas and allowlists

Harness telemetry is constrained at three layers: registered schemas and safe
projections, SDK export-processor allowlists, and generated Collector
allowlists. The canary gate also checks captured telemetry and other observable
sinks.

- **Evidence:** [registry tests](../packages/telemetry/src/registry.test.ts),
  [SDK allowlist processor tests](../packages/telemetry/src/processors/allowlist-span-processor.test.ts),
  [Collector fixture test](../test/collector-allowlist.int.test.ts), and
  [canary release gate](../test/canary/pipeline.canary.test.ts). CI jobs: `unit`,
  `integration`, `gates`.
- **Assumptions:** telemetry is sent through the configured SDK and Collector
  pipeline; generated allowlists and production profiles are not bypassed or
  replaced with an exporter configuration that has not been reviewed.

### Vault and event log separation

The vault stores raw values separately from the event log, which stores tokens
and metadata. Workspace files and other storage are not covered by this
separation.

- **Evidence:** [PII storage boundary integration test](../test/pii-storage-boundary.int.test.ts)
  and [canary release gate](../test/canary/pipeline.canary.test.ts). CI jobs:
  `integration`, `gates`.
- **Assumptions:** tokenization is enabled before content is persisted, and
  event-store and vault data use separate adapters. Custom adapters and
  workspaces require their own controls.

### Content encrypted at rest

The event-store content codec and persistent vault adapters provide
authenticated encryption at rest when configured with their encrypted
implementations. This does not encrypt workspace files, database backups, or
other storage unless those systems are separately configured to do so.

- **Evidence:** [AES-GCM content codec tests](../packages/store/src/aes-gcm-codec.test.ts),
  [vault SQLite tests](../packages/vault/src/sqlite.test.ts), and
  [PII storage boundary integration test](../test/pii-storage-boundary.int.test.ts).
  CI jobs: `unit`, `integration`.
- **Assumptions:** operators configure and protect key providers, preserve keys
  for as long as encrypted data or backups must remain readable, and select
  encrypted adapters for every durable store in scope.

### App telemetry validation and host stamping

The host validates app telemetry against a closed schema, bounds batch size, and
stamps accepted spans with host-controlled identity and session context before
export.

- **Evidence:** [app telemetry validation tests](../packages/host/src/server/app-telemetry.test.ts),
  [host stamp tests](../packages/host/src/server/stamp.test.ts), and
  [hostile app integration suite](../test/host-hostile.int.test.ts). CI jobs:
  `unit`, `integration`.
- **Assumptions:** apps submit telemetry through the host bridge and exporters
  use the host-validated stream; this does not constrain telemetry emitted
  outside that path.

### Sandbox restrictions

Container-backed execution applies explicit process, filesystem, and network
restrictions. The runner has no network access by default; the optional egress
proxy permits only configured destinations. The development-only in-process
backend does not provide equivalent isolation and must not be treated as a
hardened sandbox.

- **Evidence:** [image hardening integration tests](../scripts/ci/image-hardening.int.test.ts),
  [network isolation integration test](../test/network-isolation.int.test.ts), and
  [egress policy tests](../packages/sandbox/egress-proxy/src/proxy.test.ts). CI
  jobs: `integration`.
- **Assumptions:** operators use the container-backed runner, retain its
  restricted configuration, apply host/runtime security updates, and do not
  grant additional capabilities or network routes.

### Policy evaluation

Tool calls are proposals from the model. Harness code evaluates policy against
prepared, tokenized arguments and controls whether a call is allowed, requires
approval, or is denied; the model does not make that authorization decision.

- **Evidence:** [policy-checked app call tests](../test/app-call-policy.test.ts)
  and [tokenized arguments before policy recheck](../packages/core/src/runtime-app-approval.test.ts).
  CI job: `unit`.
- **Assumptions:** calls pass through the policy-checked runtime and the
  configured policy and tool preparation are used.

### Human approvals

An approval-required action suspends until a human decision is recorded as an
event in the run log. Approval does not itself bypass the runtime's policy
rechecks.

- **Evidence:** [durable approval and resume test](../packages/core/src/runtime-app-approval.test.ts)
  and [approval event-state tests](../packages/core/src/run-state.test.ts).
  CI job: `unit`.
- **Assumptions:** the approval is completed through the configured host or
  control-plane flow and its event store remains available.

### Crash recovery

When a run process stops between durable event-log appends, the runtime can
resume from the recorded state. In particular, a recorded non-idempotent tool
intent is not blindly executed a second time after recovery; an unresolved
result may require escalation or human action.

- **Evidence:** [crash-injection recovery matrix](../test/crash-injection.int.test.ts),
  [non-idempotent recovery test](../test/mcp-servers.int.test.ts), and
  [crash-and-resume documentation integration test](../test/examples.int.test.ts).
  CI job: `integration`.
- **Assumptions:** the event log and any required tool-side idempotency or
  recovery state remain available; recovery cannot undo external effects that
  occurred before a crash.

### Replay from a trace

A trace id is a metadata-only locator, not a copy of the run's content.
Resolution uses the event store to find the recorded run; replay then runs
against recorded model responses, tool results, and human decisions. It emits a
new trace linked to the original, reports configuration and policy drift, and
returns divergence as structured outcome data rather than silently treating a
divergent run as identical.

- **Evidence:** [trace-id resolution tests](../packages/replay/src/resolve.test.ts),
  [replay, drift, and divergence tests](../packages/replay/src/replay.test.ts),
  and the [replay example test](../test/replay-example.replay.test.ts). CI jobs:
  `unit`, `gates`.
- **Assumptions:** the original event store and vault remain retained and
  readable, the original vault keys are available for the retained data, and
  the recorded run includes its runtime configuration and policy versions.

Replay does not promise identical results from live, non-recorded providers:
replay serves recorded results rather than calling those providers. A run that
has been pruned or deleted, or whose event store or required keys are
unavailable, cannot be replayed from its trace id.

## Best-effort measures

- **PII detection:** detectors are measured against a synthetic corpus, but
  precision and recall vary by entity and detector. CI publishes
  [per-run reports](../scripts/pii-report.ts) as artifacts in the `unit` and
  `integration` jobs; see the [report tests](../scripts/pii-report.test.ts) and
  [Epic 13.11](../packages/pii/epic-13-pii-tokenizer.md#1311-synthetic-detection-corpus-with-precision-and-recall-report).
  These measurements are not a guarantee that every sensitive value is found.
- **Leak sentinel:** matching covers normalized plaintext and supported
  variants: NFKC normalization; removal of zero-width and bidi controls;
  lowercasing; whitespace and dash removal; digits-only forms for sufficiently
  long values; percent encoding; base64 and base64url at three byte alignments;
  hexadecimal; and HTML numeric entities. Variants shorter than the configured
  minimum and patterns excluded by size limits are not scanned. See the
  [variant tests](../packages/telemetry/src/sentinel/variants.test.ts) and the
  [telemetry-specific known gaps](telemetry/guarantees.md#known-gaps).
- **Prompt injection:** untrusted model and tool content can attempt to
  influence behavior. Policy checks and human approvals constrain authority in
  code, but prompt-injection resistance is best effort, not a substitute for
  least privilege. See the [prompt-injection integration test](../test/security/prompt-injection.int.test.ts).

## Known gaps

- The leak sentinel does not detect arbitrary encryption, compression,
  steganography, translation, or values split across separately checked
  attributes or payloads. It also does not cover transform chains beyond its
  documented supported forms.
- Side channels, including timing and shared-resource effects, are not
  eliminated.
- Container isolation shares the host kernel. Kernel or runtime vulnerabilities
  may cross the container boundary; see the [sandbox threat model](security/sandbox-threat-model.md#residual-risks).
- Third-party model APIs may retain or log requests and responses under their
  own policies.
- User-supplied files in workspaces can contain sensitive values and hostile
  instructions; they are not covered by the telemetry controls.
- A human may retain or disclose information after an audited reveal.
- A compromised host, operator account, or trusted dependency can use its
  granted authority.
<!-- cspell:ignore msal -->
- `@azure/msal-node` 6.x, a transitive dependency of `@azure/identity`, is
  affected by [GHSA-xcx6-jx8p-x3h5](https://github.com/advisories/GHSA-xcx6-jx8p-x3h5)
  (authorization-code flow parameter disclosure). The harness uses
  `@azure/identity` through `DefaultAzureCredential` for Azure Key Vault; this
  use does not run that flow, and MCP OAuth login does not use MSAL. The latest
  `@azure/identity` still requires `msal-node` 6.x; the upgrade is tracked in
  [issue #614](https://github.com/Rovinos-AI/rovinos-ai-harness/issues/614).

## Operator responsibilities

- Protect encryption keys, keep key references separate from data backups, and
  plan rotation and retirement. See [secret management](secrets.md) and
  [key rotation commands](cli.md#harness-keys-rotate-and-harness-keys-retire).
- Configure and review run-retention and snapshot-pruning settings; retention is
  opt-in. See [configuration](configuration.md) and
  [deployment guidance](deployment.md).
- Review model-provider trust and configure network policy for the deployment.
  Restrict access to the control plane and its tokens; see
  [control-plane security](control-plane-security.md).
- Back up event stores, vault data, encryption keys, and other persistent
  state under one recovery policy. Test restores and preserve required keys for
  the full backup retention period.
- Monitor sentinel trips, rejected app telemetry, detector health, provider
  failures, and missing telemetry. Epic 11.5 specifies the planned alert
  runbooks; the runbook files are not yet present in this repository. Until
  they are available, use the [sandbox residual-risk guidance](security/sandbox-threat-model.md#residual-risks)
  and the [Epic 11.5 runbook specification](../infra/epic-11-backends.md#115-alerts-and-runbooks).

## Non-claims

The project does not certify compliance with GDPR, HIPAA, or any other legal or
regulatory regime. This documentation is not legal advice. Operators are
responsible for evaluating their deployment against applicable obligations.
