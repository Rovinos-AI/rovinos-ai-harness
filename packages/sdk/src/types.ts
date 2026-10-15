// SPDX-License-Identifier: Apache-2.0
import { Code, HarnessError, Id, JsonValue, RunStatus } from "@harness/schemas";
import type { RuntimeOverrides } from "@harness/core";
import { HarnessConfigSchema } from "@harness/config";
import { SafeEvent } from "@harness/telemetry";
import { z } from "zod";

function hasMethod(value: unknown, name: string): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    name in value &&
    typeof Reflect.get(value, name) === "function"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const eventStoreSchema = z.custom<NonNullable<RuntimeOverrides["store"]>>((value) =>
  [
    "append",
    "appendWithSnapshot",
    "latestSnapshot",
    "read",
    "watch",
    "watchRuns",
    "head",
    "deleteRun",
    "listRuns",
    "findRunsByTrace",
    "fetchOutbox",
    "ackOutbox",
    "claimApprovalNotification",
    "markApprovalNotificationSent",
    "releaseApprovalNotification",
    "consumeConfirmationState",
    "close",
  ].every((method) => hasMethod(value, method)),
);
const clockSchema = z.custom<NonNullable<RuntimeOverrides["clock"]>>((value) =>
  hasMethod(value, "now"),
);
const idsSchema = z.custom<NonNullable<RuntimeOverrides["ids"]>>((value) =>
  hasMethod(value, "next"),
);
const modelSchema = z.custom<NonNullable<RuntimeOverrides["model"]>>((value) =>
  hasMethod(value, "complete"),
);
const toolSchema = z.custom<NonNullable<RuntimeOverrides["tool"]>>(
  (value) => hasMethod(value, "describe") && hasMethod(value, "execute"),
);
const policySchema = z.custom<NonNullable<RuntimeOverrides["policy"]>>((value) =>
  hasMethod(value, "decide"),
);
const contextSchema = z.custom<NonNullable<RuntimeOverrides["context"]>>((value) =>
  hasMethod(value, "build"),
);
const providerAdapterSchema = z.custom<NonNullable<RuntimeOverrides["providerAdapters"]>[number]>(
  (value) =>
    isRecord(value) &&
    typeof value.provider === "string" &&
    typeof value.kind === "string" &&
    hasMethod(value, "complete"),
);
const scopeRegistrySchema = z.custom<NonNullable<RuntimeOverrides["scopeRegistry"]>>(
  (value) => hasMethod(value, "scopeOf") && hasMethod(value, "register"),
);
const processLikeSchema = z.custom<NonNullable<RuntimeOverrides["processLike"]>>(
  (value) =>
    isRecord(value) &&
    hasMethod(value, "on") &&
    hasMethod(value, "removeListener") &&
    hasMethod(value, "exit"),
);

/** Runtime adapters and deterministic dependencies injectable by applications and tests. */
export const HarnessOverridesSchema = z
  .object({
    store: eventStoreSchema.optional(),
    dataDir: z.string().optional(),
    roleConfigDirectory: z.string().optional(),
    readOnlyStore: z.boolean().optional(),
    transientVault: z.boolean().optional(),
    clock: clockSchema.optional(),
    ids: idsSchema.optional(),
    model: modelSchema.optional(),
    providerAdapters: z.array(providerAdapterSchema).optional(),
    secretResolver: z
      .custom<NonNullable<RuntimeOverrides["secretResolver"]>>((value) =>
        hasMethod(value, "resolve"),
      )
      .optional(),
    onKeysWarning: z
      .custom<NonNullable<RuntimeOverrides["onKeysWarning"]>>(
        (value) => typeof value === "function",
      )
      .optional(),
    tool: toolSchema.optional(),
    policy: policySchema.optional(),
    context: contextSchema.optional(),
    scopeRegistry: scopeRegistrySchema.optional(),
    processLike: processLikeSchema.optional(),
    flushTelemetry: z
      .custom<NonNullable<RuntimeOverrides["flushTelemetry"]>>(
        (value) => typeof value === "function",
      )
      .optional(),
  })
  .strict();

/** Dependencies used when embedding or testing the harness. */
export type HarnessOverrides = z.infer<typeof HarnessOverridesSchema>;

/** Configuration object or path and optional injectable runtime adapters. */
export const CreateHarnessOptionsSchema = z.union([
  z
    .object({
      config: HarnessConfigSchema,
      overrides: HarnessOverridesSchema.optional(),
    })
    .strict(),
  z
    .object({
      configPath: z.string().min(1),
      overrides: HarnessOverridesSchema.optional(),
    })
    .strict(),
]);

