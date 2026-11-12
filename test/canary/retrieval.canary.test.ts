// SPDX-License-Identifier: Apache-2.0
import { context, trace } from "@opentelemetry/api";
import { createTestContextManager, createTestSpanCollector } from "@rovinos/telemetry/testing";
import { afterEach, beforeEach, expect, it } from "vitest";
import { runRetrievalJourney } from "../../examples/retrieval/run.js";

let spans: ReturnType<typeof createTestSpanCollector> | undefined;

beforeEach(() => {
  trace.disable();
  context.disable();
  spans = createTestSpanCollector();
  trace.setGlobalTracerProvider(spans.provider);
  context.setGlobalContextManager(createTestContextManager());
});

afterEach(async () => {
  await spans?.provider.shutdown();
  trace.disable();
  context.disable();
  spans = undefined;
});

it("keeps retrieved sensitive synthetic text out of metadata telemetry", async () => {
  const result = await runRetrievalJourney();
  const content = JSON.stringify(result.content);
  const exported = JSON.stringify(
    spans?.getFinishedSpans().map(({ name, attributes, events, status }) => ({
      name,
      attributes,
      events,
      status,
    })),
  );
  expect(result.resultConsumed).toBe(true);
  expect(content).toContain("<EMAIL_1>");
  expect(content).not.toContain("reference@example.test");
  expect(exported).not.toContain("reference@example.test");
});
