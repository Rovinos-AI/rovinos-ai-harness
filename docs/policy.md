# Policy documents

Policies make deterministic decisions in code before a tool runs. They operate
on tokenized arguments and never see raw sensitive values.

The policy format is versioned and strict. Its default decision must be `ask`
or `deny`; rules can match tool IDs, argument pointers, and request context.
When rules match, the evaluator uses the most restrictive decision.

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
