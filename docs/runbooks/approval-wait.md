# Approval wait

## What this alert means

The p95 time between an approval request and its recorded decision exceeded the configured threshold. Safe events also record completed expiry decisions; they do not predict that an outstanding approval is close to expiry.

## Immediate steps

- Check the approval wait distribution and decision types for the alert window.
- Confirm the approval application and human decision channel are healthy.
- Do not bypass approval policy to reduce wait time.

## Find affected runs

Use the control plane or `harness inspect` to identify suspended runs by run IDs from safe event metadata. Share only the minimum metadata required with the approver.

## Inspect safely

Use `harness inspect <run-id>` and `harness replay <run-id>` to review the approval status and safe decision events. Never infer approval authority from model output.

## Containment

If the approval service is unavailable, pause work that requires human approval. Revoke compromised tokens, stop affected services when needed, and rotate credentials through task 12.5 if exposure is suspected.

## Escalation

Escalate application or delivery delays to the approval-service operator and the designated human approver. Escalate any attempted policy bypass to security.
