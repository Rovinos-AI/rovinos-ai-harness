# Policy documents

Policies make deterministic decisions in code before a tool runs. They operate
on tokenized arguments and never see raw sensitive values.

The policy format is versioned and strict. Its default decision must be `ask`
or `deny`; rules can match tool IDs, argument pointers, and request context
(`subagent`, MCP `server`, and calling app ID). When rules match, the evaluator
uses the most restrictive decision.

When `policy.file` is not configured, the runtime applies a built-in deny-all
policy. Configure a policy explicitly to allow any tools, and review
`harness doctor`'s `policy_default_deny` warning when using that default. A
minimal policy allows only the named tool and denies all unmatched calls:

```yaml
version: 1
defaultDecision: deny
rules:
  - id: allow_read_only
    match:
      tools:
        - my.read_only_tool
    decision: allow
    reason: read_only_operation
```

Replace `my.read_only_tool` with an actual tool ID and set
`policy.file: ./policy.yaml` in `harness.config.yaml`.

## Matching token types

PII values are replaced with tokens such as `<EMAIL_1>` before policy
evaluation. Use the `tokenType` operation to match the token's entity type,
written in lowercase as the `value`; do not write a rule that expects a raw
email address:

```yaml
match:
  tools:
    - mail.send
  args:
    - pointer: /to
      op: tokenType
      value: email
decision: ask
reason: outbound_email
```

The pointer selects a tokenized argument. This rule matches values such as
`<EMAIL_1>` without exposing or storing the corresponding address. The example
policy in [`examples/policy.yaml`](../examples/policy.yaml) is a complete
validated document.

## Approval edits

Approval edits are limited to the JSON Pointers listed by the matched rule.
When a tool description includes its external `inputSchema`, the edited
arguments are validated against it before they are tokenized and recorded.
The PII-aware tool port resolves unchanged tokens only in memory during this
validation; durable arguments remain tokenized. Tool descriptions without an
`inputSchema` skip schema validation, but still enforce editable pointers and
tokenize edited arguments before recording.

## Approval expiry and escalation

An `ask` rule can set `approvalTtlMs` to deny an approval once it expires, and
`escalateAfterMs` to notify a human while the approval is still pending. If both
are set, the escalation threshold must precede expiry. Run
`harness approvals sweep` to process pending approvals; expiry takes precedence
at its boundary and is recorded as a denied `approval_resolved` event with
`decidedBy: expiry` and `reason: expired`. Sweeping is a one-shot CLI operation,
not a background service.

The CLI emits escalation notifications as metadata-only log lines. The policy
package also provides `WebhookNotifier` for integrations that resolve its URL
from a `SecretRef`; its strict payload contains run, approval, tool, and rule
IDs plus approval age, never tool arguments.
Control-plane integrations can invoke the sweep periodically.
