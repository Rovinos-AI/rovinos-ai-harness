// SPDX-License-Identifier: Apache-2.0
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import {
  APPROVAL_RESOURCE_URI,
  MCP_APP_HTML_MIME_TYPE,
  loadApprovalHtml,
  registerApprovalResource,
} from "./approval.js";

describe("approval app resource", () => {
  it("serves the approval HTML with the MCP Apps MIME type and empty permissions", async () => {
    const html = "<!doctype html><html><body>built approval</body></html>";
    const server = new McpServer({ name: "approval-resource-test", version: "1.0.0" });
    registerApprovalResource(server, html);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "approval-resource-client", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const listed = await client.listResources();
      expect(listed.resources).toContainEqual(
        expect.objectContaining({
          uri: APPROVAL_RESOURCE_URI,
          mimeType: MCP_APP_HTML_MIME_TYPE,
          _meta: { ui: { csp: {}, permissions: {} } },
        }),
      );
      const result = await client.readResource({ uri: APPROVAL_RESOURCE_URI });
      expect(result.contents).toContainEqual(
        expect.objectContaining({
          uri: APPROVAL_RESOURCE_URI,
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

  it("fails closed when the built artifact is missing", () => {
    expect(() => loadApprovalHtml("/missing/approval.html")).toThrow(
      expect.objectContaining({ code: "approval_resource_unavailable" }),
    );
  });
});
