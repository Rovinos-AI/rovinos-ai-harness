---
"@rovinos/cli": patch
---

# Eval and replay report viewer

`harness serve` adds a read-scoped `open_report` control-plane tool and the `ui://harness/reports/v1` MCP App for eval, comparison, and replay reports. Reports load only from directories listed in the new `controlPlane.reportDirs` setting, which defaults to an empty list.
