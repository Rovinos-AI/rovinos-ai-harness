// SPDX-License-Identifier: Apache-2.0
// Paid smoke only: operators must provide an explicitly opted-in, restricted staging key.
import { InMemoryTransport, type Tool } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { createRuntime, type ModelPort } from "@rovinos/core";
import {
  createLiveModelClient,
  createLiveModelSession,
  startLiveModelGateway,
} from "@rovinos/eval";
import { PolicyDocumentSchema, PolicyEngine } from "@rovinos/policy";
import {
  FakeClock,
  ModelsConfigSchema,
  RunConfigSchema,
  SequentialIdGenerator,
  ServerConfigSchema,
  type ModelRequest,
} from "@rovinos/schemas";
import { InMemoryEventStore } from "@rovinos/store";
import { describe, expect, it } from "vitest";

const stagingKey = process.env.HARNESS_LIVE_EVAL_API_KEY;
const stagingModel = process.env.HARNESS_LIVE_EVAL_MODEL;
const optedIn =
  process.env.HARNESS_LIVE_EVAL === "1" &&
  process.env.HARNESS_LIVE_EVAL_PROFILE === "restricted-staging" &&
  stagingKey !== undefined &&
  stagingKey.trim().length > 0 &&
  !stagingKey.startsWith("$(") &&
  stagingModel !== undefined &&
  stagingModel.trim().length > 0;
const fixtureMarker = "synthetic-live-eval-fixture-complete";

describe.skipIf(!optedIn)("LIVE eval MCP model path with restricted staging credentials", () => {
  it("uses the host-only model session and Unix gateway to complete one synthetic MCP task", async () => {
    if (stagingKey === undefined || stagingModel === undefined) {
      throw new Error("live_eval_staging_configuration_required");
    }
    const cleanup: (() => Promise<void>)[] = [];
    try {
      const signal = AbortSignal.timeout(45_000);
      const clock = new FakeClock(1_000);
      const session = await createLiveModelSession({
        models: ModelsConfigSchema.parse({
          providers: [
            {
              id: "staging",
              kind: "openai",
              baseUrl: "https://api.openai.com/v1",
              apiKey: "env:HARNESS_LIVE_EVAL_API_KEY",
              maxOutputTokens: 256,
              streaming: false,
            },
          ],
          routing: { default: [{ provider: "staging", model: stagingModel }] },
          retry: { maxAttempts: 1 },
        }),
        secretResolver: { resolve: () => Promise.resolve({ reveal: () => stagingKey }) },
        maxCalls: 4,
        clock,
        signal,
      });
      cleanup.push(() => session.close());
      const gateway = await startLiveModelGateway(session.model, { signal });
      cleanup.push(() => gateway.close());
      const client = createLiveModelClient(gateway.socketPath);
      const requests: ModelRequest[] = [];
      const clientPayloads: string[] = [];
      const model: ModelPort = {
        complete: async (request, context) => {
          requests.push(request);
          clientPayloads.push(JSON.stringify(request));
          const response = await client.complete(request, context);
          clientPayloads.push(JSON.stringify(response));
          return response;
        },
      };
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const fixture = new McpServer({ name: "live-eval-fixture", version: "1.0.0" });
      cleanup.push(() => fixture.close());
      let discoveries = 0;
      let calls = 0;
      const inputSchema = {
        type: "object",
        properties: {},
        additionalProperties: false,
      } satisfies Tool["inputSchema"];
      fixture.server.registerCapabilities({ tools: {} });
      fixture.server.setRequestHandler("tools/list", () => {
        discoveries += 1;
        return {
          tools: [{ name: "read", description: "Read the synthetic fixture marker", inputSchema }],
        };
      });
      fixture.server.setRequestHandler("tools/call", () => {
        calls += 1;
        return { content: [{ type: "text", text: fixtureMarker }] };
      });
      await fixture.connect(serverTransport);
      const runtime = await createRuntime(
        {
          run: RunConfigSchema.parse({ budgets: { maxSteps: 4 } }),
          models: ModelsConfigSchema.parse({
            routing: { default: [{ provider: "staging", model: stagingModel }] },
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
                  id: "fixture.read",
                  match: { tools: ["fixture.read"] },
                  decision: "allow",
                  reason: "synthetic_fixture",
                },
              ],
            }),
          ),
        },
      );
      cleanup.push(() => runtime.close());
      const result = await runtime.start(
        "Call fixture.read exactly once, then answer only with the synthetic marker it returned.",
        { signal },
      ).completion;
      const credentialOutsideHost = [...clientPayloads, JSON.stringify(result.events)].some(
        (payload) => payload.includes(stagingKey),
      );
      // Assertions retain booleans and metadata, not the credential even when a check fails.
      expect(credentialOutsideHost).toBe(false);
      expect(result.status).toBe("completed");
      expect(discoveries).toBeGreaterThan(0);
      expect(calls).toBe(1);
      expect(session.calls).toBeGreaterThanOrEqual(2);
      expect(session.calls).toBeLessThanOrEqual(4);
      expect(session.failureCode).toBeUndefined();
      expect(gateway.rejections).toBe(0);
      expect(
        requests
          .slice(1)
          .some((request) =>
            request.messages.some((message) =>
              message.parts.some(
                (part) =>
                  part.type === "tool_result" &&
                  JSON.stringify(part.result).includes(fixtureMarker),
              ),
            ),
          ),
      ).toBe(true);
    } catch {
      throw new Error("live_eval_model_path_failed");
    } finally {
      for (const close of cleanup.reverse()) {
        await close();
      }
    }
  }, 60_000);
});
