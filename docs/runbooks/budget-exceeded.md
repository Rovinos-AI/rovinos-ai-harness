# Budget exceeded

## What this alert means

One or more safe `budget_exceeded` events were observed within the configured window. The event records a bounded budget kind and numeric limit/observation metadata, not the run's prompt or output.

## Immediate steps

- Check the budget kind and alert window, then compare against the deployment's approved budget configuration.
- Pause new work if spending or execution limits are being exceeded unexpectedly.
- Preserve relevant billing and safe event metadata for the incident record.

## Find affected runs

Use the control plane or `harness inspect` to find run IDs from safe event metadata; restrict that correlation to authorized operators.

## Inspect safely

Use `harness inspect <run-id>` and `harness replay <run-id>` to review safe status and budget events. Do not attach prompts, tool arguments, provider output, or raw event payloads to the alert.

## Containment

Stop or rate-limit the affected service, apply the approved budget configuration, revoke tokens if unauthorized usage is suspected, and rotate credentials using task 12.5 when exposure is suspected.

## Escalation

Escalate cost or quota anomalies to the service owner and finance/on-call contact. Escalate suspected credential misuse to security.
