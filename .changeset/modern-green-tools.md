---
"@rovinos/cli": patch
"@rovinos/sdk": patch
---

# Preserve camelCase MCP tool names

Allow MCP server tool names whose only normalization change is lowercasing. Continue rejecting names whose characters normalization replaces or collapses.
