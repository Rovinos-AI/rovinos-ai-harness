// SPDX-License-Identifier: Apache-2.0
import { context, trace } from "@opentelemetry/api";
import { Code, ModelUsageSchema } from "@rovinos/schemas";
import {
  attr,
  defineSpan,
  GEN_AI_PROVIDER_NAME,
  GEN_AI_REQUEST_MODEL,
  GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS,
  GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS,
  GEN_AI_USAGE_INPUT_TOKENS,
  GEN_AI_USAGE_OUTPUT_TOKENS,
} from "@rovinos/telemetry";
import { createTestContextManager, createTestSpanCollector } from "@rovinos/telemetry/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
import { reportModelUsage } from "./usage.js";

const spanCollector = createTestSpanCollector();
const { provider, getFinishedSpans } = spanCollector;
const modelCall = defineSpan(
  "harness.model_call",
  {
    [GEN_AI_PROVIDER_NAME]: attr.optional(attr.code()),
    [GEN_AI_REQUEST_MODEL]: attr.optional(attr.code()),
    [GEN_AI_USAGE_INPUT_TOKENS]: attr.optional(attr.nonnegativeInt()),
    [GEN_AI_USAGE_OUTPUT_TOKENS]: attr.optional(attr.nonnegativeInt()),
    [GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS]: attr.optional(attr.nonnegativeInt()),
    [GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS]: attr.optional(attr.nonnegativeInt()),
    "harness.model.input_tokens": attr.optional(attr.nonnegativeInt()),
    "harness.model.output_tokens": attr.optional(attr.nonnegativeInt()),
    "harness.model.cache_read_tokens": attr.optional(attr.nonnegativeInt()),
    "harness.model.cache_write_tokens": attr.optional(attr.nonnegativeInt()),
  },
  { taskId: "11.8", packageName: "@rovinos/models" },
);

beforeAll(() => {
  trace.setGlobalTracerProvider(provider);
  context.setGlobalContextManager(createTestContextManager());
});

afterAll(async () => {
  await provider.shutdown();
  context.disable();
});

it("maps only bounded provider, model, and usage metadata onto the active model span", async () => {
  const span = modelCall.start({});
  context.with(trace.setSpan(context.active(), span), () => {
    reportModelUsage(
      { provider: Code.parse("provider_a"), model: Code.parse("model_a") },
      ModelUsageSchema.parse({
        inputTokens: 7,
        outputTokens: 5,
        cacheReadTokens: 2,
        cacheWriteTokens: 1,
      }),
      false,
    );
  });
  span.end();
  await provider.forceFlush();

  expect(getFinishedSpans()[0]?.attributes).toMatchObject({
    [GEN_AI_PROVIDER_NAME]: "provider_a",
    [GEN_AI_REQUEST_MODEL]: "model_a",
    [GEN_AI_USAGE_INPUT_TOKENS]: 7,
    [GEN_AI_USAGE_OUTPUT_TOKENS]: 5,
    [GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS]: 2,
    [GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS]: 1,
  });
});
