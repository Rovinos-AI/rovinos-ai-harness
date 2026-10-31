---
"@rovinos/cli": patch
---

# PII policy explanation

Add `harness pii explain` with single-decision and matrix output.

Local model inputs now receive tokenized values by default, including when a policy rule allows raw values. Set `pii.allowRawToLocalModels: true` to preserve the previous raw-value behavior for local models.
