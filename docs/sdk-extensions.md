# SDK extensions

`@rovinos/sdk` is the canonical contract owner for provider and tool contributions. An application
imports an implementation it trusts, then registers it explicitly with `createHarness`. There is
no automatic package loading and no dependency on authoring helpers.

## Registration and grants

An extension definition contains an `ExtensionManifest`, one Zod configuration schema, and a
factory that returns tool/provider contributions. The manifest is data only: it identifies the
extension and version, an SDK compatibility range, schema version, and required/optional capability
requests. It cannot name a module to load or contain executable expressions. The SDK's `defineTool`
helper is optional and only preserves schema-based callback inference; direct definitions receive
the same registration, argument, result, and grant checks.

The application selects a namespace and supplies explicit destination grants:

```ts
const harness = await createHarness({
  configPath: "./harness.config.json",
  extensions: [
    {
      namespace: "knowledge",
      definition: searchExtension,
      config: { maxResults: 3 },
      grants: [{ kind: "tools.contribute", names: ["search"] }],
      toolTimeoutMs: 10_000,
      maxOutputBytes: 12_000,
    },
  ],
});
```

The `tools.contribute` grant makes `knowledge.search` eligible for the ordinary tool catalog; it
does not authorize execution. Core still validates the model selection, records intent, applies
policy and approval, enforces cancellation and configured budgets, and applies PII handling to tool
arguments and results. Tool callbacks receive only validated input and an `AbortSignal`. Input may
contain sensitive in-flight values at the tool boundary; callbacks must not persist or log them.
Tool output is schema-validated and then passed through the existing core privacy boundary before
being admitted.

`providers.contribute` grants name provider IDs. A registered provider is usable only through
ordinary model configuration and routing. The SDK does not pass a credential bag or general secret
resolver to provider adapters. Applications construct adapters with only the intended
provider-scoped configuration.

An unsatisfied required supported grant rejects registration with a typed `ExtensionError`.
Optional capabilities without grants are disabled and listed as unsupported by
`harness.getExtensionStatus()`. `events.observe` and `content.read` are reserved discriminators and
are not implemented; optional requests are reported as unsupported and required requests are
rejected. Applications that need metadata-only observation can consume the existing safe event
stream with `harness.watch(runId)`.

The operator can revoke a destination grant for future mediated operations:

```ts
harness.revokeExtensionGrant({
  namespace: "knowledge",
  kind: "tools.contribute",
  target: "search",
});
```

Revocation removes the tool from future catalogs and blocks a previously selected invocation. A
provider grant is checked before each adapter call and while yielding stream deltas. Revocation is
cooperative and does not forcibly terminate an already-running in-process callback or network call.
The core-owned run context binds a tool call to its active run; extensions cannot provide a run
identity or select another run through the invocation context.

## Compatibility, validation, and lifecycle

The manifest `sdkRange` supports a space-separated set of exact or comparison terms over
three-part numeric versions, for example `>=0.3.0 <0.4.0`. Manifest version, SDK package version,
manifest `schemaVersion`, and event/result schema versions are separate. Unsupported schema
constructs that cannot be represented in the provider-facing tool schema are rejected; the Zod
input/output contracts remain authoritative at execution.

Configuration and serialized tool inputs/results are bounded to 64 KiB, depth 32, and 4,096 JSON
nodes. Manifest arrays, target names, descriptions, and compatibility strings are also bounded by
their schemas. `toolTimeoutMs` and `maxOutputBytes` are operator-supplied, default to 30 seconds
and 64 KiB, and cannot exceed those ceilings; the actual timeout is clamped to the configured run
wall-clock budget. Results exceeding the configured byte ceiling are rejected before core result
admission. Identity and contribution collisions reject registration rather than replacing an
existing tool or provider. The same checks run whether or not authoring helpers are installed.

The initial factory has no setup context or disposal hook and should create stateless definitions
only. Extensions do not receive store/vault handles, event writers, unrestricted execution
capabilities, or unrelated provider credentials. Replay consumes the core-recorded tool results and
does not rerun extension callbacks.

## Trust boundary

Extensions are trusted application code, not sandboxed plugins. Importing their modules may execute
initialization before the SDK validates a manifest. Capability grants govern SDK-mediated
contributions; they do not contain JavaScript's ambient filesystem, network, or process access.
Untrusted extension code requires separately enforced process/container isolation plus explicit
communication and egress policy. MCP is a transport, not a sandbox.
