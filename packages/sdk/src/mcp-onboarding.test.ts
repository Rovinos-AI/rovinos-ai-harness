// SPDX-License-Identifier: Apache-2.0
import { HarnessConfigSchema } from "@rovinos/config";
import { McpAuthRequiredError, McpConnectionError } from "@rovinos/mcp";
import type * as McpModule from "@rovinos/mcp";
import type { McpTool } from "@rovinos/mcp";
import { parseYaml } from "@rovinos/schemas";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  inspectMcpServer,
  McpCatalogInspectionSchema,
  registerMcpServer,
  selectMcpTools,
} from "./mcp-onboarding.js";
import { SdkError } from "./types.js";

type McpConnection = InstanceType<typeof McpModule.McpConnection>;

const mcpMocks = vi.hoisted(() => {
  let protocolEra: "legacy" | "modern" | undefined = "modern";
  return {
    connect: vi.fn<McpConnection["connect"]>(),
    listTools: vi.fn<McpConnection["listTools"]>(),
    close: vi.fn<McpConnection["close"]>(),
    getProtocolEra: () => protocolEra,
    setProtocolEra: (value: "legacy" | "modern" | undefined) => {
      protocolEra = value;
    },
  };
});

vi.mock("@rovinos/mcp", async (importOriginal) => {
  const actual = await importOriginal<typeof McpModule>();
  return {
    ...actual,
    McpConnection: class {
      get protocolEra() {
        return mcpMocks.getProtocolEra();
      }

      connect() {
        return mcpMocks.connect();
      }

      listTools() {
        return mcpMocks.listTools();
      }

      close() {
        return mcpMocks.close();
      }
    },
  };
});

const server = {
  id: "weather",
  transport: {
    kind: "stdio" as const,
    command: "/usr/bin/node",
    args: ["weather-server.mjs"],
    env: { WEATHER_API_KEY: "env:WEATHER_API_KEY" },
  },
};

const inspection = McpCatalogInspectionSchema.parse({
  serverId: "weather",
  catalogVersion: "a".repeat(64),
  tools: [
    {
      name: "forecast",
      toolId: "weather.forecast",
      description: "Return a synthetic forecast.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      exposed: false,
    },
    {
      name: "send_report",
      toolId: "weather.send_report",
      description: "Send a synthetic report.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      exposed: false,
    },
  ],
  rejectedTools: [{ reason: "tool_name_invalid" }],
});

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function tool(name: string): McpTool {
  return {
    name,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  };
}

