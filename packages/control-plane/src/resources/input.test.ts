// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";
import { INPUT_RESOURCE_URI, loadInputHtml, registerInputResource } from "./input.js";
import { MCP_APP_HTML_MIME_TYPE } from "./approval.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
  temporaryDirectories.length = 0;
});

describe("input app resource", () => {
  it("loads the built input HTML", async () => {
    const directory = await mkdtemp(join(tmpdir(), "input-resource-"));
    temporaryDirectories.push(directory);
    const htmlPath = join(directory, "input.html");
    await writeFile(htmlPath, "<html>input</html>");
    expect(loadInputHtml(htmlPath)).toBe("<html>input</html>");
  });

  it("serves the HTML with the MCP Apps MIME type and open-link permission", async () => {
    const html = "<!doctype html><html><body>built input app</body></html>";
    const server = new McpServer({ name: "input-resource-test", version: "1.0.0" });
    registerInputResource(server, html);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "input-resource-client", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const listed = await client.listResources();
      expect(listed.resources).toContainEqual(
        expect.objectContaining({
          uri: INPUT_RESOURCE_URI,
          mimeType: MCP_APP_HTML_MIME_TYPE,
          _meta: { ui: { csp: {}, permissions: { openLinks: {} } } },
        }),
      );
      const result = await client.readResource({ uri: INPUT_RESOURCE_URI });
      expect(result.contents).toContainEqual(
        expect.objectContaining({
          uri: INPUT_RESOURCE_URI,
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

  it("fails closed when the built input app is missing", () => {
    let thrown: unknown;
    try {
      loadInputHtml("/missing/input.html");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: "input_resource_unavailable" });
  });
});
