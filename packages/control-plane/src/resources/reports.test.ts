// SPDX-License-Identifier: Apache-2.0
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { loadReportsHtml, registerReportsResource, REPORTS_RESOURCE_URI } from "./reports.js";
import { MCP_APP_HTML_MIME_TYPE } from "./approval.js";

describe("reports resource", () => {
  it("serves the report viewer as an MCP Apps HTML resource without extra grants", async () => {
    const html = "<!doctype html><html><body>report viewer</body></html>";
    const server = new McpServer({ name: "reports-resource-test", version: "1.0.0" });
    registerReportsResource(server, html);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "reports-resource-client", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const listed = await client.listResources();
      expect(listed.resources).toContainEqual(
        expect.objectContaining({
          uri: REPORTS_RESOURCE_URI,
          mimeType: MCP_APP_HTML_MIME_TYPE,
          _meta: { ui: { csp: {}, permissions: {} } },
        }),
      );
      const result = await client.readResource({ uri: REPORTS_RESOURCE_URI });
      expect(result.contents).toContainEqual(
        expect.objectContaining({
          uri: REPORTS_RESOURCE_URI,
          mimeType: MCP_APP_HTML_MIME_TYPE,
          text: html,
        }),
      );
    } finally {
      await client.close();
      await server.close();
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("fails closed when the built report viewer is missing", () => {
    expect(() => loadReportsHtml("/missing/reports.html")).toThrow(
      expect.objectContaining({ code: "reports_resource_unavailable" }),
    );
  });
});
