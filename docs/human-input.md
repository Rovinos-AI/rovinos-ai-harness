# Human input

Task 25.1 defines the contracts and configuration used by later elicitation and
human-input features. It supports MCP form requests, URL-consent requests, and
agent questions through one normalized request shape.

## Form contracts

`FormSchema` accepts a flat object with at most 20 properties. Properties may
be strings (including email, URI, date, and date-time formats), numbers,
integers, booleans, single-select choices, or multi-select choices. Titled
choices use `oneOf` for single selection and `anyOf` for multiple selection.
Titles and descriptions are limited to 200 characters. Unknown keywords and
nested schemas are rejected. Safe regular-expression patterns are accepted
only for legacy-server requests.

Use `formSchemaToZod` to validate answers against the form definition,
including its required fields and property constraints. URL-mode acceptance
represents consent and may have no answer.

## Configuration

Elicitation is disabled for each MCP server unless its `elicitation.enabled`
flag is set. Per-server modes default to `form`; request rounds, per-run
requests, request-state size, and legacy live waits have bounded defaults.
Global channels default to an empty list, HTTPS is required, and inputs expire
after seven days.

```yaml
elicitation:
  channels: [control_plane, cli]
  requireHttps: true
  expiresAfterMs: 604800000
  urlAllowHosts: [example.test]

servers:
  - id: example
    transport:
      kind: stdio
      command: node
    elicitation:
      enabled: true
      modes: [form, url]
```

Input requests are recorded before any channel sees them. The MCP boundary
tokenizes messages, string defaults, URLs, and schemas at the `ui` boundary;
channels display those tokenized values and never detokenize server-provided
content.

`HumanInputBroker` lists recorded pending requests and races all registered
channels that report themselves available. The first valid answer wins, other
channels are cancelled, and an invalid form answer may be requested once more.
Pending requests remain listable when no channel is currently connected.

`resolveInput(store, runId, requestId, { action, answer?, principal, tokenizer,
resolver?, clock?, queue?, expiresAfterMs? })` can be called from a separate
process. It verifies that the request is pending and its run is not already
completed, failed, or cancelled.
When the stored schema contains tokens, an audited resolver restores the
original constraints and defaults only in memory; channel-facing schemas and
recorded events remain tokenized. It validates accepted form answers with
`formSchemaToZod`, applies separation of duties, and tokenizes answers at the
`tool_input` boundary with raw disclosure disabled before appending the
`input_resolved` event. Answers received after an absolute or configured age
deadline are rejected, while the event is recorded as cancelled by expiry. A
configured run queue receives a resume job after resolution; retries can
recover a missed wake-up. The approval sweep also expires pending inputs and
enqueues their resume jobs.

Request messages, schemas, URLs, opaque request state, and answers are event
content; the `harness.input_wait` span carries only source, mode, round, action,
and wait duration.
