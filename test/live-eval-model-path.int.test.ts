// SPDX-License-Identifier: Apache-2.0
// Loopback provider responses exercise the paid-model path without real credentials or paid calls.
import { InMemoryTransport, type Tool } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { createRuntime, type ModelPort } from "@rovinos/core";
import {
  createLiveModelClient,
  createLiveModelSession,
  createCanaries,
  scanForCanaries,
  startLiveModelGateway,
} from "@rovinos/eval";
import { PolicyDocumentSchema, PolicyEngine } from "@rovinos/policy";
import {
  FakeClock,
  JsonValue,
  ModelsConfigSchema,
  RunConfigSchema,
  SequentialIdGenerator,
  ServerConfigSchema,
  parseJson,
  type Event,
} from "@rovinos/schemas";
import { InMemoryEventStore } from "@rovinos/store";
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const toolDescription = "Read the synthetic model-path fixture";
const fixtureValue = "synthetic-fixture-read-complete";
const WireRequestSchema = z.looseObject({
  messages: z.array(
    z.looseObject({
      role: z.string(),
      content: JsonValue.optional(),
      tool_call_id: z.string().optional(),
      tool_calls: z.array(z.looseObject({ id: z.string() })).optional(),
    }),
  ),
  tools: z.array(
    z.looseObject({
      name: z.string().optional(),
      description: z.string().optional(),
      function: z.looseObject({ name: z.string(), description: z.string().optional() }).optional(),
    }),
  ),
});
type Decision = "allow" | "deny" | "ask";

function providerResponse(alias: string, first: boolean) {
  return {
    id: "chatcmpl_model_path_fixture",
    object: "chat.completion",
    created: 1,
    model: "fixture-model",
    choices: [
      {
        index: 0,
        message: first
          ? {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_fixture",
                  type: "function",
                  function: { name: alias, arguments: '{"key":"fixture"}' },
                },
              ],
            }
          : { role: "assistant", content: "Synthetic fixture complete." },
        finish_reason: first ? "tool_calls" : "stop",
      },
    ],
    usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
  };
}

async function mockProvider() {
  const requests: z.infer<typeof WireRequestSchema>[] = [];
  const credentials: (string | undefined)[] = [];
  const failures: unknown[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      let body = "";
      for await (const chunk of request) {
        body += String(chunk);
      }
      const parsed = parseJson(WireRequestSchema, body);
      requests.push(parsed);
      credentials.push(request.headers.authorization);
      const tool = parsed.tools.find(
        (candidate) =>
          candidate.description === toolDescription ||
          candidate.function?.description === toolDescription,
      );
      const alias = tool?.name ?? tool?.function?.name;
      if (alias === undefined) {
        throw new Error("The runtime did not expose the discovered MCP fixture.");
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(providerResponse(alias, requests.length === 1)));
    })().catch((error: unknown) => {
      failures.push(error);
      response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("The loopback provider did not bind a TCP port.");
  }
  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    requests,
    credentials,
    failures,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) {
            resolve();
          } else {
            reject(error);
          }
        });
        server.closeAllConnections();
      }),
  };
}

