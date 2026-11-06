---
"@rovinos/cli": patch
---

# Run live evals through a host-side model gateway

Require explicit live opt-in, cap provider requests across each run, and keep Docker
trials network-disabled with host-only provider credentials over a Unix socket.
Include the eval collector's existing runtime dependency in production CLI images.
