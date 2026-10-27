# @rovinos/sdk

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