async function runScenario(decision: Decision) {
  const canary = createCanaries(`live-model-path.${decision}`).apiKey;
  const credentialCanary = canary.value;
  const credentialForms = [canary.value, ...canary.variants];
  const cleanup: (() => Promise<void>)[] = [];
  const provider = await mockProvider();
  cleanup.push(provider.close);
  try {
    const clock = new FakeClock(1_000);
    const session = await createLiveModelSession({
      models: ModelsConfigSchema.parse({
        providers: [
          {
            id: "fixture",
            kind: "openai_compatible",
            baseUrl: provider.baseUrl,
            apiKey: "env:MODEL_PATH_SYNTHETIC_KEY",
            trust: "local",
            streaming: false,
          },
        ],
        retry: { maxAttempts: 1 },
        routing: { default: [{ provider: "fixture", model: "fixture-model" }] },
      }),
      secretResolver: {
        resolve: () => Promise.resolve({ reveal: () => credentialCanary }),
      },
      maxCalls: 2,
      clock,
    });
    cleanup.push(async () => session.close());
    const gateway = await startLiveModelGateway(session.model);
    cleanup.push(() => gateway.close());
    const client = createLiveModelClient(gateway.socketPath);
    const socketPayloads: string[] = [];
    const model: ModelPort = {
      complete: async (request, context) => {
        socketPayloads.push(JSON.stringify(request));
        const response = await client.complete(request, context);
        socketPayloads.push(JSON.stringify(response));
        return response;
      },
    };
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcp = new McpServer({ name: "model-path-fixture", version: "1.0.0" });
    cleanup.push(() => mcp.close());
    const calls: unknown[] = [];
    let discoveries = 0;
    const inputSchema = {
      type: "object",
      properties: { key: { type: "string" } },
      required: ["key"],
      additionalProperties: false,
    } satisfies Tool["inputSchema"];
    mcp.server.registerCapabilities({ tools: {} });
    mcp.server.setRequestHandler("tools/list", () => {
      discoveries += 1;
      return { tools: [{ name: "read", description: toolDescription, inputSchema }] };
    });
    mcp.server.setRequestHandler("tools/call", (request) => {
      calls.push(request.params.arguments);
      return { content: [{ type: "text", text: fixtureValue }] };
    });
    await mcp.connect(serverTransport);
    const runtime = await createRuntime(
      {
        run: RunConfigSchema.parse({}),
        models: ModelsConfigSchema.parse({
          routing: { default: [{ provider: "fixture", model: "fixture-model" }] },
        }),
        servers: [
          ServerConfigSchema.parse({
            id: "fixture",
            toolPrefix: "fixture",
            transport: { kind: "stdio", command: "not-spawned-by-test" },
          }),
        ],
      },
      {
        model,
        store: new InMemoryEventStore(),
        transientVault: true,
        clock,
        ids: new SequentialIdGenerator(),
        mcpTransportFactory: () => clientTransport,
        policy: new PolicyEngine(
          PolicyDocumentSchema.parse({
            version: 1,
            defaultDecision: "deny",
            rules: [
              {
                id: "fixture.rule",
                match: { tools: ["fixture.read"] },
                decision,
                reason: "fixture_policy",
              },
            ],
          }),
        ),
      },
    );
    cleanup.push(() => runtime.close());
    const handle = runtime.start("Read the synthetic fixture using its MCP tool.");
    const first = await handle.completion;
    if (decision === "ask") {
      expect(first.status).toBe("suspended");
      expect(calls).toEqual([]);
      expect(provider.requests).toHaveLength(1);
      const approvalId = first.approvalIds[0];
      if (approvalId === undefined) {
        throw new Error("The ordinary runtime did not request approval.");
      }
      await runtime.resolveApproval(handle.runId, approvalId, "approve", {
        metadata: { decidedBy: "human", approverId: "cli.synthetic_fixture" },
      });
      expect(calls).toEqual([]);
      expect((await runtime.resume(handle.runId)).status).toBe("completed");
    } else {
      expect(first.status).toBe("completed");
    }
    const events: Event[] = [];
    for await (const event of runtime.store.read(handle.runId)) {
      events.push(event);
    }
    expect(discoveries).toBeGreaterThan(0);
    expect(provider.failures).toEqual([]);
    expect(session.failureCode).toBeUndefined();
    expect(session.calls).toBe(2);
    expect(gateway.rejections).toBe(0);
    expect(provider.requests).toHaveLength(2);
    expect(provider.credentials).toEqual(
      Array.from({ length: 2 }, () => ["Bearer", credentialCanary].join(" ")),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool_intent",
        toolId: "fixture.read",
        policyDecision: decision,
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: "tool_result", toolId: "fixture.read" }),
    );
    expect(
      scanForCanaries(credentialForms, [
        { name: "gateway.client_payloads", content: JSON.stringify(socketPayloads) },
        { name: "runtime.events", content: JSON.stringify(events) },
        { name: "mcp.arguments", content: JSON.stringify(calls) },
        { name: "provider.request_bodies", content: JSON.stringify(provider.requests) },
        // The authorized host header is a positive control for the same captured-output scan.
        { name: "host.provider_auth", content: JSON.stringify(provider.credentials) },
      ]),
    ).toEqual(["host.provider_auth"]);
    const continuation = provider.requests[1];
    const toolMessage = continuation?.messages.find(({ role }) => role === "tool");
    const assistant = continuation?.messages.find(({ role }) => role === "assistant");
    expect(toolMessage?.tool_call_id).toBeDefined();
    expect(toolMessage?.tool_call_id).toBe(assistant?.tool_calls?.[0]?.id);
    if (decision === "deny") {
      expect(calls).toEqual([]);
      expect(events).toContainEqual(
        expect.objectContaining({ type: "tool_result", outcome: "denied" }),
      );
    } else {
      expect(calls).toEqual([{ key: "fixture" }]);
      expect(JSON.stringify(provider.requests[1])).toContain(fixtureValue);
    }
    if (decision === "ask") {
      expect(events).toContainEqual(expect.objectContaining({ type: "approval_requested" }));
      expect(events).toContainEqual(
        expect.objectContaining({ type: "approval_resolved", decidedBy: "human" }),
      );
    }
    return events;
  } finally {
    for (const close of cleanup.reverse()) {
      await close();
    }
  }
}

describe("live eval ordinary MCP model path without paid calls", () => {
  it("detects deliberately leaked raw and encoded client credentials as a negative control", () => {
    const canary = createCanaries("live-model-path.negative_control").apiKey;
    const forms = [canary.value, ...canary.variants];
    for (const exposed of forms) {
      expect(
        scanForCanaries(forms, [
          { name: "gateway.client_payloads", content: JSON.stringify({ exposed }) },
        ]),
      ).toEqual(["gateway.client_payloads"]);
    }
  });

  it("discovers and executes an allowed MCP tool through a local OpenAI-compatible host gateway", async () => {
    expect(await runScenario("allow")).toContainEqual(
      expect.objectContaining({ type: "model_response", finishReason: "stop" }),
    );
  });

  it.each(["deny", "ask"] as const)(
    "keeps %s enforcement in the ordinary runtime instead of the model gateway",
    async (decision) => {
      expect(await runScenario(decision)).toContainEqual(
        expect.objectContaining({ type: "tool_intent", policyDecision: decision }),
      );
    },
  );
});
