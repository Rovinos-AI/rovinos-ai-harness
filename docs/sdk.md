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

## MCP server onboarding

The SDK helpers support the configure, inspect, select, and start flow without importing internal
packages. Registration is configuration-only: it does not change an already-created harness and it
sets `toolAllowlist` to an empty list unless you explicitly provide one. Inspection connects to the
server and reads its catalog without calling tools. Tool descriptions and schemas are untrusted server
content.

```ts
import {
  createHarness,
  inspectMcpServer,
  registerMcpServer,
  selectMcpTools,
} from "@rovinos/sdk";

const registered = registerMcpServer(
  {},
  {
    id: "weather",
    transport: {
      kind: "stdio",
      command: "/absolute/path/to/weather-mcp",
      env: { WEATHER_API_KEY: "env:WEATHER_API_KEY" },
    },
  },
);
const server = registered.servers.find(({ id }) => id === "weather");
if (server === undefined) throw new Error("configured_server_missing");

const inspection = await inspectMcpServer(server, {
  resolveSecret: async (ref) => {
    if (ref !== "env:WEATHER_API_KEY") throw new Error("secret_reference_not_configured");
    const value = process.env.WEATHER_API_KEY;
    if (value === undefined) throw new Error("secret_reference_unavailable");
    return value;
  },
});
const reviewed = selectMcpTools(registered, inspection, ["forecast"]);
const selectedToolIds = reviewed.selection.tools.map(({ toolId }) => toolId);
const harness = await createHarness({ config: reviewed.config });
try {
  await harness.startRun({ goal: "Use the selected forecast tool." });
} finally {
  await harness.close();
}
```

`inspection.tools` lists every valid candidate and indicates whether it is currently exposed.
`selection.tools` is the exact exposure preview, including normalized tool ids. Selecting tools only
controls model exposure; every call still passes through the run's `allow`, `ask`, or `deny` policy.
`selection.authorization` is always `policy_unchanged`. Policy independently supports explicit
allow, ask, and deny decisions; the default must remain `ask` or `deny`:

```yaml
version: 1
defaultDecision: deny
rules:
  - id: allow_forecast
    match:
      tools: [weather.forecast]
    decision: allow
    reason: forecast_reviewed
  - id: review_report
    match:
      tools: [weather.send_report]
    decision: ask
    reason: human_review_required
  - id: deny_delete
    match:
      tools: [weather.delete_record]
    decision: deny
    reason: delete_not_permitted
```

Do not turn discovery into blanket permission. Re-inspect and explicitly review the selection after
catalog changes; runs pin the catalog they were shown and fail closed if a selected tool changes
before dispatch. Secret values are resolved only at the transport boundary; configuration contains
`env:`, `file:`, or `akv:` references.

Configuration and selection validation errors use `SdkError` codes
`sdk_mcp_config_invalid`, `sdk_mcp_server_exists`, `sdk_mcp_server_not_found`,
`sdk_mcp_tool_not_found`, `sdk_mcp_catalog_invalid`, and `sdk_mcp_selection_invalid`.
Invalid inspection options use `sdk_mcp_inspection_options_invalid`; connection failures retain
their existing `mcp_*` codes; unexpected inspection failures use `sdk_mcp_inspection_failed`.

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

For incremental access, `streamRunContent` is a separate, tokenized-only API. Configure a trusted
`contentAuthorizer` when creating the harness; it receives the validated principal and run id and
must bind that principal to the embedding application's authenticated caller and run-level
permissions. Streaming is denied when no authorizer is configured, and the decision is checked
before opening the stream and before yielding each content item. Abort the supplied `signal` on
cancellation or when permissions are revoked. A grant cannot recall values already yielded.

The stream yields only content from committed event-log entries and labels each item
`durability: "committed"`. Provider/model deltas that were not persisted are not exposed or replayed.
`fromSeq` is an inclusive event sequence cursor; to resume after the last item received, use
`lastItem.seq + 1`. Reconnecting from the same cursor can repeat an item. The SDK reads at most one
stored event at a time and does not enqueue items ahead of the async iterator consumer, so a slow
consumer applies backpressure while committed events remain in the configured store. Replay lasts
only as long as the event log retains the run; there is no separate content-stream retention.

The stream never reveals raw values. The embedding application must use a separate explicitly authorized reveal
operation if one is needed; no reveal option is accepted by the stream. Neither this API nor
`getRunContent` changes the content-free contract of `watch`, safe events, MCP metadata
notifications, or telemetry. See [ADR 0007](decisions/0007-authorized-content-streaming.md) for the
threat model and limitations.

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
