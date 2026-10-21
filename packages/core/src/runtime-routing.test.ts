// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryTransport, McpServer, type Tool } from "@modelcontextprotocol/server";
import {
  Code,
  Id,
  JsonValue,
  ModelsConfigSchema,
  QuotasConfigSchema,
  RolesConfigSchema,
  RunConfigSchema,
  ServerConfigSchema,
  parseJson,
} from "@harness/schemas";
import { InMemoryEventStore, type RunQueue, type RunQueueJob } from "@harness/store";
import { ProviderError } from "@harness/models";
import { PolicyDocumentSchema, policyVersion } from "@harness/policy";
import type { PolicyDocument } from "@harness/policy";
import { createRuntime as createRuntimeImpl } from "./runtime.js";
import type { ProviderAdapter } from "@harness/models";
import { createConfiguredModelPort } from "./runtime-model.js";
import { ApprovalAlreadyResolvedError } from "./approvals.js";
import type { ModelCompletion, ModelPort, PolicyPort, ToolPort } from "./ports.js";
import { allowAllPolicy } from "./testing/allow-policy.js";

const createRuntime = (
  config: Parameters<typeof createRuntimeImpl>[0],
  overrides: Parameters<typeof createRuntimeImpl>[1] = {},
) => createRuntimeImpl(config, { ...overrides, transientVault: true });

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
  it("re-enqueues approval resumption when an already-resolved approval is retried", async () => {
    const enqueued: { readonly kind: string; readonly runId: string }[] = [];
    const queuedJob: RunQueueJob = {
      jobId: Id.parse("00000000000000000000000040"),
      kind: "resume",
      runId: Id.parse("00000000000000000000000041"),
      priority: 0,
      availableAt: 100,
      attempts: 0,
      maxAttempts: 5,
      createdAt: 100,
      updatedAt: 100,
    };
    const queue: RunQueue = {
      enqueue: (input) => {
        enqueued.push({ kind: input.kind, runId: input.runId });
        return Promise.resolve(queuedJob);
      },
      claim: () => Promise.resolve([]),
      heartbeat: () => Promise.resolve(true),
      complete: () => Promise.resolve(true),
      fail: () => Promise.resolve("retry"),
      release: () => Promise.resolve(true),
      getDeadLetter: () => Promise.resolve(undefined),
      close: () => Promise.resolve(),
    };
    const runId = Id.parse("00000000000000000000000041");
    const toolCallId = Id.parse("00000000000000000000000042");
    const toolId = Code.parse("runtime.approval");
    const runtime = await createRuntime(
      { run: RunConfigSchema.parse({}) },
      {
        store: new InMemoryEventStore(),
        queue,
        policy: {
          version: "runtime.approval_test",
          decide: () => ({
            decision: "ask",
            ruleId: "runtime_approval",
            reason: "runtime_approval",
            editable: [],
          }),
        },
        model: {
          complete: () =>
            Promise.resolve({
              parts: [{ type: "tool_call", callId: toolCallId, toolId, args: {} }],
              usage: { inputTokens: 1, outputTokens: 1 },
              finishReason: "tool_calls",
              provider: "test",
              model: "test",
              latencyMs: 0,
              schemaValid: true,
              repairAttempts: 0,
              fallbackDepth: 0,
              providerBlobs: null,
            }),
        },
        tool: {
          describe: () => ({ idempotent: false, timeoutMs: 1_000 }),
          prepare: (call) => Promise.resolve(call),
          execute: () => Promise.resolve({ outcome: "ok", result: null }),
        },
        transientVault: true,
      },
    );
    try {
      const suspended = await runtime.start("synthetic approval goal", { runId }).completion;
      const approvalId = suspended.approvalIds[0];
      if (approvalId === undefined) {
        throw new Error("Expected the run to suspend for approval.");
      }

      const metadata = { decidedBy: "human" as const, approverId: "cli.runtime_test" };
      await runtime.resolveApproval(runId, approvalId, "approve", { metadata });
      await expect(
        runtime.resolveApproval(runId, approvalId, "approve", { metadata }),
      ).rejects.toBeInstanceOf(ApprovalAlreadyResolvedError);

      expect(enqueued).toEqual([
        { kind: "resume", runId },
        { kind: "resume", runId },
      ]);
    } finally {
      await runtime.close();
    }
  });

  it("registers and closes the MCP tool port for configured servers", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = new McpServer({ name: "runtime-test", version: "1.0.0" });
    const inputSchema = {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    } satisfies Tool["inputSchema"];
    server.server.registerCapabilities({ tools: { listChanged: true } });
    server.server.setRequestHandler("tools/list", () => ({
      tools: [{ name: "echo", inputSchema }],
    }));
    await server.connect(serverTransport);
    const transportFactory = vi.fn(() => clientTransport);
    const runtime = await createRuntime(
      {
        run: RunConfigSchema.parse({}),
        servers: [
          ServerConfigSchema.parse({
            id: "runtime_mcp",
            transport: { kind: "stdio", command: "not-spawned-by-test" },
            protocol: "2025-11-25",
          }),
        ],
      },
      {
        store: new InMemoryEventStore(),
        mcpTransportFactory: transportFactory,
      },
    );

    expect(transportFactory).toHaveBeenCalledOnce();
    await runtime.close();
    await server.close();
    await serverTransport.close();
  });

  it("offloads large MCP binary results before they are written to run events", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = new McpServer({ name: "binary-runtime-test", version: "1.0.0" });
    const inputSchema = {
      type: "object",
      properties: {},
      additionalProperties: false,
    } satisfies Tool["inputSchema"];
    const bytes = Buffer.alloc(9_000, 37);
    const encoded = bytes.toString("base64");
    server.server.registerCapabilities({ tools: { listChanged: true } });
    server.server.setRequestHandler("tools/list", () => ({
      tools: [{ name: "image", inputSchema }],
    }));
    server.server.setRequestHandler("tools/call", () => ({
      content: [{ type: "image", mimeType: "image/png", data: encoded }],
    }));
    await server.connect(serverTransport);

    let completionIndex = 0;
    const model: ModelPort = {
      complete: (): Promise<ModelCompletion> => {
        completionIndex += 1;
        return Promise.resolve(
          completionIndex === 1
            ? {
                parts: [
                  {
                    type: "tool_call",
                    callId: Id.parse("11111111111111111111111111"),
                    toolId: Code.parse("runtime_mcp.image"),
                    args: {},
                  },
                ],
                usage: { inputTokens: 1, outputTokens: 1 },
                finishReason: "tool_calls",
                provider: "test",
                model: "test",
                latencyMs: 0,
                schemaValid: true,
                repairAttempts: 0,
                fallbackDepth: 0,
                providerBlobs: null,
              }
            : {
                parts: [{ type: "text", text: "completed" }],
                usage: { inputTokens: 1, outputTokens: 1 },
                finishReason: "stop",
                provider: "test",
                model: "test",
                latencyMs: 0,
                schemaValid: true,
                repairAttempts: 0,
                fallbackDepth: 0,
                providerBlobs: null,
              },
        );
      },
    };
    const files = new Map<string, Uint8Array>();
    const workspace = {
      write: (path: string, data: Uint8Array) => {
        files.set(path, data);
        return Promise.resolve();
      },
      read: (path: string) => {
        const data = files.get(path);
        return data === undefined
          ? Promise.reject(new Error("offload_not_found"))
          : Promise.resolve(data);
      },
    };
    const runtime = await createRuntime(
      {
        run: RunConfigSchema.parse({}),
        servers: [
          ServerConfigSchema.parse({
            id: "runtime_mcp",
            transport: { kind: "stdio", command: "not-spawned-by-test" },
            protocol: "2025-11-25",
          }),
        ],
      },
      {
        store: new InMemoryEventStore(),
        model,
        policy: allowAllPolicy,
        workspace,
        mcpTransportFactory: () => clientTransport,
      },
    );

    try {
      const result = await runtime.run("goal");
      const toolResult = result.events.find((event) => event.type === "tool_result");
      expect(toolResult).toMatchObject({
        type: "tool_result",
        outcome: "ok",
        result: { $offloaded: { preview: "" } },
      });
      expect(files.size).toBe(1);
      expect(JSON.stringify(result.events)).not.toContain(encoded);
      expect(JSON.stringify(result.events)).not.toContain(JSON.stringify(Array.from(bytes)));
    } finally {
      await runtime.close();
      await server.close();
      await serverTransport.close();
    }
  });

  it("loads the configured policy once and records its content version on run creation", async () => {
    const configDirectory = await mkdtemp(join(tmpdir(), "harness-runtime-policy-"));
    roleDirectories.push(configDirectory);
    const document = PolicyDocumentSchema.parse({
      version: 1,
      defaultDecision: "deny",
      rules: [],
    });

    await writeFile(
      join(configDirectory, "policy.yaml"),
      "version: 1\ndefaultDecision: deny\nrules: []\n",
    );
    const model: ModelPort = {
      complete: () =>
        Promise.resolve({
          parts: [{ type: "text", text: "done" }],
          usage: { inputTokens: 1, outputTokens: 1 },
          finishReason: "stop",
          provider: "test",
          model: "test",
          latencyMs: 0,
          schemaValid: true,
          repairAttempts: 0,
          fallbackDepth: 0,
          providerBlobs: null,
        }),
    };
    const runtime = await createRuntime(
      { run: RunConfigSchema.parse({}), policy: { file: "policy.yaml" } },
      {
        store: new InMemoryEventStore(),
        roleConfigDirectory: configDirectory,
        model,
      },
    );

    try {
      const result = await runtime.run("goal");

      expect(result.events[0]).toMatchObject({
        type: "run_created",
        policyVersion: policyVersion(document),
      });
    } finally {
      await runtime.close();
    }
  });

  it("records the built-in deny-all policy version when no policy file is configured", async () => {
    const denyAllDocument: PolicyDocument = { version: 1, defaultDecision: "deny", rules: [] };
    const model: ModelPort = {
      complete: () =>
        Promise.resolve({
          parts: [{ type: "text", text: "done" }],
          usage: { inputTokens: 1, outputTokens: 1 },
          finishReason: "stop",
          provider: "test",
          model: "test",
          latencyMs: 0,
          schemaValid: true,
          repairAttempts: 0,
          fallbackDepth: 0,
          providerBlobs: null,
        }),
    };
    const runtime = await createRuntime(
      { run: RunConfigSchema.parse({}) },
      { store: new InMemoryEventStore(), model },
    );

    try {
      const result = await runtime.run("goal");

      expect(result.events[0]).toMatchObject({
        type: "run_created",
        policyVersion: policyVersion(denyAllDocument),
      });
    } finally {
      await runtime.close();
    }
  });

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

  it("uses configured model cost to stop a run at its cost budget", async () => {
    const callId = "00000000000000000000000001";
    const adapter: ProviderAdapter = {
      provider: "local",
      kind: "openai",
      complete: () =>
        Promise.resolve({
          parts: [{ type: "tool_call", callId, toolId: "budgeted_tool", args: {} }],
          usage: { inputTokens: 1, outputTokens: 0 },
          finishReason: "tool_calls",
          latencyMs: 0,
        }),
    };
    const execute = vi.fn(() => Promise.resolve({ outcome: "ok" as const, result: null }));
    const tool: ToolPort = {
      describe: (toolId) =>
        toolId === "budgeted_tool" ? { idempotent: true, timeoutMs: 1_000 } : undefined,
      execute,
      getToolSpecs: () => [
        { toolId: "budgeted_tool", description: "Synthetic tool", inputSchema: {} },
      ],
    };
    const policy: PolicyPort = {
      version: Code.parse("test_policy"),
      decide: () => ({
        decision: "allow",
        ruleId: Code.parse("test_allow"),
        reason: Code.parse("test_allowed"),
        editable: [],
      }),
    };
    const runtime = await createRuntime(
      {
        run: RunConfigSchema.parse({ budgets: { maxCostUsd: 0.000001 } }),
        models: ModelsConfigSchema.parse({
          pricing: {
            "local/model": { inputMicrosPerMTok: 2_000_000, outputMicrosPerMTok: 0 },
          },
          routing: { default: [{ provider: "local", model: "model" }] },
        }),
      },
      {
        store: new InMemoryEventStore(),
        providerAdapters: [adapter],
        policy,
        tool,
      },
    );

    try {
      const result = await runtime.run("budgeted goal");
      const response = result.events.find(({ type }) => type === "model_response");

      expect(result.status).toBe("failed");
      expect(response).toMatchObject({ costMicros: 2 });
      expect(result.events).toContainEqual(
        expect.objectContaining({ type: "budget_exceeded", budget: "cost", observed: 2 }),
      );
      expect(execute).not.toHaveBeenCalled();
    } finally {
      await runtime.close();
    }
  });

  it("rejects an exhausted quota before writing run events", async () => {
    const store = new InMemoryEventStore();
    vi.spyOn(store, "readUsageLedger").mockResolvedValue([
      {
        quotaId: "team",
        period: "day",
        periodStart: Date.UTC(2026, 9, 20),
        costMicros: 10,
        runsStarted: 0,
      },
    ]);
    const runtime = await createRuntime(
      {
        run: RunConfigSchema.parse({}),
        quotas: QuotasConfigSchema.parse([
          { id: "team", match: { requestedBy: ["cli.alice"] }, dailyCostUsd: 0.00001 },
        ]),
      },
      { store, clock: { now: () => Date.UTC(2026, 9, 20, 14) } },
    );

    try {
      await expect(
        runtime.run("quota goal", { requestedBy: "cli.alice", role: "writer" }),
      ).rejects.toMatchObject({ code: "quota_exceeded" });
      await expect(store.listRuns({ limit: 10 })).resolves.toMatchObject({ runs: [] });
    } finally {
      await runtime.close();
    }
  });

  it("accounts model-response cost atomically and fails before the next call when exhausted", async () => {
    const callId = "00000000000000000000000031";
    let modelCalls = 0;
    const model: ModelPort = {
      complete: () => {
        modelCalls += 1;
        return Promise.resolve({
          parts: [{ type: "tool_call", callId, toolId: "quota_tool", args: {} }],
          usage: { inputTokens: 1, outputTokens: 0, costMicros: 10 },
          finishReason: "tool_calls",
          provider: "local",
          model: "model",
          latencyMs: 0,
          schemaValid: true,
          repairAttempts: 0,
          fallbackDepth: 0,
          providerBlobs: null,
        });
      },
    };
    const tool: ToolPort = {
      describe: () => ({ idempotent: true, timeoutMs: 1_000 }),
      execute: () => Promise.resolve({ outcome: "ok", result: null }),
      getToolSpecs: () => [
        { toolId: "quota_tool", description: "Synthetic tool", inputSchema: {} },
      ],
    };
    const store = new InMemoryEventStore();
    const runtime = await createRuntime(
      {
        run: RunConfigSchema.parse({}),
        quotas: QuotasConfigSchema.parse([
          {
            id: "team",
            match: { requestedBy: ["cli.alice"] },
            dailyCostUsd: 0.00001,
          },
        ]),
      },
      {
        store,
        model,
        tool,
        policy: allowAllPolicy,
        clock: { now: () => Date.UTC(2026, 9, 20, 14) },
      },
    );

    try {
      const result = await runtime.run("quota goal", { requestedBy: "cli.alice" });
      expect(modelCalls).toBe(1);
      expect(result.status).toBe("failed");
      expect(result.events).toContainEqual(
        expect.objectContaining({
          type: "budget_exceeded",
          budget: "quota",
          limit: 10,
          observed: 10,
        }),
      );
      const response = result.events.find((event) => event.type === "model_response");
      if (response?.type !== "model_response") {
        throw new Error("Expected a recorded model response.");
      }
      await expect(store.readUsageLedger("team", "day", [Date.UTC(2026, 9, 20)])).resolves.toEqual([
        {
          quotaId: "team",
          period: "day",
          periodStart: Date.UTC(2026, 9, 20),
          costMicros: 10,
          runsStarted: 0,
        },
      ]);
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
              streaming: false,
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
