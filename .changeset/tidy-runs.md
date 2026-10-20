---
"@harness/sdk": minor
---

# Model-driven control-plane run creation

Add the `start_run` and `continue_run` control-plane tools. Model-driven clients require human
confirmation unless `controlPlane.allowAgentStartedRuns` is enabled. `Runtime.continueRun` now
returns a lifecycle handle with a durable-start promise and a completion promise, allowing the
control plane to return pending metadata without waiting for the run to finish.