/** Validated options accepted by {@link createHarness}. */
export type CreateHarnessOptions = z.input<typeof CreateHarnessOptionsSchema>;

/** Branded ULID accepted by public run and approval operations. */
export type RunId = z.infer<typeof Id>;

const runMetadataSchema = z.record(Code, z.union([Code, z.number(), z.boolean()])).optional();
const goalSchema = z.string().min(1).max(8_000);

/** Input for starting a run. */
export const StartRunOptionsSchema = z
  .object({
    goal: goalSchema,
    metadata: runMetadataSchema,
    role: Code.optional(),
    idempotencyKey: z.string().min(1).max(256).optional(),
    requestedBy: Code.optional(),
  })
  .strict();

/** Inferred input for {@link Harness.startRun}. */
export type StartRunOptions = z.infer<typeof StartRunOptionsSchema>;

/** Input for continuing a terminal run. */
export const ContinueRunOptionsSchema = z
  .object({
    goal: goalSchema,
    metadata: runMetadataSchema,
  })
  .strict();

/** Inferred input for {@link Harness.continueRun}. */
export type ContinueRunOptions = z.infer<typeof ContinueRunOptionsSchema>;

/** Run identifier accepted by SDK operations. */
export const RunIdInputSchema = z.object({ runId: Id }).strict();

/** Human-input request identifier accepted by {@link Harness.answerInput}. */
export const RequestIdInputSchema = z.object({ requestId: Id }).strict();

/** Approval identifier accepted by SDK operations. */
export const ApprovalIdInputSchema = z.object({ approvalId: Id }).strict();

/** Filtering and pagination options for listing run metadata. */
export const ListRunsFilterSchema = z
  .object({
    status: RunStatus.optional(),
    continuationOf: Id.optional(),
    limit: z.number().int().min(1).max(100).default(20),
    cursor: z.string().optional(),
  })
  .strict();

/** Inferred run listing filter. */
export type ListRunsFilter = z.input<typeof ListRunsFilterSchema>;

/** Metadata-only run summary. */
export const RunSummarySchema = z
  .object({
    runId: Id,
    createdAt: z.number().int().nonnegative(),
    status: RunStatus,
    lastSeq: z.number().int().nonnegative(),
    lastTs: z.number().int().nonnegative(),
  })
  .strict();

/** Inferred metadata-only run summary. */
export type RunSummary = z.infer<typeof RunSummarySchema>;

/** Metadata-only page of run summaries. */
export const RunPageSchema = z
  .object({
    runs: z.array(RunSummarySchema),
    nextCursor: z.string().optional(),
  })
  .strict();

/** Inferred page returned by {@link Harness.listRuns}. */
export type RunPage = z.infer<typeof RunPageSchema>;

/** Metadata-only run details and content-free event projections. */
export const RunViewSchema = RunSummarySchema.extend({
  steps: z.number().int().nonnegative(),
  usage: z
    .object({
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
      costMicros: z.number().int().nonnegative(),
    })
    .strict(),
  pendingApprovals: z.array(Id),
  recentEvents: z.array(SafeEvent),
}).strict();

/** Inferred run details returned by {@link Harness.getRun}. */
export type RunView = z.infer<typeof RunViewSchema>;

/** Options for starting an SDK event subscription. */
export const WatchOptionsSchema = z
  .object({
    fromSeq: z.number().int().nonnegative().default(0),
    signal: z
      .custom<AbortSignal>(
        (value) =>
          typeof value === "object" &&
          value !== null &&
          hasMethod(value, "addEventListener") &&
          hasMethod(value, "removeEventListener"),
      )
      .optional(),
    maxBuffered: z.number().int().positive().optional(),
  })
  .strict();

/** Options accepted by {@link Harness.watch}. */
export type WatchOptions = z.input<typeof WatchOptionsSchema>;

/** Content access is intentionally restricted to the tokenized view. */
export const GetRunContentOptionsSchema = z.object({ reveal: z.literal(false) }).strict();

/** Options accepted by {@link Harness.getRunContent}. */
export type GetRunContentOptions = z.infer<typeof GetRunContentOptionsSchema>;

/** A single tokenized content entry from the event log. */
export const RunContentEntrySchema = z
  .object({
    seq: z.number().int().nonnegative(),
    type: z.enum([
      "run_input",
      "model_request",
      "model_response",
      "tool_intent",
      "tool_result",
      "approval_requested",
      "approval_resolved",
      "context_compacted",
    ]),
    content: JsonValue,
  })
  .strict();

