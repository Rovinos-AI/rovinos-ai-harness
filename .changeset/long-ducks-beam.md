---
"@rovinos/sdk": patch
"@rovinos/cli": patch
---

# Bound MCP discovery work

Bound MCP discovery pages, observed tools, decoded data, and total running time.
Queue discoveries in FIFO order with at most four running concurrently, and
support cancellation while waiting or running. Discovery fails closed when a
work budget is exceeded, which can reject previously accepted servers.
