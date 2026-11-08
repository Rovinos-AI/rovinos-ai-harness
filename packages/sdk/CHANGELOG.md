# @rovinos/sdk

## 0.2.0

### Minor Changes

- Release v0.2.0: SDK execution lifecycle with drain-then-suspend shutdown, live-model evals through a
  host-side gateway, MCP result envelopes, and the other v0.2.0 milestone changes listed below.

### Patch Changes

- 6b2ad35: # Azure OpenAI provider configuration

  Expose Azure OpenAI endpoint, API version, deployment mapping, and API-key or Entra authentication in the public SDK configuration schema.
- fa11fee: # Configure MCP binary result handling

  MCP tool results now keep every part in order. Binary result parts are blocked by default; allow them per server with `binaryResults: allow`, within `maxArtifactBytes`.
- f5dcaac: # Readable provider-safe tool aliases

  Use readable provider-safe aliases for MCP tools in OpenAI and Anthropic requests.
- 8898749: # SDK execution shutdown semantics

  Specify managed run shutdown semantics and suspend in-process executions on close.
- 202681f: # SDK and CLI dependency updates

  Update SDK and CLI provider dependencies.
- 7cec563: # Keep SDK content event kinds exhaustive

  Add `input_requested`, `input_resolved`, and `app_content` to the SDK content enum, aligned with shared field classification.
- ac1557e: # Azure Identity security update

  Upgrade Azure Identity to the release that pulls in the fixed MSAL Node version.
- c82b800: # Wire Bedrock provider configuration

  A `bedrock` provider now uses the Bedrock adapter and the AWS credential chain. Previously it could fall through to the OpenAI adapter.
- eac4076: # Bound MCP discovery work

  Bound MCP discovery pages, observed tools, decoded data, and total running time.
  Queue discoveries in FIFO order with at most four running concurrently, and
  support cancellation while waiting or running. Discovery fails closed when a
  work budget is exceeded, which can reject previously accepted servers.
- a823dce: # Preserve camelCase MCP tool names

  Allow MCP server tool names whose only normalization change is lowercasing. Continue rejecting names whose characters normalization replaces or collapses.
- b02a17a: # OpenTelemetry SDK 3 migration

  Migrate the CLI and SDK runtime dependencies to OpenTelemetry SDK 3 and the stabilized logs API.
- 998506a: # OpenAI-compatible endpoint quirks

  Model provider configuration accepts an optional `quirks` object (`useMaxTokens`, `supportsStrictSchema`) for OpenAI-compatible endpoints such as Ollama and vLLM. Existing configurations are unchanged.
- 93a3179: # Reject unsupported outbound MCP Apps

  Outbound MCP Apps configuration with `apps: true` is now rejected. Omit the
  setting or set it to `false`; outbound Apps hosting is not supported.
- f6ac60b: # Pin MCP tools by contract

  Pin each run to the MCP tool contracts it reviewed and reject only changed or removed tools at dispatch.
- 55f14d2: # Privacy-safe metrics export

  Initialize bounded harness-owned metrics for SDK and CLI runtimes, with OTLP export and host-provider ownership controls.
- 463fbf9: # Bound OAuth discovery egress

  Add explicit OAuth discovery network profiles and optional host/port restrictions to the public server configuration schema.
- 6be9a2e: # Reject hidden tool calls

  Reject model tool calls that were not advertised in their recorded request.
- d60a8bb: # [20.5] Sanctioned logger runtime dependency

  Declare Pino as a runtime dependency for the published CLI and SDK bundles.
- 562de70: # Sanitize requests to injected model ports

  With PII enabled, an injected `ModelPort` now receives the same sanitized requests as the configured model gateway.
- dfb99d8: # Export validated principal parsing

  Expose the principal schema and inferred type from the public SDK for human-input and approval resolution.
- a0b7365: # Resolve human input through the SDK

  Expose durable human-input resolution through the public SDK. `answerInput` now resolves a pending request instead of always failing.

## 0.1.0

### Minor Changes

- 389467e: # Configurable subagent limits

  Add configurable subagent limits to run configuration.
- c326600: # Prompt cache pricing and usage

  Expose cache token pricing options and usage metadata in the model configuration and response schemas.
- 1dec2c2: # Postgres-backed vault

  Add Postgres-backed vault configuration with per-scope data keys.
- a901dd5: # Presidio detector settings

  Add optional Presidio analyzer settings and fail-mode configuration to the public PII config.
- 96e2220: # Initial public SDK

  Add a stable programmatic API for embedding and controlling harness runs.
- 1605044: # Opt-in pseudonymous telemetry correlation

  Add the disabled-by-default telemetry correlation setting and validated pseudonym attribute support.
- ce5f37d: # Cross-run quotas

  Add cross-run quotas, persist quota role identity, and account for usage with model responses.
- b21ef64: # Model streaming configuration

  Add provider streaming controls and idle-timeout configuration to the public model configuration schema.
- 7042868: # Model-driven control-plane run creation

  Add the `start_run` and `continue_run` control-plane tools. Model-driven clients require human
  confirmation unless `controlPlane.allowAgentStartedRuns` is enabled. `Runtime.continueRun` now
  returns a lifecycle handle with a durable-start promise and a completion promise, allowing the
  control plane to return pending metadata without waiting for the run to finish.

### Patch Changes

- e32d43b: # Anthropic SDK migration

  Update the bundled Anthropic SDK and keep its automatic telemetry instrumentation disabled.
- 0156e58: # Dependency updates

  Update bundled runtime dependencies to their latest minor and patch releases, including the OpenAI, Google GenAI and AWS Bedrock clients and `undici`.
