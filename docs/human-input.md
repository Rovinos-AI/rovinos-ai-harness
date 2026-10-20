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

This task adds schemas and defaults only. Request handling, answer brokering,
URL checks, and user-interface channels are delivered by later Epic 25 tasks.
Request messages, schemas, URLs, opaque request state, and answers are event
content; the telemetry projection uses only bounded request and resolution
metadata. Resolution events repeat the request source, mode, and round so the
safe `input_wait` projection can be made from a single event.
