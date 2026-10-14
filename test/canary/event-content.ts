// SPDX-License-Identifier: Apache-2.0
import { captureCliOutput } from "./cli-output.js";
import {
  Id,
  type JsonValue,
  type NewEvent,
  type SequentialIdGenerator,
  type Snapshot,
} from "@harness/schemas";
import type { PiiEventStore, Tokenizer } from "@harness/pii";

const TRACE_ID = "a".repeat(32);
const SPAN_ID = "b".repeat(16);

/** Record goal, model, and snapshot canaries, then capture actual inspect/context CLI output. */
export async function recordCanaryRunContent(input: {
  readonly runId: Id;
  readonly value: string;
  readonly ids: SequentialIdGenerator;
  readonly store: PiiEventStore;
  readonly tokenizer: Tokenizer;
  readonly captureSnapshot: (snapshot: Snapshot | undefined) => void;
  readonly captureInspect: (text: string) => void;
  readonly captureContext: (text: string) => void;
  readonly captureStderr: (text: string) => void;
}): Promise<void> {
  const goal = await input.tokenizer.tokenizeJson(
    input.runId,
    { goal: input.value },
    { boundary: "model_input", destination: "local" },
  );
  await input.store.append(input.runId, createCanaryEvents(input, goal.value), 0);
  const { checkpoint, snapshot } = createCanaryCheckpoint(input);
  await input.store.appendWithSnapshot(input.runId, [checkpoint], 3, snapshot);
  input.captureSnapshot(await input.store.latestSnapshot(input.runId));

  await captureCliOutput({
    command: "inspect",
    args: ["inspect", input.runId],
    runId: input.runId,
    store: input.store,
    stdout: input.captureInspect,
    stderr: input.captureStderr,
  });
  await captureCliOutput({
    command: "context",
    args: ["context", input.runId, "--json"],
    runId: input.runId,
    store: input.store,
    stdout: input.captureContext,
    stderr: input.captureStderr,
  });
}

function createCanaryEvents(
  input: { readonly runId: Id; readonly value: string; readonly ids: SequentialIdGenerator },
  goal: JsonValue,
): NewEvent[] {
  const envelope = {
    runId: input.runId,
    ts: 100,
    v: 1 as const,
    traceId: TRACE_ID,
    spanId: SPAN_ID,
    segmentId: input.runId,
  };
  return [
    {
      ...envelope,
      type: "run_created",
      configHash: "a".repeat(64),
      policyVersion: "canary.v1",
      depth: 0,
    },
    { ...envelope, type: "run_input", input: goal, inputKind: "initial" },
    {
      ...envelope,
      type: "model_response",
      requestId: Id.parse(input.ids.next()),
      provider: "synthetic",
      model: "synthetic",
      inputTokens: 1,
      outputTokens: 1,
      finishReason: "stop",
      latencyMs: 0,
      schemaValid: true,
      repairAttempts: 0,
      content: [{ type: "text", text: input.value }],
      providerBlobs: null,
    },
  ];
}

function createCanaryCheckpoint(input: {
  readonly runId: Id;
  readonly value: string;
  readonly ids: SequentialIdGenerator;
}): { readonly checkpoint: NewEvent; readonly snapshot: Snapshot } {
  const snapshotId = Id.parse(input.ids.next());
  const traceparent = `00-${TRACE_ID}-${SPAN_ID}-01`;
  return {
    checkpoint: {
      runId: input.runId,
      ts: 100,
      v: 1,
      traceId: TRACE_ID,
      spanId: SPAN_ID,
      segmentId: input.runId,
      type: "checkpoint_written",
      checkpointId: snapshotId,
      atSeq: 3,
      traceparent,
    },
    snapshot: {
      snapshotId,
      runId: input.runId,
      atSeq: 3,
      createdAt: 100,
      traceparent,
      context: { content: input.value },
      plan: { content: input.value },
    },
  };
}
