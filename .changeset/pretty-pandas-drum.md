---
"@rovinos/sdk": patch
"@rovinos/cli": patch
---

# Reject unsupported outbound MCP Apps

Outbound MCP Apps configuration with `apps: true` is now rejected. Omit the
setting or set it to `false`; outbound Apps hosting is not supported.
