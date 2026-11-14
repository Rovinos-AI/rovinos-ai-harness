# No safe telemetry received

## What this alert means

No registered safe event logs arrived during the configured window. The collector, pipeline, service, or expected workload may be unavailable; an idle workload can also produce no events.

## Immediate steps

- Confirm whether the deployment should have been producing telemetry in the alert window.
- Check service health, collector health, exporter queue/retry state, and backend ingestion health.
- Preserve collector status and bounded error codes; do not capture raw telemetry payloads.

## Find affected runs

Use the control plane to identify runs active in the alert window. If safe event metadata is available, use the run ID with `harness inspect`; do not infer missing data from model content.

## Inspect safely

Use `harness inspect <run-id>` and `harness replay <run-id>` for available safe events. Compare event sequence and timestamps with collector/backend ingestion metadata.

## Containment

Pause affected services if their safety policy requires telemetry. Revoke tokens if unauthorized changes are suspected, stop an unhealthy pipeline before recovery, and rotate credentials through task 12.5 if exposure is suspected.

## Escalation

Escalate collection gaps to the service and telemetry pipeline operators. Include the alert window, policy version, and bounded status codes; keep any run identifiers in the restricted control plane.
