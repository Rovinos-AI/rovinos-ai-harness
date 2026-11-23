// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadRunInspectorHtml,
  registerRunInspectorResource,
  RUN_INSPECTOR_RESOURCE_URI,
} from "./run-inspector.js";
import { MCP_APP_HTML_MIME_TYPE } from "./approval.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
  temporaryDirectories.length = 0;
});

describe("run inspector resource", () => {
  it("loads the built inspector HTML", async () => {
    const directory = await mkdtemp(join(tmpdir(), "run-inspector-resource-"));
    temporaryDirectories.push(directory);
    const htmlPath = join(directory, "run-inspector.html");
    await writeFile(htmlPath, "<html>inspector</html>");
    expect(loadRunInspectorHtml(htmlPath)).toBe("<html>inspector</html>");
  });

  it("serves the built HTML with the MCP Apps MIME type and no CSP grants", async () => {
    const html = "<!doctype html><html><body>run inspector</body></html>";
    const server = new McpServer({ name: "run-inspector-resource-test", version: "1.0.0" });
    registerRunInspectorResource(server, html);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "run-inspector-resource-client", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const listed = await client.listResources();
      expect(listed.resources).toContainEqual(
        expect.objectContaining({
          uri: RUN_INSPECTOR_RESOURCE_URI,
          mimeType: MCP_APP_HTML_MIME_TYPE,
          _meta: { ui: { csp: {}, permissions: {} } },
        }),
      );
      const result = await client.readResource({ uri: RUN_INSPECTOR_RESOURCE_URI });
      expect(result.contents).toContainEqual(
        expect.objectContaining({
          uri: RUN_INSPECTOR_RESOURCE_URI,
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
    let thrown: unknown;
    try {
      loadRunInspectorHtml("/missing/run-inspector.html");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: "run_inspector_resource_unavailable" });
  });
});
