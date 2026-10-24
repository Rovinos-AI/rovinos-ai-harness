// SPDX-License-Identifier: Apache-2.0
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";
import {
  APPROVAL_RESOURCE_URI,
  MCP_APP_HTML_MIME_TYPE,
  approvalAppResourcePath,
  loadApprovalHtml,
  registerApprovalResource,
} from "./approval.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
  temporaryDirectories.length = 0;
});

describe("approval app resource", () => {
  it("resolves both app assets from workspace, bundled image, and CLI package layouts", async () => {
    const root = await mkdtemp(join(tmpdir(), "approval-resource-"));
    temporaryDirectories.push(root);
    const layouts = [
      [
        "workspace",
        "packages/control-plane/dist/resources/approval.js",
        "packages/approval-app/dist",
      ],
      ["bundled image", "image/dist/approval.js", "image/packages/approval-app/dist"],
      ["CLI package", "cli/dist/approval.js", "cli/approval-app/dist"],
    ] as const;

    for (const [layout, modulePath, assetDirectory] of layouts) {
      for (const filename of ["approval.html", "runs-console.html"] as const) {
        const assetPath = join(root, assetDirectory, filename);
        await mkdir(join(root, assetDirectory), { recursive: true });
        await writeFile(assetPath, `${layout}:${filename}`);
        expect(
          approvalAppResourcePath(
            filename,
            pathToFileURL(join(root, modulePath)).href,
          ),
        ).toBe(assetPath);
      }
    }
  });

  it("returns the CLI fallback when no app asset candidate exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "approval-resource-missing-"));
    temporaryDirectories.push(root);
    const moduleUrl = pathToFileURL(join(root, "cli/dist/approval.js")).href;
    expect(approvalAppResourcePath("approval.html", moduleUrl)).toBe(
      fileURLToPath(new URL("../approval-app/dist/approval.html", moduleUrl)),
    );
  });

  it("loads the built approval HTML", async () => {
    const root = await mkdtemp(join(tmpdir(), "approval-resource-load-"));
    temporaryDirectories.push(root);
    const htmlPath = join(root, "approval.html");
    await writeFile(htmlPath, "<html>approval</html>");
    expect(loadApprovalHtml(htmlPath)).toBe("<html>approval</html>");
  });

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
    let thrown: unknown;
    try {
      loadApprovalHtml("/missing/approval.html");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: "approval_resource_unavailable" });
  });
});
