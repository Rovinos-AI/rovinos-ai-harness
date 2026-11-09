# Public SDK

`@rovinos/sdk` is the stable programmatic interface for applications that embed the harness.
Create a harness from a validated configuration object or a config file path:

```ts
import { createHarness } from "@rovinos/sdk";

const harness = await createHarness({ configPath: "harness.config.yaml" });
const { runId } = await harness.startRun({
  goal: "Summarize the synthetic project status.",
  idempotencyKey: "synthetic-status-summary",
});
```

Without a configured run queue, `startRun` launches execution in-process and returns its id with
`pending` status after the initial run events are durable, while execution continues detached.
`continueRun` and `resumeRun` instead wait until their in-process execution finishes or suspends.
Idempotency keys are deduplicated across `Harness` instances sharing the same store and persist
across restarts. Use opaque identifiers only; do not include sensitive data. The store retains only
the domain-separated, unsalted SHA-256 hash, never the raw key, so low-entropy keys may be guessed
from the table. When a run queue is configured, operate a worker for that queue; otherwise, execution
continues in-process.

The SDK uses SQLite by default. Supply a custom event store through `overrides.store` when needed;
durable SQLite and Postgres stores can also be selected through configuration.

An optional `role` is passed to model routing. `requestedBy` records the run's requesting principal
in `run_created` metadata; it is not an authorization mechanism.

## MCP tool profiles

Configure named MCP tool subsets with `toolProfiles`, then select one for a new run:

```ts
const { runId } = await harness.startRun({
  goal: "Summarize the synthetic issue.",
  toolProfile: "inspect",
});
```

The profile is validated against the server catalog after server allowlists are applied. Profiles
only narrow which MCP definitions are sent to the model; tool calls still pass through policy and
approval. `continueRun` accepts the same option. Profiles apply to new runs only; active runs and
resumed runs keep the MCP tool fingerprints recorded at creation. See
[configuration](configuration.md#mcp-tool-profiles) for limits and examples.

## Metadata and events

`getRun` and `listRuns` return run status, usage totals, approval identifiers, pagination metadata,
and `SafeEvent`s only. `watch` yields safe events in sequence order and supports `fromSeq` and an
optional `AbortSignal`. Call `close` to stop subscriptions, wait for detached runs, and release
resources. Closing a harness rejects new starts, continuations, and resumes. Existing reads and
cancellation requests remain available while admitted executions drain. `close()` waits up to
`run.shutdownGraceMs`, then aborts remaining in-process executions with shutdown semantics; they
suspend and can be resumed by a later client. The runtime and its resources are closed only after
those executions settle. Jobs owned by external queue workers are not cancelled.

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

`answerInput(requestId, ...)` resolves a pending human-input request by its identifier. The request
identifier is supplied by the human-input surface, not by the model. Accepted content is validated
against the recorded schema, tokenized before it is durably recorded, and never returned in the
metadata-only resolution result. Treat the answer as sensitive while collecting it; do not log it.

```ts
import { PrincipalSchema, type Harness, type RunId } from "@rovinos/sdk";

export async function answerHumanInput(
  harness: Pick<Harness, "answerInput">,
  requestId: RunId,
): Promise<void> {
  await harness.answerInput(requestId, {
    action: "accept",
    content: { email: "synthetic@example.test" },
    principal: PrincipalSchema.parse("cli.operator"),
  });
}
```

Resolve a pending approval with the same validated principal contract:

```ts
import { PrincipalSchema, type Harness, type RunId } from "@rovinos/sdk";

export async function resolveApproval(
  harness: Pick<Harness, "resolveApproval">,
  approvalId: RunId,
): Promise<void> {
  await harness.resolveApproval(approvalId, "approve", {
    principal: PrincipalSchema.parse("cli.operator"),
  });
}
```

With a configured run queue, resolution enqueues the run for a worker. Without a queue, resume it
explicitly with `await harness.resumeRun(resolution.runId)`.

## Decisions and scope

- (verify) Durable SDK idempotency uses an `idempotency_keys` store table, rather than event
  metadata, so the raw key and its hash stay out of the event contract. The store atomically
  inserts or retrieves the run id and removes the record when that run is deleted.
- Input resolution is durable and available through the public SDK; without a run queue,
  applications are responsible for calling `resumeRun` after `answerInput`.
