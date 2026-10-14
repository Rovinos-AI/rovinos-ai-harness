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
An idempotency key is deduplicated only within this `Harness` instance; it is not persisted across
instances or restarts. Run the worker-backed queue mode only after task 24.2 is available.

An optional `role` is passed to model routing. `requestedBy` is validated but not recorded because
the current `run_created` event contract has no audit field for it. It is not an authorization
mechanism.

## Metadata and events

`getRun` and `listRuns` return run status, usage totals, approval identifiers, pagination metadata,
and `SafeEvent`s only. `watch` yields safe events in sequence order and supports `fromSeq` and an
optional `AbortSignal`. Call `close` to stop subscriptions, wait for detached runs, and release
resources.

## Explicit content access

Content is omitted from normal results. `getRunContent(runId, { reveal: false })` is the explicit
content-reading operation. It returns only content fields from stored events and is available only
when PII tokenization is enabled; treat the returned tokenized values as sensitive. It never
detokenizes values. Set `pii.enabled` to `true` (the default) when content access is needed.

## Approvals and human input

`resolveApproval` resolves a pending approval by id and decision. The `principal` input is validated
but is not recorded: the current `approval_resolved` event contract has no principal field. The
event records `decidedBy: "human"`. Do not use `principal` as an authorization check; approval
authority must be enforced by the embedding application. For `edit`, the runtime applies its
PII-aware tool validation.

`answerInput(requestId, ...)` is reserved for the epic 25 human-input contract and currently rejects
with the safe `sdk_input_unavailable` code. Its `requestId` and options are validated and are not
included in that error.

## Decisions and scope

- Idempotency is in-memory and instance-scoped until the durable queue in task 24.2 defines
  persistent idempotency semantics; calls made by another `Harness` instance or after restart are
  not deduplicated.
- `requestedBy` is validated but not persisted until the event contract provides an audit field.
- The SDK does not add principal data to an existing event schema. A future schema task must define
  that audit field before the SDK can persist the `resolveApproval` principal.
- The input-answer API is present for the documented SDK shape but remains unavailable until its
  owning human-input contract is implemented (human input broker 25.3, issue #241).
