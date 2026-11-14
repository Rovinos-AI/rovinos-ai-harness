# Rejected app spans

## What this alert means

The host rejected application-provided spans because they failed a schema, size, rate, application, tool, or session limit. The bounded reason label is suitable for triage; it does not identify a run.

## Immediate steps

- Check the alert window, reason distribution, and recent application or configuration changes.
- Confirm the application is using registered span names and bounded attributes.
- If rejection continues, disable the affected instrumentation or stop the application integration while preserving the rejection counts.

## Find affected runs

Use the control plane or `harness inspect` to identify a related run using its run ID from safe event metadata. Do not correlate by adding run IDs to metric dimensions.

## Inspect safely

Use `harness inspect <run-id>` and, if useful, `harness replay <run-id>` to review safe event metadata and event sequence. Keep raw application span payloads out of shared diagnostics.

## Containment

Revoke affected application tokens if misuse is suspected, stop the integration when it is generating sustained invalid data, and rotate credentials using the task 12.5 procedure if exposure is suspected.

## Escalation

Escalate repeated schema or rate rejections to the application owner and telemetry maintainer. Escalate suspected misuse or exposure to the security incident owner.
