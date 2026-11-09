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
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

const toolDescription = "Read the synthetic model-path fixture";
const fixtureValue = "synthetic-fixture-read-complete";
const WireRequestSchema = z.looseObject({
  messages: z
    .array(
      z.looseObject({
        role: z.string(),
        content: JsonValue.optional(),
        tool_call_id: z.string().optional(),
        tool_calls: z.array(z.looseObject({ id: z.string() })).optional(),
      }),
    )
    .optional(),
  tools: z
    .array(
      z.looseObject({
        name: z.string().optional(),
        description: z.string().optional(),
        input_schema: JsonValue.optional(),
        function: z
          .looseObject({ name: z.string(), description: z.string().optional() })
          .optional(),
      }),
    )
    .optional(),
});
const ModelPathReportSchema = z
  .object({
    providerAcceptance: z.enum(["accepted", "rejected", "not_reached"]),
    toolExecution: z.enum(["invoked", "not_invoked"]),
    modelTurn: z.enum(["completed", "failed", "suspended"]),
  })
  .strict();
type Decision = "allow" | "deny" | "ask";
type ProviderProfile = "openai" | "anthropic" | "openai_compatible";
type ToolSelection = "authorized" | "hidden" | "malformed";

function providerResponse(
  profile: ProviderProfile,
  alias: string,
  first: boolean,
  selection: ToolSelection,
) {
  if (profile === "anthropic") {
    return {
      id: "msg_model_path_fixture",
      type: "message",
      role: "assistant",
      model: "fixture-model",
      content: first
        ? [
            {
              type: "tool_use",
              id: "toolu_fixture",
              name: selection === "hidden" ? "fixture_hidden" : alias,
              input: selection === "malformed" ? { key: 42 } : { key: "fixture" },
            },
          ]
        : [{ type: "text", text: "Synthetic fixture complete." }],
      stop_reason: first ? "tool_use" : "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 4, output_tokens: 2 },
    };
  }
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
                  function: {
                    name: selection === "hidden" ? "fixture_hidden" : alias,
                    arguments: selection === "malformed" ? '{"key":42}' : '{"key":"fixture"}',
                  },
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

async function mockProvider(profile: ProviderProfile, selection: ToolSelection) {
  const requests: z.infer<typeof WireRequestSchema>[] = [];
  const credentials: (string | undefined)[] = [];
  const failures: unknown[] = [];
  const respond = (parsed: z.infer<typeof WireRequestSchema>, credential: string | undefined) => {
    requests.push(parsed);
    credentials.push(credential);
    const tool = parsed.tools?.find(
      (candidate) =>
        candidate.description === toolDescription ||
        candidate.function?.description === toolDescription,
    );
    const alias = tool?.name ?? tool?.function?.name ?? "fixture_read";
    return Response.json(providerResponse(profile, alias, requests.length === 1, selection));
  };
  let baseUrl: string;
  let close: () => Promise<void>;
  if (profile === "openai_compatible") {
    const server = createServer((request, response) => {
      void (async () => {
        let body = "";
        for await (const chunk of request) {
          body += String(chunk);
        }
        const parsed = parseJson(WireRequestSchema, body);
        const reply = respond(parsed, request.headers.authorization);
        response.writeHead(reply.status, Object.fromEntries(reply.headers));
        response.end(await reply.text());
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
    baseUrl = `http://127.0.0.1:${String(address.port)}`;
    close = () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) {
            resolve();
          } else {
            reject(error);
          }
        });
        server.closeAllConnections();
      });
  } else {
    const endpoint =
      profile === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com/v1";
    baseUrl = endpoint;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      try {
        const request = new Request(input, init);
        const parsed = parseJson(WireRequestSchema, await request.text());
        return respond(
          parsed,
          request.headers.get("authorization") ?? request.headers.get("x-api-key") ?? undefined,
        );
      } catch (error) {
        failures.push(error);
        throw error;
      }
    });
    close = () => {
      vi.unstubAllGlobals();
      return Promise.resolve();
    };
  }
  return {
    baseUrl,
    requests,
    credentials,
    failures,
    close,
  };
}

