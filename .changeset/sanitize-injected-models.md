---
"@rovinos/sdk": patch
"@rovinos/cli": patch
---

# Sanitize requests to injected model ports

With PII enabled, an injected `ModelPort` now receives the same sanitized requests as the configured model gateway.
