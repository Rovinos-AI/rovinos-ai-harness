# @rovinos/store-sqlite

## 0.3.0

### Minor Changes

- cbbe0fa: # Spend reservation recovery

  Strict spend reservations now recover after an expired worker lease. Reserved attempts that never dispatched are released, and dispatching attempts become uncertain and keep blocking their quota period. Operators can record an audited waiver for an uncertain attempt. Adds migration `0015_spend_reservation_operator_resolution`.
- f1a7793: # Represent incomplete and unknown cost explicitly

  Costs and run totals now carry a versioned completeness state: known, estimated, partial or unknown. Unknown cost is never counted as zero. With a cost cap set, unknown or partial cost stops the run with `budget_cost_unknown` unless `unknownCostPolicy: allow` is configured.

### Patch Changes

- 83be569: # Update minor and patch runtime dependencies
- 0d90c26: # Durable SQLite spend reservations

  Add durable SQLite spend reservations with atomic quota checks, event appends, and settlement.
- Updated dependencies [122052e]
- Updated dependencies [a5b55f8]
- Updated dependencies [3765be6]
- Updated dependencies [dacb3da]
- Updated dependencies [f4a9843]
- Updated dependencies [83be569]
- Updated dependencies [6a9f07f]
- Updated dependencies [402651d]
- Updated dependencies [80a3fe1]
- Updated dependencies [5aefb96]
- Updated dependencies [f1a7793]
  - @rovinos/sdk@0.3.0

## 0.2.0

### Minor Changes

- Release v0.2.0: SDK execution lifecycle with drain-then-suspend shutdown, live-model evals through a
  host-side gateway, MCP result envelopes, and the other v0.2.0 milestone changes listed below.

### Patch Changes

- 38e0c4f: # Enforce concurrent run quotas when claiming jobs

  Worker claims now defer matching jobs while their configured concurrent-run quota is full.
- Updated dependencies [6b2ad35]
- Updated dependencies [fa11fee]
- Updated dependencies [f5dcaac]
- Updated dependencies [8898749]
- Updated dependencies [202681f]
- Updated dependencies [7cec563]
- Updated dependencies [ac1557e]
- Updated dependencies [c82b800]
- Updated dependencies [eac4076]
- Updated dependencies [a823dce]
- Updated dependencies [b02a17a]
- Updated dependencies [998506a]
- Updated dependencies [93a3179]
- Updated dependencies [f6ac60b]
- Updated dependencies [55f14d2]
- Updated dependencies [463fbf9]
- Updated dependencies [6be9a2e]
- Updated dependencies
- Updated dependencies [d60a8bb]
- Updated dependencies [562de70]
- Updated dependencies [dfb99d8]
- Updated dependencies [a0b7365]
  - @rovinos/sdk@0.2.0

## 0.1.0

### Minor Changes

- ce5f37d: # Cross-run quotas

  Add cross-run quotas, persist quota role identity, and account for usage with model responses.

### Patch Changes

- Updated dependencies [e32d43b]
- Updated dependencies [389467e]
- Updated dependencies [c326600]
- Updated dependencies [1dec2c2]
- Updated dependencies
- Updated dependencies [a901dd5]
- Updated dependencies [96e2220]
- Updated dependencies [1605044]
- Updated dependencies [ce5f37d]
- Updated dependencies [b21ef64]
- Updated dependencies [7042868]
  - @rovinos/sdk@0.1.0