describe("SDK MCP onboarding", () => {
  beforeEach(() => {
    mcpMocks.connect.mockReset().mockResolvedValue(undefined);
    mcpMocks.listTools.mockReset().mockResolvedValue([tool("forecast"), tool("send_report")]);
    mcpMocks.close.mockReset().mockResolvedValue(undefined);
    mcpMocks.setProtocolEra("modern");
  });

  it("registers servers with no model exposure by default and matches explicit YAML configuration", () => {
    const config = registerMcpServer({}, server);
    const yamlConfig = parseYaml(
      HarnessConfigSchema,
      [
        "servers:",
        "  - id: weather",
        "    transport:",
        "      kind: stdio",
        "      command: /usr/bin/node",
        "      args: [weather-server.mjs]",
        "      env:",
        "        WEATHER_API_KEY: env:WEATHER_API_KEY",
        "    toolAllowlist: []",
      ].join("\n"),
    );

    expect(config.servers[0]?.toolAllowlist).toEqual([]);
    expect(config.servers[0]?.transport).toEqual({
      kind: "stdio",
      command: "/usr/bin/node",
      args: ["weather-server.mjs"],
      env: { WEATHER_API_KEY: "env:WEATHER_API_KEY" },
      inheritEnv: false,
    });
    expect(config).toEqual(yamlConfig);
  });

  it("returns the exact selected exposure without changing execution authorization", () => {
    const config = registerMcpServer({}, server);

    const result = selectMcpTools(config, inspection, ["forecast"]);

    expect(result.config.servers[0]?.toolAllowlist).toEqual(["forecast"]);
    expect(result.selection).toEqual({
      serverId: "weather",
      catalogVersion: "a".repeat(64),
      tools: [{ name: "forecast", toolId: "weather.forecast" }],
      authorization: "policy_unchanged",
    });
    expect(result.config.policy).toEqual(config.policy);
  });

  it("rejects duplicate server ids with a coded error", () => {
    const config = registerMcpServer({}, server);

    expect(() => registerMcpServer(config, server)).toThrow(
      expect.objectContaining({ code: "sdk_mcp_server_exists" }),
    );
  });

  it("rejects invalid server configuration without including secret values in errors", () => {
    const secretCanary = "synthetic-inline-secret";
    let error: unknown;
    try {
      registerMcpServer(
        {},
        {
          ...server,
          transport: {
            ...server.transport,
            env: { WEATHER_API_KEY: secretCanary },
          },
        },
      );
    } catch (caught: unknown) {
      error = caught;
    }

    expect(error).toBeInstanceOf(SdkError);
    expect(error).toMatchObject({ code: "sdk_mcp_config_invalid" });
    expect(errorMessage(error)).not.toContain(secretCanary);
  });

  it("rejects invalid harness configuration without exposing validation details", () => {
    expect(() => registerMcpServer({ servers: [server, server] }, server)).toThrow(
      expect.objectContaining({ code: "sdk_mcp_config_invalid" }),
    );
  });

  it("rejects selections outside the inspected catalog", () => {
    const config = registerMcpServer({}, server);

    expect(() => selectMcpTools(config, inspection, ["delete_everything"])).toThrow(
      expect.objectContaining({ code: "sdk_mcp_tool_not_found" }),
    );
    expect(() => selectMcpTools(config, inspection, ["forecast", "forecast"])).toThrow(
      expect.objectContaining({ code: "sdk_mcp_selection_invalid" }),
    );
  });

  it("binds the exposure preview to the reviewed catalog and does not expose later additions", () => {
    const config = registerMcpServer({}, server);
    const changedInspection = McpCatalogInspectionSchema.parse({
      ...inspection,
      catalogVersion: "b".repeat(64),
      tools: [
        ...inspection.tools,
        {
          name: "new_tool",
          toolId: "weather.new_tool",
          description: "A newly discovered synthetic tool.",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
          exposed: false,
        },
      ],
    });

    const result = selectMcpTools(config, changedInspection, ["forecast"]);

    expect(result.selection.catalogVersion).toBe("b".repeat(64));
    expect(result.config.servers[0]?.toolAllowlist).toEqual(["forecast"]);
    expect(result.selection.tools.map(({ name }) => name)).toEqual(["forecast"]);
  });

  it("validates a discovered catalog and reports configured exposure and rejected tools", async () => {
    mcpMocks.listTools.mockResolvedValue([tool("forecast"), tool("send_report"), tool("")]);
    mcpMocks.setProtocolEra(undefined);

    const result = await inspectMcpServer(
      { ...server, toolAllowlist: ["forecast"] },
      { resolveSecret: () => Promise.resolve("synthetic-secret") },
    );

    expect(result.serverId).toBe("weather");
    expect(result.protocolEra).toBeUndefined();
    expect(result.tools.map(({ name, exposed }) => ({ name, exposed }))).toEqual([
      { name: "forecast", exposed: true },
      { name: "send_report", exposed: false },
    ]);
    expect(result.rejectedTools).toEqual([{ reason: "tool_name_invalid" }]);
    expect(mcpMocks.close).toHaveBeenCalledOnce();
  });

  it("maps invalid inspection options to a closed SDK error", async () => {
    await expect(Reflect.apply(inspectMcpServer, undefined, [server, {}])).rejects.toMatchObject({
      code: "sdk_mcp_inspection_options_invalid",
    });
  });

  it("maps connection errors to their closed codes and always closes the connection", async () => {
    mcpMocks.connect.mockRejectedValueOnce(new McpConnectionError("mcp_connect_timeout"));

    await expect(
      inspectMcpServer(server, { resolveSecret: () => Promise.resolve("synthetic-secret") }),
    ).rejects.toMatchObject({ code: "mcp_connect_timeout" });
    expect(mcpMocks.close).toHaveBeenCalledOnce();
  });

  it("maps authentication failures and generic connection failures safely", async () => {
    mcpMocks.connect.mockRejectedValueOnce(new McpAuthRequiredError());

    await expect(
      inspectMcpServer(server, { resolveSecret: () => Promise.resolve("synthetic-secret") }),
    ).rejects.toMatchObject({ code: "mcp_auth_required" });

    mcpMocks.listTools.mockRejectedValueOnce(new Error("synthetic_remote_error"));
    await expect(
      inspectMcpServer(server, { resolveSecret: () => Promise.resolve("synthetic-secret") }),
    ).rejects.toMatchObject({ code: "sdk_mcp_inspection_failed" });
  });

  it("maps tool registry collisions to a closed catalog error", async () => {
    mcpMocks.listTools.mockResolvedValueOnce([tool("same"), tool("Same")]);

    await expect(
      inspectMcpServer(server, { resolveSecret: () => Promise.resolve("synthetic-secret") }),
    ).rejects.toMatchObject({ code: "sdk_mcp_catalog_invalid" });
  });

  it("rejects invalid catalogs and selections for absent servers", () => {
    const config = registerMcpServer({}, server);

    expect(() => {
      Reflect.apply(selectMcpTools, undefined, [config, {}, ["forecast"]]);
    }).toThrow(expect.objectContaining({ code: "sdk_mcp_catalog_invalid" }));
    expect(() => {
      selectMcpTools(config, { ...inspection, serverId: "other" }, ["forecast"]);
    }).toThrow(expect.objectContaining({ code: "sdk_mcp_server_not_found" }));
    expect(() => {
      Reflect.apply(selectMcpTools, undefined, [config, inspection, null]);
    }).toThrow(expect.objectContaining({ code: "sdk_mcp_selection_invalid" }));
  });

  it("selects only catalog tools, preserves selected idempotency, and supports empty exposure", () => {
    const config = registerMcpServer(
      {},
      {
        ...server,
        toolAllowlist: ["forecast", "send_report"],
        idempotentTools: ["forecast"],
      },
    );
    const selected = selectMcpTools(config, inspection, ["send_report", "forecast"]);
    const empty = selectMcpTools(config, inspection, []);

    expect(selected.config.servers[0]?.toolAllowlist).toEqual(["forecast", "send_report"]);
    expect(selected.config.servers[0]?.idempotentTools).toEqual(["forecast"]);
    expect(selected.selection.tools.map(({ name }) => name)).toEqual(["forecast", "send_report"]);
    expect(empty.config.servers[0]?.toolAllowlist).toEqual([]);
    expect(empty.selection.tools).toEqual([]);
  });
});
