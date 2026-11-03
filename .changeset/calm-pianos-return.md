---
"@rovinos/sdk": patch
"@rovinos/cli": patch
---

# Configure MCP binary result handling

MCP tool results now keep every part in order. Binary result parts are blocked by default; allow them per server with `binaryResults: allow`, within `maxArtifactBytes`.
