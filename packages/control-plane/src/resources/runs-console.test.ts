// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadRunsConsoleHtml,
  registerRunsConsoleResource,
  RUNS_CONSOLE_RESOURCE_URI,
} from "./runs-console.js";
import { MCP_APP_HTML_MIME_TYPE } from "./approval.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
  temporaryDirectories.length = 0;
});

describe("runs console resource", () => {
  it("loads the built runs console HTML", async () => {
    const directory = await mkdtemp(join(tmpdir(), "runs-console-resource-"));
    temporaryDirectories.push(directory);
    const htmlPath = join(directory, "runs-console.html");
    await writeFile(htmlPath, "<html>runs</html>");
    expect(loadRunsConsoleHtml(htmlPath)).toBe("<html>runs</html>");
  });

  it("serves the built HTML with the MCP Apps MIME type and no CSP grants", async () => {
    const html = "<!doctype html><html><body>built runs console</body></html>";
    const server = new McpServer({ name: "runs-resource-test", version: "1.0.0" });
    registerRunsConsoleResource(server, html);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "runs-resource-client", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const listed = await client.listResources();
      expect(listed.resources).toContainEqual(
        expect.objectContaining({
          uri: RUNS_CONSOLE_RESOURCE_URI,
          mimeType: MCP_APP_HTML_MIME_TYPE,
          _meta: { ui: { csp: {}, permissions: {} } },
        }),
      );
      const result = await client.readResource({ uri: RUNS_CONSOLE_RESOURCE_URI });
      expect(result.contents).toContainEqual(
        expect.objectContaining({
          uri: RUNS_CONSOLE_RESOURCE_URI,
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
      loadRunsConsoleHtml("/missing/runs-console.html");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: "runs_console_resource_unavailable" });
  });
});
