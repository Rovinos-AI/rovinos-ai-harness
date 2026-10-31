// SPDX-License-Identifier: Apache-2.0
import type { Tool } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { filterToolsForClient, supportsMcpApps } from "./capabilities.js";

const appCapabilities = {
  extensions: {
    "io.modelcontextprotocol/ui": {
      mimeTypes: ["text/html;profile=mcp-app"],
    },
  },
};

const tools: Tool[] = [
  { name: "list_runs", description: "List", inputSchema: { type: "object" } },
  {
    name: "harness.runs.list",
    description: "List in app",
    inputSchema: { type: "object" },
  },
  {
    name: "harness.runs.get",
    description: "Get in app",
    inputSchema: { type: "object" },
  },
  {
    name: "harness.approvals.resolve",
    description: "Resolve in app",
    inputSchema: { type: "object" },
  },
  {
    name: "harness.inputs.answer",
    description: "Answer in app",
    inputSchema: { type: "object" },
  },
  {
    name: "approve",
    description: "Approve",
    inputSchema: { type: "object" },
    _meta: { ui: { visibility: ["app"] } },
  },
];

describe("MCP Apps capability filtering", () => {
  it("requires the extension and the exact supported MIME type", () => {
    expect(supportsMcpApps(appCapabilities)).toBe(true);
    expect(
      supportsMcpApps({
        extensions: {
          "io.modelcontextprotocol/ui": { mimeTypes: ["text/html"] },
        },
      }),
    ).toBe(false);
    expect(supportsMcpApps({ extensions: {} })).toBe(false);
    expect(supportsMcpApps(undefined)).toBe(false);
  });

  it("omits app-only tools from clients without MCP Apps", () => {
    expect(filterToolsForClient(tools, undefined).map(({ name }) => name)).toEqual(["list_runs"]);
  });

  it("keeps app tools when the client advertises the supported extension", () => {
    expect(filterToolsForClient(tools, appCapabilities)).toEqual(tools);
  });
});
