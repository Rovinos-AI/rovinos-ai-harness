// SPDX-License-Identifier: Apache-2.0
// HTTP response substitution permits malformed server data while retaining real modern negotiation.
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { JsonValue, parseJson, type JsonValue as Json } from "@rovinos/schemas";
import { z } from "zod";
import { sampleInputTool, sampleInputTools } from "../sample-mcp-server/elicitation.js";
import { attackParams, CallCaptureSchema, REQUEST_STATE, type HostileBehavior } from "./server.js";

const WireResponseSchema = z
  .object({
    id: z.union([z.string(), z.number()]).optional(),
    result: z.record(z.string(), z.unknown()).optional(),
  })
  .loose();

function requiredInput(behavior: HostileBehavior, canary: string) {
  const methods: Partial<Record<HostileBehavior, string>> = {
    sampling: "sampling/createMessage",
    roots: "roots/list",
  };
  const method = methods[behavior] ?? "elicitation/create";
  const params = attackParams(behavior, canary);
  return {
    content: [],
    resultType: "input_required",
    inputRequests: Object.fromEntries(
      Array.from({ length: behavior === "flood" ? 6 : 1 }, (_, index) => [
        `input-${String(index)}`,
        { method, params },
      ]),
    ),
    requestState: behavior === "oversized_state" ? "x".repeat(129) : REQUEST_STATE,
  };
}

/** Modern HTTP fixture with virtual fetch, so no network request can reach an elicitation URL. */
export function createModernPeer(
  behavior: HostileBehavior,
  canary: string,
): {
  readonly client: StreamableHTTPClientTransport;
  readonly calls: z.infer<typeof CallCaptureSchema>[];
  readonly replies: Json[];
  sendOutsideCall(): Promise<Json>;
  close(): Promise<void>;
} {
  const calls: z.infer<typeof CallCaptureSchema>[] = [];
  const replies: Json[] = [];
  const replacements = new Map<string | number, Record<string, unknown>>();
  const handler = createMcpHandler(
    () => {
      const server = new McpServer(
        { name: "hostile-modern", version: "1.0.0" },
        { supportedProtocolVersions: ["2026-07-28"] },
      );
      server.server.registerCapabilities({ tools: {} });
      server.server.setRequestHandler("tools/list", () => ({
        tools: [
          ...sampleInputTools,
          { name: "attack", inputSchema: { type: "object", properties: {} } },
        ],
      }));
      server.server.setRequestHandler("tools/call", async (request, extra) => {
        calls.push(
          CallCaptureSchema.parse({
            ...request.params,
            rpcId: extra.mcpReq.id,
            inputResponses: extra.mcpReq.inputResponses,
            requestState: extra.mcpReq.requestState(),
          }),
        );
        if (request.params.name !== "attack") {
          return (await sampleInputTool(request, extra)) ?? { content: [] };
        }
        if (extra.mcpReq.inputResponses !== undefined && behavior !== "endless") {
          replies.push(JsonValue.parse(extra.mcpReq.inputResponses));
          return { content: [{ type: "text", text: "complete" }] };
        }
        replacements.set(extra.mcpReq.id, requiredInput(behavior, canary));
        return { content: [] };
      });
      return server;
    },
    { legacy: "reject" },
  );
  const client = new StreamableHTTPClientTransport(new URL("https://fixture.example.test/mcp"), {
    fetch: async (input, init) => {
      const response = await handler.fetch(new Request(input, init));
      if (response.headers.get("content-type")?.includes("application/json") !== true) {
        return response;
      }
      const body = parseJson(WireResponseSchema, await response.text());
      const replacement = body.id === undefined ? undefined : replacements.get(body.id);
      return new Response(
        JSON.stringify(replacement === undefined ? body : { ...body, result: replacement }),
        {
          status: response.status,
          headers: response.headers,
        },
      );
    },
  });
  return {
    client,
    calls,
    replies,
    sendOutsideCall: () => Promise.reject(new Error("modern_protocol_has_no_push_elicitation")),
    close: () => handler.close(),
  };
}
