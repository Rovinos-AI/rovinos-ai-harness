# Public SDK

`@harness/sdk` is the stable programmatic interface for applications that embed the harness.
Create a harness from a validated configuration object or a config file path:

```ts
import { createHarness } from "@harness/sdk";

const harness = await createHarness({ configPath: "harness.config.yaml" });
const { runId } = await harness.startRun({
  goal: "Summarize the synthetic project status.",
  idempotencyKey: "synthetic-status-summary",
});
```

Without a configured run queue, `startRun` launches execution in-process and returns its id with
`pending` status after the initial run events are durable, while execution continues detached.
Idempotency keys are deduplicated across `Harness` instances sharing the same store and persist
across restarts. Use opaque identifiers only; do not include sensitive data. The store retains only
the domain-separated, unsalted SHA-256 hash, never the raw key, so low-entropy keys may be guessed
from the table. Run the worker-backed queue mode only after task 24.2 is available.

An optional `role` is passed to model routing. `requestedBy` records the run's requesting principal
in `run_created` metadata; it is not an authorization mechanism.

## Metadata and events

`getRun` and `listRuns` return run status, usage totals, approval identifiers, pagination metadata,
and `SafeEvent`s only. `watch` yields safe events in sequence order and supports `fromSeq` and an
optional `AbortSignal`. Call `close` to stop subscriptions, wait for detached runs, and release
resources.

Requester and approver principals are omitted from safe events by default. When
`telemetry.correlation.enabled` is true, safe events include keyed pseudonyms for recorded
principals; raw principal values are never projected.

## Explicit content access

Content is omitted from normal results. `getRunContent(runId, { reveal: false })` is the explicit
content-reading operation. It returns only content fields from stored events and is available only
when PII tokenization is enabled; treat the returned tokenized values as sensitive. It never
detokenizes values. Set `pii.enabled` to `true` (the default) when content access is needed.

## Approvals and human input

`resolveApproval` resolves a pending approval by id and decision. Its `principal` is required and
recorded as `approval_resolved.approverId`; requester and approver principals use the kind-prefixed
`Principal` contract. For `edit`, the runtime applies its PII-aware tool validation.

`answerInput(requestId, ...)` is reserved for the epic 25 human-input contract and currently rejects
with the safe `sdk_input_unavailable` code. Its `requestId` and options are validated and are not
included in that error.

## Decisions and scope

- (verify) Durable SDK idempotency uses an `idempotency_keys` store table, rather than event
  metadata, so the raw key and its hash stay out of the event contract. The store atomically
  inserts or retrieves the run id and removes the record when that run is deleted.
- The input-answer API is present for the documented SDK shape but remains unavailable until its
  owning human-input contract is implemented (human input broker 25.3, issue #241).
