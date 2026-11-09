// SPDX-License-Identifier: Apache-2.0
import { HarnessConfigSchema } from "@rovinos/config";
import { parseYaml } from "@rovinos/schemas";
import { describe, expect, it } from "vitest";
import { McpCatalogInspectionSchema, registerMcpServer, selectMcpTools } from "./mcp-onboarding.js";
import { SdkError } from "./types.js";

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

describe("SDK MCP onboarding", () => {
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
});
