// SPDX-License-Identifier: Apache-2.0
import { context, trace } from "@opentelemetry/api";
import {
  Code,
  FakeClock,
  Id,
  JsonValue,
  PiiActionSummarySchema,
  RunConfigSchema,
  SequentialIdGenerator,
  type Event,
  type Message,
  type ModelRequest,
} from "@rovinos/schemas";
import { InMemoryEventStore } from "@rovinos/store";
import { createTestContextManager, createTestTracerProvider } from "@rovinos/telemetry/testing";
import { PiiBlockedError, type Tokenizer } from "@rovinos/pii";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { BudgetTracker } from "../budgets.js";
import { Checkpointer } from "../checkpoint.js";
import { VerifyTool } from "../builtin/verify-tool.js";
import type { ContextPort, ModelCompletion, ModelPort, RunContext } from "../ports.js";
import { RunRecorder } from "../recorder.js";
import { RUN_SPAN } from "../spans.js";
import type { RunLoopExecution } from "../loop.js";
import { createStructuredModelRequester } from "./structured-model.js";

const runId = Id.parse("00000000000000000000000001");
const segmentId = Id.parse("00000000000000000000000002");
const verifierCallId = Id.parse("00000000000000000000000003");
const subjectEmail = "structured-model-canary@example.test";
const messages: Message[] = [
  {
    role: "user",
    parts: [{ type: "text", text: `Check ${subjectEmail}.` }],
  },
];
const verdict = JsonValue.parse({
  criteria: [{ id: "check", met: true }],
  verdict: "pass",
});

interface Harness {
  readonly events: Event[];
  readonly execution: RunLoopExecution;
  readonly ids: SequentialIdGenerator;
  readonly model: ModelPort;
  readonly recorder: RunRecorder;
  readonly store: InMemoryEventStore;
}

function completion(parts: ModelCompletion["parts"]): ModelCompletion {
  return {
    parts,
    usage: { inputTokens: 1, outputTokens: 1 },
    finishReason: parts.some((part) => part.type === "tool_call") ? "tool_calls" : "stop",
    provider: "test",
    model: "judge",
    latencyMs: 1,
    schemaValid: true,
    repairAttempts: 0,
    fallbackDepth: 0,
    providerBlobs: null,
    enforcement: { value: verdict, valid: true, rungUsed: "native" },
  };
}

function createHarness(model: ModelPort): Harness {
  const store = new InMemoryEventStore();
  const clock = new FakeClock(1);
  const ids = new SequentialIdGenerator();
  const recorder = new RunRecorder(store, runId, segmentId, 0, clock);
  const contextPort: ContextPort = {
    build: () =>
      Promise.resolve({
        messages: [],
        metadata: {
          strategyId: Code.parse("test"),
          strategyVersion: Code.parse("v1"),
          estimatedTokens: 0,
          messageCount: 0,
          stablePrefixMessages: 0,
        },
      }),
    snapshot: () => Promise.resolve(null),
    restore: () => Promise.resolve(),
  };
  const checkpointer = new Checkpointer({ recorder, runId, context: contextPort, ids, clock });
  const execution: RunLoopExecution = {
    runId,
    checkpointer,
    budgetTracker: new BudgetTracker(RunConfigSchema.parse({}).budgets),
  };
  return { events: [], execution, ids, model, recorder, store };
}

async function initialize(harness: Harness): Promise<void> {
  await harness.recorder.withStepSpan(RUN_SPAN, {}, async () => {
    const event = await harness.recorder.record({
      type: "run_created",
      v: 1,
      configHash: "a".repeat(64),
      policyVersion: "test.policy",
      depth: 0,
    });
    harness.events.push(event);
    return event;
  });
}

async function storedEvents(store: InMemoryEventStore): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of store.read(runId)) {
    events.push(event);
  }
  return events;
}

async function invokeVerifier(
  harness: Harness,
  inputTokenizer?: Pick<Tokenizer, "tokenizeJson">,
): Promise<ReturnType<VerifyTool["execute"]> extends Promise<infer Result> ? Result : never> {
  const requester = createStructuredModelRequester({
    options: {
      recorder: harness.recorder,
      model: harness.model,
      ids: harness.ids,
      provider: Code.parse("test"),
      modelName: Code.parse("judge"),
      ...(inputTokenizer === undefined ? {} : { inputTokenizer }),
    },
    events: harness.events,
    execution: harness.execution,
    quotaHooks: {},
    nestedModelEvents: [],
  });
  const runContext: RunContext = {
    runId,
    signal: new AbortController().signal,
    requestStructuredModel: requester,
  };
  return trace.getTracer("structured-model-test").startActiveSpan("test.run", async (span) => {
    try {
      return await new VerifyTool().execute(
        {
          callId: verifierCallId,
          toolId: "agent.verify",
          args: JsonValue.parse({
            criteria: [{ id: "check", description: `Check ${subjectEmail}.` }],
            subject: { email: subjectEmail },
          }),
        },
        runContext,
      );
    } finally {
      span.end();
    }
  });
}

