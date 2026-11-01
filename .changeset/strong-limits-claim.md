---
"@rovinos/cli": patch
"@rovinos/store-sqlite": patch
"@rovinos/store-postgres": patch
---

# Enforce concurrent run quotas when claiming jobs

Worker claims now defer matching jobs while their configured concurrent-run quota is full.
