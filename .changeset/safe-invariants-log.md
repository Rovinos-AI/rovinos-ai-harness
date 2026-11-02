---
"@rovinos/cli": patch
---

# Keep invariant graders non-failing when event logs are unavailable

The invariant graders report an `invariant_event_log_unavailable` code without failing trials when an executor does not expose events. Report schema defaults now agree that invariant checks are enabled.