/** Tokenized run content returned only by explicit request. */
export const RunContentSchema = z.array(RunContentEntrySchema);

/** Inferred tokenized content result. Treat values as sensitive. */
export type RunContent = z.infer<typeof RunContentSchema>;

/** A decision that can be applied to a pending approval. */
export const ApprovalDecisionSchema = z.enum(["approve", "deny", "edit"]);

/** Inferred human approval decision. */
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

/** Options used to resolve a human approval. */
export const ResolveApprovalOptionsSchema = z
  .object({
    edits: JsonValue.optional(),
    principal: Code,
  })
  .strict();

/** Options accepted by {@link Harness.resolveApproval}. */
export type ResolveApprovalOptions = z.infer<typeof ResolveApprovalOptionsSchema>;

/** Metadata-only result of resolving an approval. */
export const ApprovalResolutionResultSchema = z
  .object({
    runId: Id,
    approvalId: Id,
    decision: ApprovalDecisionSchema,
  })
  .strict();

/** Inferred metadata-only approval result. */
export type ApprovalResolutionResult = z.infer<typeof ApprovalResolutionResultSchema>;

/** Input accepted by the future human-input answer API. */
export const AnswerInputOptionsSchema = z
  .object({
    action: Code,
    content: JsonValue.optional(),
    principal: Code,
  })
  .strict();

/** Options accepted by {@link Harness.answerInput}. */
export type AnswerInputOptions = z.infer<typeof AnswerInputOptionsSchema>;

/** Metadata-only result returned by {@link Harness.startRun} and {@link Harness.continueRun}. */
export const RunStartResultSchema = z.object({ runId: Id, status: RunStatus }).strict();

/** Inferred metadata-only run start result. */
export type RunStartResult = z.infer<typeof RunStartResultSchema>;

/** Result of a cooperative run cancellation. */
export const CancelRunResultSchema = z.enum(["cancelled", "already_terminal"]);

/** Inferred cancellation result returned by {@link Harness.cancelRun}. */
export type CancelRunResult = z.infer<typeof CancelRunResultSchema>;

/** Public stable SDK operations. */
export interface Harness {
  /**
   * Start a detached run and return after its initial events are durable.
   *
   * Idempotency keys are opaque identifiers and must not contain sensitive data. Their unsalted
   * SHA-256 hashes are stored, so low-entropy keys may be guessed from the store.
   * `requestedBy` is validated but not recorded by the current event contract.
   */
  startRun(options: StartRunOptions): Promise<RunStartResult>;
  /** Start a linked follow-up run for a completed run. */
  continueRun(runId: RunId, options: ContinueRunOptions): Promise<RunStartResult>;
  /** Read run status, usage, approval identifiers, and recent safe events. */
  getRun(runId: RunId): Promise<RunView>;
  /** List metadata-only run summaries using an opaque continuation cursor. */
  listRuns(filter?: ListRunsFilter): Promise<RunPage>;
  /** Resume a suspended run in-process and return its resulting status. */
  resumeRun(runId: RunId): Promise<RunStartResult>;
  /** Request cooperative cancellation of a run. */
  cancelRun(runId: RunId): Promise<CancelRunResult>;
  /**
   * Resolve a pending approval; `principal` is validated but not recorded by the current event contract.
   * The event records `decidedBy: "human"`.
   */
  resolveApproval(
    approvalId: RunId,
    decision: ApprovalDecision,
    options: ResolveApprovalOptions,
  ): Promise<ApprovalResolutionResult>;
  /** Answer a human-input request; validates `requestId` before reporting that epic 25 is unavailable. */
  answerInput(requestId: RunId, options: AnswerInputOptions): Promise<never>;
  /** Watch content-free safe events in sequence order. */
  watch(runId: RunId, options?: WatchOptions): AsyncIterable<SafeEvent>;
  /** Explicitly read tokenized content. This method returns sensitive data. */
  getRunContent(runId: RunId, options: GetRunContentOptions): Promise<RunContent>;
  /** Stop subscriptions, wait for detached operations, and release runtime resources. */
  close(): Promise<void>;
}

/** Coded SDK failure that does not include untrusted input values. */
export class SdkError extends HarnessError {
  readonly code:
    "sdk_run_not_found" | "sdk_closed" | "sdk_content_unavailable" | "sdk_input_unavailable";

  /** Creates a stable SDK error with a closed code. */
  constructor(code: SdkError["code"]) {
    super(`SDK operation failed (${code}).`);
    this.code = code;
    this.name = "SdkError";
  }
}
