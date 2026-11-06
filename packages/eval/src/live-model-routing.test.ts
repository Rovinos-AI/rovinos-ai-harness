// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FakeClock,
  ModelsConfigSchema,
  parseJson,
  JsonValue,
  SequentialIdGenerator,
} from "@rovinos/schemas";
import { z } from "zod";
import { createConfiguredModelPort } from "@rovinos/core";
import type { ProviderAdapter } from "@rovinos/models";
import { createLiveModelSession } from "./live-model.js";
import { createLiveModelClient, startLiveModelGateway } from "./live-model-gateway.js";

const request = {
  requestId: "00000000000000000000000001",
  model: { provider: "test", model: "test" },
  messages: [{ role: "user" as const, parts: [{ type: "text" as const, text: "synthetic" }] }],
};
const context = () => ({
  runId: "00000000000000000000000000",
  signal: new AbortController().signal,
});
const models = () =>
  ModelsConfigSchema.parse({
    providers: [
      {
        id: "test",
        kind: "openai",
        baseUrl: "https://provider.example.test/v1",
        apiKey: "env:TEST_KEY",
        streaming: false,
      },
    ],
    retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
  });
const secretResolver = {
  resolve: () => Promise.resolve({ reveal: () => "synthetic-credential-canary" }),
};
function completion(content = "ok"): Response {
  return Response.json({
    id: "synthetic",
    object: "chat.completion",
    created: 0,
    model: "test",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
}
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("live model routing and host graders", () => {
  it("requires a positive call budget", async () => {
    await expect(
      createLiveModelSession({
        models: models(),
        maxCalls: 0,
        secretResolver,
        clock: new FakeClock(),
      }),
    ).rejects.toMatchObject({ code: "eval_live_config_invalid" });
  });

  it("uses trial validation for actual socket repairs within the shared provider request cap", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(completion('{"email":"<EMAIL_1>"}')));
    vi.stubGlobal("fetch", transport);
    const session = await createLiveModelSession({
      models: models(),
      maxCalls: 2,
      secretResolver,
      clock: new FakeClock(),
    });
    const gateway = await startLiveModelGateway(session.model);
    const valueTransform = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, issues: [{ path: [], code: "custom" }] })
      .mockResolvedValueOnce({ ok: true, tokenized: { email: "<EMAIL_1>" } });
    try {
      const result = await createLiveModelClient(gateway.socketPath).complete(request, {
        ...context(),
        outputSchema: z.object({ email: z.email() }).strict(),
        valueTransform,
      });
      expect(result).toMatchObject({
        schemaValid: true,
        repairAttempts: 1,
        enforcement: { valid: true, value: { email: "<EMAIL_1>" } },
      });
      expect(valueTransform).toHaveBeenCalledTimes(2);
      expect(transport).toHaveBeenCalledTimes(2);
      expect(session.calls).toBe(2);
      expect(JSON.stringify(result)).not.toContain("synthetic-credential-canary");
    } finally {
      await gateway.close();
      await session.close();
    }
  });

  it("does not return an active session when cancelled during credential resolution", async () => {
    const controller = new AbortController();
    const resolve = vi.fn(() => {
      controller.abort();
      return Promise.resolve({ reveal: () => "synthetic-credential-canary" });
    });
    await expect(
      createLiveModelSession({
        models: models(),
        maxCalls: 1,
        secretResolver: { resolve },
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "eval_live_cancelled" });
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("shares the egress cap with host grader gateways using decorated provider adapters", async () => {
    const transport = vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(completion()));
    vi.stubGlobal("fetch", transport);
    const session = await createLiveModelSession({
      models: models(),
      maxCalls: 2,
      secretResolver,
      clock: new FakeClock(),
    });
    const decorateAdapter = vi.fn((adapter: ProviderAdapter) => adapter);
    const judge = await createConfiguredModelPort(models(), {
      providerAdapters: session.providerAdapters,
      decorateAdapter,
      ids: new SequentialIdGenerator(),
      clock: new FakeClock(),
    });
    try {
      if (judge === undefined) {
        throw new Error("expected_gateway");
      }
      expect(Object.isFrozen(session.providerAdapters)).toBe(true);
      expect(decorateAdapter.mock.calls[0]?.[0]).toBe(session.providerAdapters[0]);
      await session.model.complete(request, context());
      await judge.complete(request, context());
      await expect(session.model.complete(request, context())).rejects.toMatchObject({
        code: "eval_live_call_limit_exceeded",
      });
      expect(session.calls).toBe(2);
      expect(transport).toHaveBeenCalledTimes(2);
    } finally {
      await session.close();
    }
  });

  it("supports typed host graders and value transforms using the shared egress cap", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(completion('{"result":"<EMAIL_1>"}')));
    vi.stubGlobal("fetch", transport);
    const session = await createLiveModelSession({
      models: models(),
      maxCalls: 2,
      secretResolver,
      clock: new FakeClock(),
    });
    const valueTransform = vi.fn((_schema: z.ZodType, tokenized: JsonValue) =>
      Promise.resolve({ ok: true as const, tokenized }),
    );
    try {
      const gateway = session.gatewayFor(models().routing);
      const transformed = await gateway.complete(request, {
        ...context(),
        outputSchema: z.object({ result: z.string() }),
        valueTransform,
      });
      expect(transformed.enforcement).toMatchObject({
        valid: true,
        value: { result: "<EMAIL_1>" },
      });
      expect(valueTransform).toHaveBeenCalledTimes(1);
      const typed = await gateway.complete(request, {
        ...context(),
        outputSchema: z.object({ result: z.string() }),
      });
      if (typed.enforcement?.valid !== true) {
        throw new Error("expected_valid_enforcement");
      }
      expect(typed.enforcement.value.result).toBe("<EMAIL_1>");
      expect(session.calls).toBe(2);
      await expect(session.model.complete(request, context())).rejects.toMatchObject({
        code: "eval_live_call_limit_exceeded",
      });
      expect(transport).toHaveBeenCalledTimes(2);
    } finally {
      await session.close();
    }
  });

  it("uses trial-specific routes while sharing adapters and the run-wide call cap", async () => {
    const transport = vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(completion()));
    vi.stubGlobal("fetch", transport);
    const session = await createLiveModelSession({
      models: ModelsConfigSchema.parse({
        ...models(),
        routing: { default: [{ provider: "test", model: "primary" }] },
      }),
      maxCalls: 2,
      secretResolver,
      clock: new FakeClock(),
    });
    try {
      await session.model.complete(request, context());
      const variant = session.modelFor({
        default: [{ provider: "test", model: "variant" }],
        roles: {},
        fallbackOn: [],
      });
      await variant.complete(request, context());
      const outgoing = await Promise.all(
        transport.mock.calls.map(async ([input]) =>
          parseJson(JsonValue, await new Request(input).text()),
        ),
      );
      expect(outgoing).toMatchObject([{ model: "primary" }, { model: "variant" }]);
      expect(session.calls).toBe(2);
      await expect(session.model.complete(request, context())).rejects.toMatchObject({
        code: "eval_live_call_limit_exceeded",
      });
      expect(session.failureCode).toBe("eval_live_call_limit_exceeded");
      expect(transport).toHaveBeenCalledTimes(2);
    } finally {
      await session.close();
    }
  });
});
