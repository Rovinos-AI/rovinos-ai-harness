# Quotas

Configure cross-run limits in the top-level `quotas` array. Each entry has a
unique `id`, a `match` selector, and one or more limits:

```yaml
quotas:
  - id: research_team
    match:
      requestedBy: [token.example]
      role: [researcher]
    dailyCostUsd: 25
    monthlyCostUsd: 400
    maxConcurrentRuns: 3
    maxRunsPerHour: 20
```

Each quota matches when every selector it specifies matches the run. Omitting
both selectors applies the quota to all runs. A run may match several quotas;
all matching limits apply. `requestedBy` matches the principal recorded on
`run_created`, and `role` matches the role selected for the run.

Daily, monthly, and hourly periods use UTC boundaries. Model cost is charged in
integer micro-dollars to each matching daily and monthly period in the same
store transaction as the event recording that usage. Run starts increment the
hourly counter atomically with the initial run events. A start rejected by an
exhausted cost or hourly limit writes no run events and returns the typed
`quota_exceeded` error (CLI exit code 9).

Before a model call, the runtime checks the current daily and monthly ledger
totals. If a limit has been reached, it records `budget_exceeded` with
`budget: quota`, marks the run failed, and does not issue another model call.
Because final cost is reported by the model response, a response already in
flight can bring a period above its configured limit; that usage is still
recorded atomically and subsequent model calls are stopped. Concurrent runs may
all pass the pre-call check before any response is charged, so their in-flight
cost can overshoot a shared limit; this is not a spend reservation.

`maxConcurrentRuns` is currently inert: the worker queue does not yet call the
quota claim check. It will be enforced atomically at worker claim time by task
24.3 (#232); until then, configuring this field does not limit concurrent runs.

Quota rejections increment `harness.quota.rejections` with the configured quota
code as the only attribute. Principal identities are not included in metrics.
