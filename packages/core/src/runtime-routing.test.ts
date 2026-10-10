// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Code,
  JsonValue,
  ModelsConfigSchema,
  RolesConfigSchema,
  RunConfigSchema,
  parseJson,
} from "@harness/schemas";
import { InMemoryEventStore } from "@harness/store";
import { ProviderError } from "@harness/models";
import { createRuntime } from "./runtime.js";
import type { ProviderAdapter } from "@harness/models";
import { createConfiguredModelPort } from "./runtime-model.js";

const models = ModelsConfigSchema.parse({
  retry: { maxAttempts: 1 },
  routing: {
    default: [
      { provider: "first", model: "first-model" },
      { provider: "second", model: "second-model" },
    ],
  },
});

const roleDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    roleDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("createRuntime model routing", () => {
  it("constructs configured adapters and resolves provider secret references", async () => {
    const resolve = vi.fn((_reference: string) =>
      Promise.resolve({ reveal: () => "synthetic-key" }),
    );
    const model = await createConfiguredModelPort(
      ModelsConfigSchema.parse({
        providers: [
          {
            id: "anthropic",
            kind: "anthropic",
            apiKey: "env:ANTHROPIC_API_KEY",
            baseUrl: "https://anthropic.example",
            requestsPerMinute: 10,
            capabilities: {
              structuredOutput: "tool",
              forcedToolChoice: true,
              parallelToolCalls: false,
              maxContextTokens: 10_000,
              opaqueRoundTrip: true,
            },
          },
          {
            id: "local-openai",
            kind: "openai_compatible",
            apiKey: "env:LOCAL_API_KEY",
            baseUrl: "http://localhost:1234/v1",
          },
        ],
        routing: { default: [{ provider: "anthropic", model: "claude-model" }] },
      }),
      {
        ids: { next: () => "00000000000000000000000000" },
        clock: { now: () => 0 },
        secretResolver: { resolve },
      },
    );

    expect(model).toBeDefined();
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(resolve).toHaveBeenCalledWith("env:ANTHROPIC_API_KEY");
  });

  it("requires a resolver for configured secret references", async () => {
    await expect(
      createConfiguredModelPort(
        ModelsConfigSchema.parse({
          providers: [{ id: "openai", kind: "openai", apiKey: "env:OPENAI_API_KEY" }],
        }),
        { ids: { next: () => "00000000000000000000000000" }, clock: { now: () => 0 } },
      ),
    ).rejects.toMatchObject({ code: "secret_resolver_unavailable" });
  });

  it("requires a key for hosted providers and omits the gateway when routing is empty", async () => {
    await expect(
      createConfiguredModelPort(
        ModelsConfigSchema.parse({ providers: [{ id: "openai", kind: "openai" }] }),
        { ids: { next: () => "00000000000000000000000000" }, clock: { now: () => 0 } },
      ),
    ).rejects.toMatchObject({ code: "model_provider_key_missing" });
    await expect(
      createConfiguredModelPort(undefined, {
        ids: { next: () => "00000000000000000000000000" },
        clock: { now: () => 0 },
      }),
    ).resolves.toBeUndefined();
  });

  it("fails at startup when a configured route names an unknown provider", async () => {
    await expect(
      createRuntime(
        {
          run: RunConfigSchema.parse({}),
          models: ModelsConfigSchema.parse({
            routing: { default: [{ provider: "missing", model: "model" }] },
          }),
        },
        { store: new InMemoryEventStore() },
      ),
    ).rejects.toMatchObject({ code: "routing_provider_unknown" });
  });

  it("starts with only default routing and resolves roles from the selected config directory", async () => {
    const configDirectory = await mkdtemp(join(tmpdir(), "harness-runtime-roles-"));
    roleDirectories.push(configDirectory);
    await writeFile(join(configDirectory, "worker.md"), "worker prompt");
    const adapter: ProviderAdapter = {
      provider: "local",
      kind: "openai",
      complete: () => Promise.reject(new ProviderError("provider_unavailable")),
    };
    const tool = {
      describe: () => undefined,
      execute: () => Promise.reject(new Error("Tool execution was not expected.")),
      getToolSpecs: () => [
        { toolId: Code.parse("fs.read"), description: "Read a file", inputSchema: {} },
      ],
    };
    const runtime = await createRuntime(
      {
        run: RunConfigSchema.parse({}),
        models: ModelsConfigSchema.parse({
          routing: { default: [{ provider: "local", model: "model" }] },
        }),
        roles: RolesConfigSchema.parse([
          {
            id: "worker",
            tools: ["fs.*"],
            contextStrategy: "naive",
            systemPrompt: { file: "worker.md" },
          },
        ]),
      },
      {
        store: new InMemoryEventStore(),
        providerAdapters: [adapter],
        tool,
        roleConfigDirectory: configDirectory,
      },
    );

    expect(runtime.store).toBeDefined();
    await runtime.close();
  });

  it("rejects invalid role strategies during runtime startup", async () => {
    await expect(
      createRuntime(
        {
          run: RunConfigSchema.parse({}),
          models: ModelsConfigSchema.parse({
            routing: { default: [{ provider: "local", model: "model" }] },
          }),
          roles: RolesConfigSchema.parse([{ id: "worker", tools: [], contextStrategy: "missing" }]),
        },
        {
          store: new InMemoryEventStore(),
          providerAdapters: [
            {
              provider: "local",
              kind: "openai",
              complete: () => Promise.reject(new ProviderError("provider_unavailable")),
            },
          ],
        },
      ),
    ).rejects.toMatchObject({ code: "role_context_strategy_unknown" });
  });

  it("runs through configured routing and records the successful fallback", async () => {
    const first: ProviderAdapter = {
      provider: "first",
      kind: "openai",
      complete: () => Promise.reject(new ProviderError("provider_unavailable")),
    };
    const second: ProviderAdapter = {
      provider: "second",
      kind: "openai",
      complete: () =>
        Promise.resolve({
          parts: [{ type: "text", text: "completed" }],
          usage: { inputTokens: 1, outputTokens: 1 },
          finishReason: "stop",
          latencyMs: 0,
        }),
    };
    const runtime = await createRuntime(
      { run: RunConfigSchema.parse({}), models },
      {
        store: new InMemoryEventStore(),
        providerAdapters: [first, second],
      },
    );

    try {
      const result = await runtime.run("goal");
      const response = result.events.find((event) => event.type === "model_response");

      expect(result.status).toBe("completed");
      expect(response).toMatchObject({
        provider: "second",
        model: "second-model",
        fallbackDepth: 1,
      });
    } finally {
      await runtime.close();
    }
  });

  it("sends the configured output-token limit on an Anthropic runtime request", async () => {
    const requestBodies: JsonValue[] = [];
    vi.stubGlobal("fetch", (_input: RequestInfo | URL, init?: RequestInit) => {
      if (typeof init?.body === "string") {
        requestBodies.push(parseJson(JsonValue, init.body));
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: "message-test",
            type: "message",
            role: "assistant",
            model: "claude-test",
            content: [{ type: "text", text: "completed" }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 3, output_tokens: 2 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    });
    const runtime = await createRuntime(
      {
        run: RunConfigSchema.parse({}),
        models: ModelsConfigSchema.parse({
          retry: { maxAttempts: 1 },
          providers: [
            {
              id: "anthropic",
              kind: "anthropic",
              apiKey: "env:ANTHROPIC_API_KEY",
              maxOutputTokens: 713,
            },
          ],
          routing: { default: [{ provider: "anthropic", model: "claude-test" }] },
        }),
      },
      {
        store: new InMemoryEventStore(),
        secretResolver: { resolve: () => Promise.resolve({ reveal: () => "synthetic-key" }) },
      },
    );

    try {
      const result = await runtime.run("test goal");

      expect(result.status).toBe("completed");
      expect(requestBodies[0]).toMatchObject({ max_tokens: 713, model: "claude-test" });
    } finally {
      await runtime.close();
    }
  });
});
