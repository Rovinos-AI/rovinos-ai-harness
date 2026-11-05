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
import { createLiveModelSession, guardedLiveModelFetch } from "./live-model.js";

const endpoint = "https://provider.example.test/v1/chat/completions";
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

describe("live model egress boundary", () => {
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

  it("uses only the exact configured endpoint and never redirects", async () => {
    const state = {
      calls: 0,
      failureCode: undefined,
      maxCalls: 2,
      controller: new AbortController(),
    };
    const transport = vi.fn<typeof fetch>().mockResolvedValue(completion());
    const guarded = guardedLiveModelFetch([endpoint], state, transport);
    await guarded(endpoint, { method: "POST" });
    expect(transport.mock.calls[0]?.[0]).toMatchObject({ url: endpoint, redirect: "manual" });
    await expect(guarded(`${endpoint}?key=secret`, { method: "POST" })).rejects.toMatchObject({
      code: "eval_live_egress_denied",
    });
    expect(state.calls).toBe(1);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("rejects redirects without following Location", async () => {
    const state = {
      calls: 0,
      failureCode: undefined,
      maxCalls: 2,
      controller: new AbortController(),
    };
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(null, { status: 307, headers: { location: "https://evil.example.test" } }),
      );
    await expect(
      guardedLiveModelFetch([endpoint], state, transport)(endpoint, { method: "POST" }),
    ).rejects.toMatchObject({ code: "eval_live_redirect_denied" });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("atomically caps concurrent outgoing requests and aborts active work", async () => {
    const state = {
      calls: 0,
      failureCode: undefined,
      maxCalls: 1,
      controller: new AbortController(),
    };
    const transport = vi.fn<typeof fetch>().mockImplementation(
      (input) =>
        new Promise((_resolve, reject) => {
          const active = new Request(input);
          active.signal.addEventListener(
            "abort",
            () => {
              reject(new Error("synthetic-credential-canary"));
            },
            { once: true },
          );
        }),
    );
    const guarded = guardedLiveModelFetch([endpoint], state, transport);
    const active = guarded(endpoint, { method: "POST" });
    const blocked = guarded(endpoint, { method: "POST" });
    const results = await Promise.allSettled([active, blocked]);
    expect(results.every((result) => result.status === "rejected")).toBe(true);
    expect(state.calls).toBe(1);
    expect(state.failureCode).toBe("eval_live_call_limit_exceeded");
    expect(transport).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(results)).not.toContain("synthetic-credential-canary");
  });

  it("counts retry attempts at fetch and makes cap exhaustion sticky across trials", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockImplementation(() =>
        Promise.resolve(
          Response.json({ error: { message: "synthetic-credential-canary" } }, { status: 503 }),
        ),
      );
    vi.stubGlobal("fetch", transport);
    const session = await createLiveModelSession({
      models: models(),
      maxCalls: 1,
      secretResolver,
      clock: new FakeClock(),
    });

    try {
      await expect(session.model.complete(request, context())).rejects.toMatchObject({
        code: "eval_live_call_limit_exceeded",
        message: "eval_live_call_limit_exceeded",
      });
      await expect(session.model.complete(request, context())).rejects.toMatchObject({
        code: "eval_live_call_limit_exceeded",
      });
      expect(session.calls).toBe(1);
      expect(session.failureCode).toBe("eval_live_call_limit_exceeded");
      expect(transport).toHaveBeenCalledTimes(1);
    } finally {
      await session.close();
    }
  });

  it("counts structured-output repair attempts at the same run-wide boundary", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(completion());
    vi.stubGlobal("fetch", transport);
    const session = await createLiveModelSession({
      models: models(),
      maxCalls: 1,
      secretResolver,
      clock: new FakeClock(),
    });
    try {
      await expect(
        session.model.complete(request, {
          ...context(),
          outputSchema: z.object({ result: z.string() }),
        }),
      ).rejects.toMatchObject({ code: "eval_live_call_limit_exceeded" });
      expect(session.calls).toBe(1);
      expect(transport).toHaveBeenCalledTimes(1);
    } finally {
      await session.close();
    }
  });

  it.each(["openai_compatible", "azure_openai", "anthropic"] as const)(
    "permits only the actual adapter path for %s",
    async (kind) => {
      const config = ModelsConfigSchema.parse({
        providers: [
          {
            id: "test",
            kind,
            streaming: false,
            ...(kind === "azure_openai"
              ? {
                  endpoint: "https://azure.example.test",
                  apiVersion: "2025-01-01",
                  deployments: { test: "synthetic" },
                  auth: { kind: "api_key", apiKey: "env:TEST_KEY" },
                }
              : { baseUrl: "https://provider.example.test", apiKey: "env:TEST_KEY" }),
          },
        ],
      });
      const transport = vi.fn<typeof fetch>().mockImplementation(() =>
        Promise.resolve(
          kind === "anthropic"
            ? Response.json({
                id: "synthetic",
                type: "message",
                role: "assistant",
                model: "test",
                content: [{ type: "text", text: "ok" }],
                stop_reason: "end_turn",
                stop_sequence: null,
                usage: { input_tokens: 1, output_tokens: 1 },
              })
            : completion(),
        ),
      );
      vi.stubGlobal("fetch", transport);
      const session = await createLiveModelSession({
        models: config,
        maxCalls: 1,
        secretResolver,
        clock: new FakeClock(),
      });
      try {
        expect((await session.model.complete(request, context())).parts).toContainEqual({
          type: "text",
          text: "ok",
        });
        expect(session.calls).toBe(1);
      } finally {
        await session.close();
      }
    },
  );

  it("allows HTTP only for an explicitly local compatible loopback endpoint", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(completion());
    vi.stubGlobal("fetch", transport);
    const config = ModelsConfigSchema.parse({
      providers: [
        {
          id: "test",
          kind: "openai_compatible",
          trust: "local",
          baseUrl: "http://127.0.0.1:1234/v1",
          streaming: false,
        },
      ],
    });
    const session = await createLiveModelSession({
      models: config,
      maxCalls: 1,
      clock: new FakeClock(),
    });
    try {
      await session.model.complete(request, context());
      expect(session.calls).toBe(1);
    } finally {
      await session.close();
    }
  });

  it("never exposes credential canaries in thrown errors or logs", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockRejectedValue(new Error("synthetic-credential-canary")),
    );
    const session = await createLiveModelSession({
      models: ModelsConfigSchema.parse({
        ...models(),
        retry: { ...models().retry, maxAttempts: 1 },
      }),
      maxCalls: 1,
      secretResolver,
      clock: new FakeClock(),
    });
    try {
      await expect(session.model.complete(request, context())).rejects.toMatchObject({
        message: "eval_live_provider_failed",
        code: "eval_live_provider_failed",
      });
      expect(JSON.stringify([...stdout.mock.calls, ...stderr.mock.calls])).not.toContain(
        "synthetic-credential-canary",
      );
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
      await session.close();
    }
  });

  it("completes via an existing adapter with credentials only on host fetch", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(completion());
    vi.stubGlobal("fetch", transport);
    const session = await createLiveModelSession({
      models: models(),
      maxCalls: 2,
      secretResolver,
      clock: new FakeClock(),
    });
    try {
      const result = await session.model.complete(request, context());
      expect(result.parts).toContainEqual({ type: "text", text: "ok" });
      expect(JSON.stringify(result)).not.toContain("synthetic-credential-canary");
      expect(session.calls).toBe(1);
      const outgoing = new Request(transport.mock.calls[0]?.[0] ?? endpoint);
      expect(outgoing.headers.get("authorization")).toContain("synthetic-credential-canary");
    } finally {
      await session.close();
    }
    await expect(session.model.complete(request, context())).rejects.toMatchObject({
      code: "eval_live_cancelled",
    });
  });

  it("sanitizes secret resolver failures", async () => {
    await expect(
      createLiveModelSession({
        models: models(),
        maxCalls: 1,
        secretResolver: { resolve: () => Promise.reject(new Error("synthetic-credential-canary")) },
      }),
    ).rejects.toMatchObject({
      code: "eval_live_config_invalid",
      message: "eval_live_config_invalid",
    });
  });

  it.each([
    ["http://provider.example.test/v1", "local"],
    ["http://localhost:1234/v1", "hosted"],
    [
      new URL("https://provider.example.test/v1").href.replace("https://", "https://synthetic@"),
      "hosted",
    ],
    ["https://provider.example.test/v1?query=secret", "hosted"],
  ])("rejects unsafe configured endpoint %s", async (baseUrl, trust) => {
    const config = ModelsConfigSchema.parse({
      providers: [{ id: "test", kind: "openai_compatible", baseUrl, trust }],
    });
    await expect(createLiveModelSession({ models: config, maxCalls: 1 })).rejects.toMatchObject({
      code: "eval_live_egress_denied",
    });
  });

  it("rejects unsupported provider auth before resolving any credentials", async () => {
    const resolve = vi.fn();
    const config = ModelsConfigSchema.parse({
      providers: [
        ...models().providers,
        {
          id: "azure",
          kind: "azure_openai",
          endpoint: "https://azure.example.test",
          apiVersion: "2025-01-01",
          deployments: { test: "test" },
          auth: { kind: "entra" },
        },
      ],
    });
    await expect(
      createLiveModelSession({ models: config, maxCalls: 1, secretResolver: { resolve } }),
    ).rejects.toMatchObject({ code: "eval_live_provider_unsupported" });
    expect(resolve).not.toHaveBeenCalled();
  });

  it("aborts outgoing fetch when the session closes", async () => {
    let started: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(
        (input) =>
          new Promise((_resolve, reject) => {
            const active = new Request(input);
            active.signal.addEventListener(
              "abort",
              () => {
                reject(new Error("synthetic-credential-canary"));
              },
              { once: true },
            );
            started?.();
          }),
      ),
    );
    const session = await createLiveModelSession({
      models: models(),
      maxCalls: 1,
      secretResolver,
      clock: new FakeClock(),
    });
    const result = session.model.complete(request, context());
    await ready;
    await session.close();
    await expect(result).rejects.toMatchObject({ code: "eval_live_cancelled" });
  });
});
