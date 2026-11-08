# ADR 0007: SDK extension contracts and governed registration

- **Status:** Accepted
- **Date:** 2026-11-08
- **Decision owners:** Maintainers

## Context

The harness publishes `@rovinos/sdk` as its sole stable programmatic API. Provider and tool
integrations need public contracts that do not require consumers to install private workspace
packages. Optional authoring helpers may improve ergonomics later, but must not become a second
runtime or the authority that decides access.

## Decision

The SDK owns extension manifests, capability requests, grants, tool definitions, registration
validation, provider/tool contribution routing, and the extension status and revocation entry
points. Applications explicitly import trusted implementations and pass registrations to
`createHarness({ extensions })`. The SDK does not load packages by manifest name.

Manifest data has `id`, semantic `version`, `sdkRange`, `schemaVersion: 1`, and bounded required
and optional capabilities. The accepted capability discriminators are:

| Capability | Initial behavior |
| --- | --- |
| `tools.contribute` | Supported; grants name local tools, which are exposed under the application's namespace. |
| `providers.contribute` | Supported; grants name provider IDs, which must also be selected by ordinary model configuration. |
| `events.observe` | Declared but unsupported. Optional requests are disabled and shown as unsupported; required requests reject registration. Apps can independently consume the existing safe `Harness.watch()` stream. |
| `content.read` | Declared but unsupported. Optional requests are disabled and shown as unsupported; required requests reject registration. No content-binding subsystem is added by this decision. |

Capability requests do not grant access. Registration requires explicit operator grants for all
required supported destinations. Optional destinations without grants are omitted and reported by
`Harness.getExtensionStatus()`. Grants are checked again when a tool is advertised or invoked and
when a provider begins or continues a call. `Harness.revokeExtensionGrant()` disables future
operations for the matching namespace, capability and destination. In-flight trusted code is
cooperative and is not forcibly terminated by revocation.

An extension tool is routed through the existing core `ToolPort`; it does not write events. Core
continues to own tool selection, intent durability, policy, approvals, cancellation, PII
tokenization, result admission, and configured run budgets. The extension sees only its validated
tool input and an `AbortSignal`; it receives no store, vault, credential collection, event writer,
run identity, or unrestricted execution method. Tool results must pass both the contribution's
output schema and the existing core privacy boundary before admission.

Provider adapters are explicit in-process objects registered against provider IDs. The SDK supplies
no credential bag or general secret resolver to an extension. An application must construct an
adapter with only its intended provider-scoped configuration, and ordinary model routing still
selects whether it is used.

The SDK validates direct registrations regardless of any authoring helper. Identity and
contribution collisions fail instead of replacing existing entries. Manifests contain data only;
configuration is a bounded JSON value parsed by one Zod schema on the extension definition. The
SDK range grammar is a space-separated list of exact or comparison terms (`=`, `>`, `>=`, `<`,
`<=`) over three-part numeric versions. `SDK_VERSION` is sourced from the SDK package manifest so
this minor changeset advertises SDK compatibility version `0.3.0`, matching its expected changeset
release. Future changesets must keep the constant aligned with the released package version.
Package version, manifest schema version, and event versions remain separate concerns.

## Public SDK surface introduced

The exported symbols are:

- Values: `ExtensionCapabilitySchema`, `ExtensionCapabilityStatusSchema`,
  `ExtensionDefinitionSchema`, `ExtensionError`, `ExtensionGrantSchema`,
  `ExtensionGrantRevocationSchema`, `ExtensionManifestSchema`,
  `ExtensionRegistrationSchema`, `ExtensionRegistrationStatusSchema`, `SDK_VERSION`, and
  `defineTool`.
- Types: `ExtensionCapability`, `ExtensionCapabilityStatus`, `ExtensionContributions`,
  `ExtensionDefinition`, `ExtensionGrant`, `ExtensionGrantRevocation`, `ExtensionManifest`,
  `ExtensionRegistration`, `ExtensionRegistrationStatus`, `ExtensionToolDefinition`,
  `ProviderAdapter`, `ProviderContext`, `ProviderDelta`, `ProviderResult`,
  `ToolInvocationContext`, `Code`, `Id`, `JsonValue`, `ModelRequest`, `ModelUsage`, and `Part`.
- Provider/schema values: `CodeSchema`, `IdSchema`, `JsonValueSchema`, `ModelRefSchema`,
  `ModelRequestSchema`, `ModelUsageSchema`, `PartSchema`, `ProviderDeltaSchema`, and
  `ProviderResultSchema`.
- Options and operations: `CreateHarnessOptions.extensions`,
  `ExtensionRegistration.toolTimeoutMs`, `ExtensionRegistration.maxOutputBytes`,
  `Harness.getExtensionStatus()`, and
  `Harness.revokeExtensionGrant(request)`.
- Capability names: `tools.contribute`, `providers.contribute`, `events.observe`, and
  `content.read`.
- `toolTimeoutMs` is operator-selected per registration, defaults to 30 seconds, is capped at
  30 seconds, and is clamped by the configured run wall-clock budget.
- `maxOutputBytes` is operator-selected per registration, defaults to 64 KiB, and is capped at
  64 KiB; the SDK rejects oversized results before core result admission.
- `ExtensionError` codes: `extension_manifest_invalid`, `extension_incompatible`,
  `extension_config_invalid`, `extension_grant_missing`, `extension_grant_invalid`,
  `extension_capability_unsupported`, `extension_contribution_invalid`,
  `extension_schema_unsupported`, `extension_input_invalid`, `extension_result_invalid`, and
  `extension_execution_failed`.

The `events.observe` and `content.read` discriminators are reserved contract values, not supported
features. Consumers must inspect status and must not interpret a declaration or an unsupported
status as authority.

## Trust and lifecycle

Extensions are trusted application code. Importing an implementation may execute module
initialization before the SDK validates its manifest. In-process validation governs only
SDK-mediated contribution paths; it is not a pre-execution sandbox and does not prevent ambient
filesystem, network, or process access. Untrusted implementations require an independently enforced
process or container boundary and explicit communication and egress policy; MCP by itself is not
isolation.

The initial contribution factory is synchronous in purpose and has no setup context or disposal
hook. It should construct stateless definitions only. Future stateful resources require reviewed
initialization rollback, cancellation, drain/abort, idempotent disposal, and close ordering. Replay
consumes recorded core results and does not re-invoke an extension tool callback.

## Consequences

- `@rovinos/sdk` has no dependency on `@rovinos/extensions` or concrete extension packages.
- Helper packages must reuse the SDK schemas and cannot grant capabilities.
- Extension tools are ordinary governed tools, not a bypass around MCP or core policy.
- Safe-event observation remains available to applications through `Harness.watch()`; extension
  callbacks for safe events are not enabled until their replay and lifecycle behavior is defined.
- New capabilities require an explicit contract and enforcement review before implementation.
