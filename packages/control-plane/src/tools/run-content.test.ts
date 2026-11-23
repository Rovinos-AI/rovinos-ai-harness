// SPDX-License-Identifier: Apache-2.0
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { ControlPlaneConfigSchema, Id } from "@rovinos/schemas";
import { InMemoryEventStore } from "@rovinos/store";
import { createEventBuilders } from "@rovinos/store/testing";
import { afterEach, describe, expect, it } from "vitest";
import { startControlPlaneHttp } from "../server.js";

const connections: {
  readonly client: Client;
  readonly server: Awaited<ReturnType<typeof startControlPlaneHttp>>;
  readonly store: InMemoryEventStore;
}[] = [];

async function connectWithScope(scope: "read" | "read_content") {
  const store = new InMemoryEventStore();
  const token = `synthetic-run-content-token-${scope}-0123456789`;
  const server = await startControlPlaneHttp(store, 0, {
    controlPlane: ControlPlaneConfigSchema.parse({
      auth: {
        tokens: [
          {
            id: `token.content_${scope}`,
            secret: "env:RUN_CONTENT_TOKEN",
            scopes: [scope],
          },
        ],
      },
    }),
    secretResolver: { resolve: () => Promise.resolve({ reveal: () => token }) },
    runInspectorHtml: "<html></html>",
  });
  const client = new Client({ name: "run-content-scope-test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server.endpoint), {
      requestInit: { headers: { authorization: ["Bearer", token].join(" ") } },
    }),
  );
  connections.push({ client, server, store });
  return { client, store };
}

afterEach(async () => {
  await Promise.all(
    connections.splice(0).map(async ({ client, server, store }) => {
      await client.close();
      await server.close();
      await store.close();
    }),
  );
});

describe("run content authorization", () => {
  it("keeps tokenized content unavailable to a read-only token", async () => {
    const { client, store } = await connectWithScope("read");
    const runId = Id.parse("A".repeat(26));
    const builders = createEventBuilders();
    await store.append(
      runId,
      [builders.runCreated(runId), builders.modelRequest(runId, "<EMAIL_1>")],
      0,
    );

    await expect(
      client.callTool({ name: "harness.runs.content", arguments: { runId } }),
    ).resolves.toMatchObject({
      isError: true,
      content: [{ type: "text", text: "control_plane_scope_required" }],
    });
  });

  it("returns only stored tokenized values to a read_content token", async () => {
    const { client, store } = await connectWithScope("read_content");
    const runId = Id.parse("B".repeat(26));
    const builders = createEventBuilders();
    await store.append(
      runId,
      [builders.runCreated(runId), builders.modelRequest(runId, "<EMAIL_1>")],
      0,
    );

    const result = await client.callTool({
      name: "harness.runs.content",
      arguments: { runId },
    });
    expect(result.structuredContent).toMatchObject({
      runId,
      truncated: false,
      events: [{ type: "model_request", value: [{ parts: [{ text: "<EMAIL_1>" }] }] }],
    });
    expect(JSON.stringify(result)).not.toContain("person@example.test");
  });

  it("reports an unknown run to a read_content token", async () => {
    const { client } = await connectWithScope("read_content");
    const result = await client.callTool({
      name: "harness.runs.content",
      arguments: { runId: Id.parse("D".repeat(26)) },
    });

    expect(result).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "run_not_found" }],
    });
  });
});