beforeAll(() => {
  context.setGlobalContextManager(createTestContextManager());
  trace.setGlobalTracerProvider(createTestTracerProvider());
});

afterAll(() => {
  context.disable();
});

describe("createStructuredModelRequester", () => {
  it("records PII blocks and returns verify_failed without calling the model", async () => {
    const model = { complete: vi.fn<ModelPort["complete"]>() };
    const harness = createHarness(model);
    await initialize(harness);
    const tokenizer: Pick<Tokenizer, "tokenizeJson"> = {
      tokenizeJson: () =>
        Promise.reject(new PiiBlockedError([{ type: Code.parse("email"), count: 1 }])),
    };

    const result = await invokeVerifier(harness, tokenizer);
    const events = await storedEvents(harness.store);

    expect(result).toMatchObject({ outcome: "error", errorCode: "verify_failed" });
    expect(model.complete).not.toHaveBeenCalled();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "pii_action",
        boundary: "storage",
        action: "blocked",
        entities: [{ type: "email", count: 1 }],
      }),
    );
  });

  it("records tokenization summaries and sends only tokenized messages to the model", async () => {
    const received: ModelRequest[] = [];
    const model: ModelPort = {
      complete: (request) => {
        received.push(request);
        return Promise.resolve(completion([{ type: "text", text: JSON.stringify(verdict) }]));
      },
    };
    const harness = createHarness(model);
    await initialize(harness);
    const tokenizedMessages: Message[] = [
      { role: "user", parts: [{ type: "text", text: "Check <EMAIL_1>." }] },
    ];
    const tokenizer: Pick<Tokenizer, "tokenizeJson"> = {
      tokenizeJson: () =>
        Promise.resolve({
          value: tokenizedMessages,
          actions: [
            PiiActionSummarySchema.parse({
              boundary: "storage",
              action: "tokenize",
              entities: [{ type: "email", count: 1 }],
            }),
          ],
        }),
    };

    const result = await invokeVerifier(harness, tokenizer);
    const events = await storedEvents(harness.store);

    expect(result).toMatchObject({ outcome: "ok", result: verdict });
    expect(JSON.stringify(received[0]?.messages)).toContain("<EMAIL_1>");
    expect(JSON.stringify(received[0]?.messages)).not.toContain(subjectEmail);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "pii_action",
        boundary: "storage",
        action: "tokenized",
        entities: [{ type: "email", count: 1 }],
      }),
    );
  });

  it("passes messages through unchanged when no tokenizer is configured", async () => {
    let received: ModelRequest | undefined;
    const model: ModelPort = {
      complete: (request) => {
        received = request;
        return Promise.resolve(completion([{ type: "text", text: JSON.stringify(verdict) }]));
      },
    };
    const harness = createHarness(model);
    await initialize(harness);
    const requester = createStructuredModelRequester({
      options: {
        recorder: harness.recorder,
        model,
        ids: harness.ids,
        provider: Code.parse("test"),
        modelName: Code.parse("judge"),
      },
      events: harness.events,
      execution: harness.execution,
      quotaHooks: {},
      nestedModelEvents: [],
    });

    await trace.getTracer("structured-model-test").startActiveSpan("test.run", async (span) => {
      try {
        await requester({
          messages,
          outputSchema: z.object({}).strict(),
          temperature: 0,
          signal: new AbortController().signal,
        });
      } finally {
        span.end();
      }
    });

    expect(received?.messages).toEqual(messages);
  });

  it.each([
    ["a failed model step", () => Promise.reject(new Error("provider failure"))],
    [
      "unexpected tool calls",
      () =>
        Promise.resolve(
          completion([
            {
              type: "tool_call",
              callId: verifierCallId,
              toolId: "unexpected.tool",
              args: null,
            },
          ]),
        ),
    ],
  ])("returns verify_failed for %s", async (_label, complete) => {
    const model: ModelPort = { complete };
    const harness = createHarness(model);
    await initialize(harness);

    const result = await invokeVerifier(harness);

    expect(result).toMatchObject({ outcome: "error", errorCode: "verify_failed" });
  });
});
