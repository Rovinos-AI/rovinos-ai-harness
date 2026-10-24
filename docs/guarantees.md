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
