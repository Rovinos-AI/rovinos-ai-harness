# Provider error and fallback rate

## What this alert means

This monitor counts failed runs whose safe status reason is `model_error`. It is a provider-error proxy, not a fallback-rate measurement: the current safe-event contract does not expose fallback depth.

## Immediate steps

- Check the alert window and provider availability using the provider's operational status channel.
- Compare the count with service health and recent configuration changes.
- Avoid placing provider error details, prompts, or responses in the incident record.

## Find affected runs

Use the control plane or `harness inspect` to identify affected run IDs from safe status events. Keep run-level correlation in the restricted control plane, not in metric dimensions.

## Inspect safely

Use `harness inspect <run-id>` and `harness replay <run-id>` to review safe status and model-call metadata. Provider errors are represented by closed error codes; do not request raw exception messages or model content.

## Containment

Pause affected model work or disable an unhealthy provider according to the deployment's approved routing policy. Revoke tokens if misuse is suspected and rotate credentials using task 12.5 if exposure is suspected.

## Escalation

Escalate provider failures to the model/provider operator. Track fallback-rate observability as a separate reviewed telemetry requirement; do not derive it from fields absent from the safe-event contract.
