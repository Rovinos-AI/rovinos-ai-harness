---
"@rovinos/sdk": minor
"@rovinos/cli": minor
"@rovinos/store-sqlite": minor
"@rovinos/store-postgres": minor
---

# Represent incomplete and unknown cost explicitly

Costs and run totals now carry a versioned completeness state: known, estimated, partial or unknown. Unknown cost is never counted as zero. With a cost cap set, unknown or partial cost stops the run with `budget_cost_unknown` unless `unknownCostPolicy: allow` is configured.
