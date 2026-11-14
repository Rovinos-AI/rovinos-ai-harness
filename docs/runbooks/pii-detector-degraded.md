# PII detector degraded

## What this alert means

The detector reported degraded operation. Depending on policy, affected runs may have been held, reduced, or handled with a fallback behavior; confirm the configured policy before resuming work.

## Immediate steps

- Check detector health, queue health, and the alert's bounded count and time window.
- Pause workflows that require the detector if its policy requires a healthy detector.
- Preserve health and policy-version metadata without copying input or detector content.

## Find affected runs

Use the control plane or `harness inspect` to locate runs from run IDs in safe event metadata for the affected time window.

## Inspect safely

Use `harness inspect <run-id>` and `harness replay <run-id>` to review tokenized/safe events and status transitions. Do not export detector inputs or raw match values to logs.

## Containment

Stop the affected service if the detector cannot recover under its configured policy. Revoke tokens if misuse is suspected and rotate credentials through the task 12.5 procedure when required.

## Escalation

Escalate to the detector operator and privacy/security owner. Record the policy decision, recovery evidence, and any affected run IDs in the restricted incident record.
