// SPDX-License-Identifier: Apache-2.0
import { InMemoryTransport, type Tool } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { context as otelContext, trace } from "@opentelemetry/api";
import {
  Code,
  FakeClock,
  Id,
  RunConfigSchema,
  ServerConfigSchema,
  SequentialIdGenerator,
  type ModelRequest,
} from "@rovinos/schemas";
import { InMemoryEventStore } from "@rovinos/store";
import { NaiveContext, RunRecorder, runLoop } from "@rovinos/core";
import type { ModelCompletion, ModelPort, PolicyPort } from "@rovinos/core";
import { McpToolPort } from "@rovinos/mcp";
import { createTestContextManager, createTestSpanCollector } from "@rovinos/telemetry/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const spanCollector = createTestSpanCollector();
const inputSchema = {
  type: "object",
  properties: { value: { type: "string" } },
  required: ["value"],
  additionalProperties: false,
} satisfies Tool["inputSchema"];
const selectedTools = {
  focused: ["mcp_test.echo"],
};

function completion(parts: ModelCompletion["parts"]): ModelCompletion {
  return {
    parts,
    usage: { inputTokens: 2, outputTokens: 1 },
    finishReason: parts.some((part) => part.type === "tool_call") ? "tool_calls" : "stop",
    provider: "test",
    model: "test",
    latencyMs: 0,
    schemaValid: true,
    repairAttempts: 0,
    fallbackDepth: 0,
    providerBlobs: null,
  };
}

function modelFor(parts: readonly ModelCompletion["parts"][number][][]): {
  readonly model: ModelPort;
  readonly requests: ModelRequest[];
} {
  const requests: ModelRequest[] = [];
  let index = 0;
  return {
    requests,
    model: {
      complete: (request) => {
        requests.push(request);
        const nextParts = parts[index] ?? [];
        index += 1;
        return Promise.resolve(completion(nextParts));
      },
    },
  };
}

beforeAll(() => {
  otelContext.setGlobalContextManager(createTestContextManager());
  trace.setGlobalTracerProvider(spanCollector.provider);
});

afterAll(() => {
  otelContext.disable();
  trace.disable();
});

describe("MCP tool profiles", () => {
  it("does not execute a guessed hidden tool and still requests approval for an exposed tool", async () => {
    const [client, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = new McpServer({ name: "tool-profile-test", version: "1.0.0" });
    const calls: string[] = [];
    server.server.registerCapabilities({ tools: { listChanged: true } });
    server.server.setRequestHandler("tools/list", () => ({
      tools: [
        { name: "echo", inputSchema },
        { name: "hidden", inputSchema },
      ],
    }));
    server.server.setRequestHandler("tools/call", (request) => {
      calls.push(request.params.name);
      return { content: [{ type: "text", text: "synthetic" }] };
    });
    await server.connect(serverTransport);
    const port = await McpToolPort.create(
      [
        ServerConfigSchema.parse({
          id: "mcp_test",
          transport: { kind: "stdio", command: "not-spawned-by-test" },
        }),
      ],
      {
        resolveSecret: () => Promise.reject(new Error("unexpected secret")),
        createTransport: () => client,
      },
      { toolProfiles: selectedTools },
    );
    const policy: PolicyPort = {
      version: Code.parse("test.policy"),
      decide: () => ({
        decision: "ask",
        ruleId: Code.parse("manual_review"),
        reason: Code.parse("approval_required"),
        editable: [],
      }),
    };

    try {
      const hiddenModel = modelFor([
        [
          {
            type: "tool_call",
            callId: Id.parse("22222222222222222222222222"),
            toolId: Code.parse("mcp_test.hidden"),
            args: { value: "guessed" },
          },
        ],
        [{ type: "text", text: "finished" }],
      ]);
      const hiddenResult = await runLoop({
        recorder: new RunRecorder(
          new InMemoryEventStore(),
          Id.parse("00000000000000000000000000"),
          Id.parse("11111111111111111111111111"),
          0,
          new FakeClock(100),
        ),
        clock: new FakeClock(100),
        model: hiddenModel.model,
        tool: port,
        context: new NaiveContext(),
        ids: new SequentialIdGenerator(),
        goal: "hidden tool test",
        signal: new AbortController().signal,
        budgets: RunConfigSchema.parse({}).budgets,
        configHash: "a".repeat(64),
        policyVersion: "test.policy",
        toolProfile: Code.parse("focused"),
      });

      expect(hiddenModel.requests[0]?.tools?.map(({ toolId }) => toolId)).toEqual([
        "mcp_test.echo",
      ]);
      expect(hiddenResult.events).toContainEqual(
        expect.objectContaining({ type: "tool_result", errorCode: "tool_not_advertised" }),
      );
      expect(calls).toEqual([]);

      const approvalModel = modelFor([
        [
          {
            type: "tool_call",
            callId: Id.parse("33333333333333333333333333"),
            toolId: Code.parse("mcp_test.echo"),
            args: { value: "approved later" },
          },
        ],
      ]);
      const approvalResult = await runLoop({
        recorder: new RunRecorder(
          new InMemoryEventStore(),
          Id.parse("44444444444444444444444444"),
          Id.parse("55555555555555555555555555"),
          0,
          new FakeClock(100),
        ),
        clock: new FakeClock(100),
        model: approvalModel.model,
        tool: port,
        context: new NaiveContext(),
        ids: new SequentialIdGenerator(),
        goal: "approval tool test",
        signal: new AbortController().signal,
        budgets: RunConfigSchema.parse({}).budgets,
        configHash: "b".repeat(64),
        policyVersion: "test.policy",
        policy,
        toolProfile: Code.parse("focused"),
      });

      expect(approvalResult.status).toBe("suspended");
      expect(approvalResult.state.pendingApprovals.size).toBe(1);
      expect(calls).toEqual([]);
    } finally {
      await port.close();
      await serverTransport.close();
    }
  });
});
