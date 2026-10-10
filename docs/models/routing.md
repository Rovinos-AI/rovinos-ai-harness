# Model routing and fallback

Configure provider adapters and ordered model references under `models`. The first
reference in a route is the primary model; remaining references are tried in
order when a configured fallback error occurs.

```yaml
models:
  providers:
    - id: anthropic
      kind: anthropic
      apiKey: env:ANTHROPIC_API_KEY
    - id: openai
      kind: openai
      apiKey: env:OPENAI_API_KEY
  routing:
    default:
      - provider: anthropic
        model: claude-sonnet-4-5
      - provider: openai
        model: gpt-4o-mini
    roles:
      planner:
        - provider: openai
          model: gpt-4o-mini
        - provider: anthropic
          model: claude-sonnet-4-5
```

A non-empty role-specific route replaces the default route for requests carrying
that role. A request without a role, or a role with no targets, uses
`routing.default`. If no route is configured, the model reference on the request
is used.

By default, exhausted rate-limit, timeout, and unavailable-provider retries, plus
invalid structured output, advance to the next route entry. Set `fallbackOn` to
the desired error codes to customize that set. Authentication, bad-request,
content-filtered, and unknown provider errors do not cause fallback unless
explicitly added. Cancellation and run-deadline failures are surfaced directly.

On a provider switch the gateway removes foreign opaque provider data from
conversation messages, while retaining normalized text and tool calls. The
response reports the selected provider/model and its zero-based `fallbackDepth`.
Provider credentials must use `env:`, `file:`, or `akv:` secret references;
configured references are resolved by the CLI's secret resolver at runtime.
Remote provider URLs use HTTPS unless the endpoint is loopback or `trust: local`
is explicitly set.

Routing targets are checked against configured provider ids during runtime
construction. An unknown id fails startup with `routing_provider_unknown`.