async function runScenario(
  decision: Decision,
  profile: ProviderProfile = "openai_compatible",
  selection: ToolSelection = "authorized",
  targetConfigured = true,
) {
  const canary = createCanaries(`live-model-path.${decision}.${profile}.${selection}`).apiKey;
  const credentialCanary = canary.value;
  const credentialForms = [canary.value, ...canary.variants];
  const cleanup: (() => Promise<void>)[] = [];
  const provider = await mockProvider(profile, selection);
  cleanup.push(provider.close);
  try {
    const clock = new FakeClock(1_000);
    const session = await createLiveModelSession({
      models: ModelsConfigSchema.parse({
        providers: [
          profile === "anthropic"
            ? {
                id: "fixture",
                kind: "anthropic",
                apiKey: "env:MODEL_PATH_SYNTHETIC_KEY",
                streaming: false,
              }
            : profile === "openai"
              ? {
                  id: "fixture",
                  kind: "openai",
                  apiKey: "env:MODEL_PATH_SYNTHETIC_KEY",
                  streaming: false,
                }
              : {
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
    const calls: JsonValue[] = [];
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
        servers: targetConfigured
          ? [
              ServerConfigSchema.parse({
                id: "fixture",
                toolPrefix: "fixture",
                transport: { kind: "stdio", command: "not-spawned-by-test" },
              }),
            ]
          : [],
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
    let finalStatus = first.status;
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
      finalStatus = (await runtime.resume(handle.runId)).status;
      expect(finalStatus).toBe("completed");
    } else if (selection === "authorized" && targetConfigured) {
      expect(first.status).toBe("completed");
    } else if (selection === "malformed") {
      expect(first.status).toBe("completed");
    } else {
      expect(first.status).toBe("failed");
    }
    const events: Event[] = [];
    for await (const event of runtime.store.read(handle.runId)) {
      events.push(event);
    }
    if (targetConfigured) {
      expect(discoveries).toBeGreaterThan(0);
    } else {
      expect(discoveries).toBe(0);
    }
    expect(provider.failures).toEqual([]);
    expect(session.failureCode).toBeUndefined();
    expect(session.calls).toBe(provider.requests.length);
    expect(gateway.rejections).toBe(selection === "hidden" || !targetConfigured ? 1 : 0);
    const expectedRequests = selection === "hidden" || !targetConfigured ? 1 : 2;
    expect(provider.requests).toHaveLength(expectedRequests);
    expect(provider.credentials.every((credential) => credential?.includes(credentialCanary))).toBe(
      true,
    );
    const exposedFixtureTools = provider.requests[0]?.tools?.filter(
      (candidate) =>
        candidate.description === toolDescription ||
        candidate.function?.description === toolDescription,
    );
    expect(exposedFixtureTools).toHaveLength(targetConfigured ? 1 : 0);
    if (selection !== "hidden" && targetConfigured) {
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
    }
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
    if (selection === "authorized" && targetConfigured && provider.requests[1] !== undefined) {
      const continuation = provider.requests[1];
      expect(
        continuation.tools?.filter(
          (candidate) =>
            candidate.description === toolDescription ||
            candidate.function?.description === toolDescription,
        ),
      ).toHaveLength(1);
      if (profile === "anthropic") {
        expect(JSON.stringify(continuation)).toContain(fixtureValue);
        expect(JSON.stringify(continuation)).toContain("toolu_fixture");
      } else {
        const toolMessage = continuation.messages?.find(({ role }) => role === "tool");
        const assistant = continuation.messages?.find(({ role }) => role === "assistant");
        expect(toolMessage?.tool_call_id).toBeDefined();
        expect(toolMessage?.tool_call_id).toBe(assistant?.tool_calls?.[0]?.id);
        if (decision !== "deny") {
          expect(JSON.stringify(continuation)).toContain(fixtureValue);
        }
      }
    }
    if (selection === "hidden" || !targetConfigured) {
      expect(calls).toEqual([]);
      expect(events).not.toContainEqual(expect.objectContaining({ type: "tool_intent" }));
    } else if (selection === "malformed" || decision === "deny") {
      expect(calls).toEqual([]);
      if (decision === "deny") {
        expect(events).toContainEqual(
          expect.objectContaining({ type: "tool_result", outcome: "denied" }),
        );
      }
    } else {
      expect(calls).toEqual([{ key: "fixture" }]);
    }
    if (decision === "ask") {
      expect(events).toContainEqual(expect.objectContaining({ type: "approval_requested" }));
      expect(events).toContainEqual(
        expect.objectContaining({ type: "approval_resolved", decidedBy: "human" }),
      );
    }
    return {
      report: ModelPathReportSchema.parse({
        providerAcceptance:
          provider.requests.length === 0
            ? "not_reached"
            : events.some(({ type }) => type === "model_response")
              ? "accepted"
              : "rejected",
        toolExecution: calls.length > 0 ? "invoked" : "not_invoked",
        modelTurn: finalStatus,
      }),
      events,
    };
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

  it.each(["openai", "anthropic", "openai_compatible"] as const)(
    "discovers, executes, and round-trips the result through the %s model profile",
    async (profile) => {
      const { report, events } = await runScenario("allow", profile);
      expect(report).toEqual({
        providerAcceptance: "accepted",
        toolExecution: "invoked",
        modelTurn: "completed",
      });
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "model_response",
          finishReason: profile === "anthropic" ? "end_turn" : "stop",
        }),
      );
    },
  );

  it.each([
    { name: "a guessed hidden tool name", selection: "hidden" as const, targetConfigured: true },
    { name: "an unconfigured target", selection: "authorized" as const, targetConfigured: false },
  ])("rejects $name without invoking an MCP tool", async ({ selection, targetConfigured }) => {
    const { report, events } = await runScenario(
      "allow",
      "openai_compatible",
      selection,
      targetConfigured,
    );
    expect(report).toEqual({
      providerAcceptance: "rejected",
      toolExecution: "not_invoked",
      modelTurn: "failed",
    });
    expect(events).not.toContainEqual(expect.objectContaining({ type: "tool_intent" }));
  });

  it("validates malformed model arguments before invoking the MCP tool", async () => {
    const { report, events } = await runScenario("allow", "openai_compatible", "malformed");
    expect(report).toEqual({
      providerAcceptance: "accepted",
      toolExecution: "not_invoked",
      modelTurn: "completed",
    });
    expect(events).toContainEqual(
      expect.objectContaining({ type: "tool_result", errorCode: "args_invalid" }),
    );
  });

  it.each(["deny", "ask"] as const)(
    "keeps %s enforcement in the ordinary runtime instead of the model gateway",
    async (decision) => {
      const { report, events } = await runScenario(decision);
      expect(report).toMatchObject({
        providerAcceptance: "accepted",
        modelTurn: "completed",
      });
      expect(events).toContainEqual(
        expect.objectContaining({ type: "tool_intent", policyDecision: decision }),
      );
      expect(report.toolExecution).toBe(decision === "ask" ? "invoked" : "not_invoked");
    },
  );
});
