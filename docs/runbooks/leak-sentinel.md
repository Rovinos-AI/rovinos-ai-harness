# Leak sentinel

## Suspected telemetry leak

### What this alert means

The telemetry allowlist or PII sentinel rejected an export payload. A nonzero count means the payload was dropped; investigate before changing filtering rules or restarting the exporter.

### Immediate steps

- Page the on-call privacy/security contact and record the alert window, monitor query, and bounded event metadata.
- Preserve relevant collector and backend audit evidence before cleanup. Do not copy prompts, tool arguments, completions, or raw PII into the incident record.
- Pause the affected telemetry exporter or service if trips continue.

### Find affected runs

Use the control plane or `harness inspect` to identify the run from its run ID in safe event metadata. Limit access to the incident responders; do not use run IDs as metric labels.

### Inspect safely

Use `harness inspect <run-id>` and, when needed, `harness replay <run-id>` to review the recorded safe events. Compare signal, policy version, and event sequence metadata; do not inspect raw exporter payloads in shared channels.

### Containment

Preserve evidence, then purge affected exporter data at the backend using the backend's audited deletion procedure. Revoke exposed tokens, stop the affected service if the issue persists, and rotate credentials using the key-rotation procedure in task 12.5. Keep the sentinel enabled while investigating.

### Escalation

Escalate suspected exposure to the privacy/security incident owner and the backend operator. Record the scope, retention/deletion confirmation, and follow-up validation before restoring export.
