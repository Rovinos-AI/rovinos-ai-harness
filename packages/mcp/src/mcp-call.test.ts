// SPDX-License-Identifier: Apache-2.0
import {
  CLIENT_CAPABILITIES_META_KEY,
  UrlElicitationRequiredError,
  type CallToolRequest,
  type CallToolRequestOptions,
  type CallToolResult,
  type Client,
} from "@modelcontextprotocol/client";
import { ServerConfigSchema } from "@rovinos/schemas";
import { describe, expect, it } from "vitest";
import { invokeMcpTool } from "./mcp-call.js";
import { McpProtocolError } from "./errors.js";

function serverConfig(input: { readonly enabled: boolean; readonly modes?: ("form" | "url")[] }) {
  return ServerConfigSchema.parse({
    id: "mcp_test",
    transport: { kind: "stdio", command: "unused-test-command" },
    protocol: "2026-07-28",
    elicitation: {
      enabled: input.enabled,
      ...(input.modes === undefined ? {} : { modes: input.modes }),
    },
  });
}

describe("invokeMcpTool elicitation metadata", () => {
  it("declares only configured modes and preserves exact retry material", async () => {
    const calls: CallToolRequest["params"][] = [];
    const options: (CallToolRequestOptions | undefined)[] = [];
    const client: Pick<Client, "callTool"> = {
      callTool: (params, requestOptions) => {
        calls.push(params);
        options.push(requestOptions);
        return Promise.resolve({ content: [] } satisfies CallToolResult);
      },
    };
    const requestState = "opaque-\u0000-\u{1f4a1}";
    await invokeMcpTool({
      client,
      server: serverConfig({ enabled: true, modes: ["form"] }),
      params: {
        name: "echo",
        arguments: {},
        _meta: {
          [CLIENT_CAPABILITIES_META_KEY]: { roots: {}, sampling: {} },
        },
      },
      inputRetry: {
        round: 2,
        requestState,
        inputResponses: {
          "server-key": { action: "accept", answer: { answer: "Ada" } },
        },
      },
    });

    expect(calls[0]).toMatchObject({
      requestState,
      inputResponses: {
        "server-key": { action: "accept", content: { answer: "Ada" } },
      },
      _meta: {
        [CLIENT_CAPABILITIES_META_KEY]: { elicitation: { form: {} } },
      },
    });
    expect(options[0]?.allowInputRequired).toBe(true);
  });

  it("removes caller-supplied capabilities when elicitation is disabled", async () => {
    const calls: CallToolRequest["params"][] = [];
    const client: Pick<Client, "callTool"> = {
      callTool: (params) => {
        calls.push(params);
        return Promise.resolve({ content: [] } satisfies CallToolResult);
      },
    };
    await invokeMcpTool({
      client,
      server: serverConfig({ enabled: false }),
      params: {
        name: "echo",
        arguments: {},
        _meta: {
          [CLIENT_CAPABILITIES_META_KEY]: { elicitation: { form: {}, url: {} }, roots: {} },
        },
      },
    });
    expect(calls[0]?._meta?.[CLIENT_CAPABILITIES_META_KEY]).toBeUndefined();
  });

  it("retries legacy URL input without sending MRTR response metadata", async () => {
    const calls: CallToolRequest["params"][] = [];
    const client: Pick<Client, "callTool"> = {
      callTool: (params) => {
        calls.push(params);
        return Promise.resolve({ content: [] } satisfies CallToolResult);
      },
    };
    await invokeMcpTool({
      client,
      server: serverConfig({ enabled: true, modes: ["url"] }),
      params: { name: "echo", arguments: {} },
      inputRetry: {
        round: 1,
        source: "mcp_legacy",
        requestState: "ignored-by-legacy",
        inputResponses: { "legacy-input-id": { action: "accept" } },
      },
    });
    expect(calls[0]).not.toHaveProperty("inputResponses");
    expect(calls[0]).not.toHaveProperty("requestState");
  });

  it("rejects an answer that cannot be represented by an MCP elicitation result", async () => {
    const client: Pick<Client, "callTool"> = {
      callTool: () => Promise.resolve({ content: [] }),
    };
    await expect(
      invokeMcpTool({
        client,
        server: serverConfig({ enabled: true, modes: ["form"] }),
        params: { name: "echo", arguments: {} },
        inputRetry: {
          round: 1,
          inputResponses: {
            "server-key": { action: "accept", answer: "not-a-form-content-object" },
          },
        },
      }),
    ).rejects.toThrow("Resolved input does not match");
  });

  it("preserves only URL inputs from the SDK's legacy URL-required error", async () => {
    const urlElicitations = [
      {
        mode: "url" as const,
        elicitationId: "legacy-id",
        message: "Continue in your browser",
        url: "https://example.test/account",
      },
    ];
    const client: Pick<Client, "callTool"> = {
      callTool: () => Promise.reject(new UrlElicitationRequiredError(urlElicitations)),
    };
    await expect(
      invokeMcpTool({
        client,
        server: serverConfig({ enabled: true, modes: ["url"] }),
        params: { name: "echo", arguments: {} },
      }),
    ).rejects.toMatchObject(
      new McpProtocolError(-32042, urlElicitations),
    );
  });
});
