# @rovinos/cli

## 0.2.0

### Minor Changes

- Release v0.2.0: SDK execution lifecycle with drain-then-suspend shutdown, live-model evals through a
  host-side gateway, MCP result envelopes, and the other v0.2.0 milestone changes listed below.

### Patch Changes

- 71b89d9: # Report released CLI version and request published eval image tag

  Report the CLI package version and use its matching v-prefixed release image for Docker evals.
- fa11fee: # Configure MCP binary result handling

  MCP tool results now keep every part in order. Binary result parts are blocked by default; allow them per server with `binaryResults: allow`, within `maxArtifactBytes`.
- f5dcaac: # Readable provider-safe tool aliases

  Use readable provider-safe aliases for MCP tools in OpenAI and Anthropic requests.
- 7616c6e: # Run evaluation suites with approval-integrity checks

  Enable the approval-integrity graders by default for eval runs and report when a suite explicitly disables them.
- 37f471a: # Run evaluation suites from the CLI

  Add `harness eval run` with model selection, cassette support, cost limits, telemetry opt-in, and metadata-only reports.
- 2b5d5fa: # Replay reports and baseline safety

  Replay commands now emit deterministic metadata-only reports and support golden comparisons and explicitly guarded baseline updates.
- 202681f: # SDK and CLI dependency updates

  Update SDK and CLI provider dependencies.
- ac1557e: # Azure Identity security update

  Upgrade Azure Identity to the release that pulls in the fixed MSAL Node version.
- f0f99be: # Run sandbox commands and cassette-aware judges in CLI evals

  Grade in the isolated trial workspace before releasing runtime resources. Include
  judge usage in cost-cap scheduling and metadata-only reports without double counting.
- c82b800: # Wire Bedrock provider configuration

  A `bedrock` provider now uses the Bedrock adapter and the AWS credential chain. Previously it could fall through to the OpenAI adapter.
- bd0a6df: # Human input CLI

  Add terminal commands for listing, inspecting, answering, and declining pending human input requests.
- 736ded5: # Run live evals through a host-side model gateway

  Require explicit live opt-in, cap provider requests across each run, and keep Docker
  trials network-disabled with host-only provider credentials over a Unix socket.
  Include the eval collector's existing runtime dependency in production CLI images.
- eac4076: # Bound MCP discovery work

  Bound MCP discovery pages, observed tools, decoded data, and total running time.
  Queue discoveries in FIFO order with at most four running concurrently, and
  support cancellation while waiting or running. Discovery fails closed when a
  work budget is exceeded, which can reject previously accepted servers.
- a823dce: # Preserve camelCase MCP tool names

  Allow MCP server tool names whose only normalization change is lowercasing. Continue rejecting names whose characters normalization replaces or collapses.
- b02a17a: # OpenTelemetry SDK 3 migration

  Migrate the CLI and SDK runtime dependencies to OpenTelemetry SDK 3 and the stabilized logs API.
- 589dd7b: # PII policy explanation

  Add `harness pii explain` with single-decision and matrix output.

  Local model inputs now receive tokenized values by default, including when a policy rule allows raw values. Set `pii.allowRawToLocalModels: true` to preserve the previous raw-value behavior for local models.
- 93a3179: # Reject unsupported outbound MCP Apps

  Outbound MCP Apps configuration with `apps: true` is now rejected. Omit the
  setting or set it to `false`; outbound Apps hosting is not supported.
- f6ac60b: # Pin MCP tools by contract

  Pin each run to the MCP tool contracts it reviewed and reject only changed or removed tools at dispatch.
- 55f14d2: # Privacy-safe metrics export

  Initialize bounded harness-owned metrics for SDK and CLI runtimes, with OTLP export and host-provider ownership controls.
- 6be9a2e: # Reject hidden tool calls

  Reject model tool calls that were not advertised in their recorded request.
- 7616c6e: # Keep invariant graders non-failing when event logs are unavailable

  The invariant graders report an `invariant_event_log_unavailable` code without failing trials when an executor does not expose events. Report schema defaults now agree that invariant checks are enabled.
- d60a8bb: # [20.5] Sanctioned logger runtime dependency

  Declare Pino as a runtime dependency for the published CLI and SDK bundles.
- 562de70: # Sanitize requests to injected model ports

  With PII enabled, an injected `ModelPort` now receives the same sanitized requests as the configured model gateway.
- 9c56ae9: # Compare evaluation reports from the CLI

  Add report comparison and YAML variant configuration to `harness eval`.
- 38e0c4f: # Enforce concurrent run quotas when claiming jobs

  Worker claims now defer matching jobs while their configured concurrent-run quota is full.
- 1adc21c: # MCP server runtime update

  Update the bundled MCP Node runtime to 2.1.2 and the MCP server SDK to 2.4.0, which brings in the patched `@hono/node-server` 2.1.5 (GHSA-rmxm-3fg6-px4f).

## 0.1.0

### Patch Changes

- e32d43b: # Anthropic SDK migration

  Update the bundled Anthropic SDK and keep its automatic telemetry instrumentation disabled.
- 0156e58: # Dependency updates

  Update bundled runtime dependencies to their latest minor and patch releases, including the OpenAI, Google GenAI and AWS Bedrock clients and `undici`.
