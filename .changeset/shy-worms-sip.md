---
"@rovinos/cli": patch
"@rovinos/sdk": patch

---

# Bound telemetry metric cardinality

Add a per-metric series cap and drop excess datapoints, and use bounded telemetry attribute names
that avoid identifiers being treated as high-cardinality data.
