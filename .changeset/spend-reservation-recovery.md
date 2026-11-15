---
"@rovinos/store-sqlite": minor
"@rovinos/store-postgres": minor
---

# Spend reservation recovery

Strict spend reservations now recover after an expired worker lease. Reserved attempts that never dispatched are released, and dispatching attempts become uncertain and keep blocking their quota period. Operators can record an audited waiver for an uncertain attempt. Adds migration `0015_spend_reservation_operator_resolution`.
