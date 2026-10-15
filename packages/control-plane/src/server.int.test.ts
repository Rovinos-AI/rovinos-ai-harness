// SPDX-License-Identifier: Apache-2.0
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { Id } from "@harness/schemas";
import { InMemoryEventStore } from "@harness/store";
import { request } from "node:http";
import { describe, expect, it } from "vitest";
import { startControlPlaneHttp } from "./server.js";

function sendMcpRequest(endpoint: string, headers: Record<string, string>): Promise<number> {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  return new Promise((resolve, reject) => {
    const outgoing = request(
      new URL(endpoint),
      {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          ...headers,
        },
      },
      (incoming) => {
        incoming.resume();
        incoming.on("end", () => {
          resolve(incoming.statusCode ?? 0);
        });
      },
    );
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}

describe("control-plane HTTP transport", () => {
  it("serves the same tools over loopback and rejects invalid Host and Origin headers", async () => {
    const store = new InMemoryEventStore();
    const server = await startControlPlaneHttp(store, 0, { approvalHtml: "<html>test</html>" });
    const client = new Client({ name: "control-plane-http-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(server.endpoint));
    try {
      expect(new URL(server.endpoint).hostname).toBe("127.0.0.1");
      await client.connect(transport);
      const { tools } = await client.listTools();
      expect(tools.map(({ name }) => name).sort()).toEqual([
        "cancel_run",
        "get_run",
        "list_runs",
        "resume_run",
      ]);
      await expect(client.callTool({ name: "list_runs", arguments: {} })).resolves.toMatchObject({
        structuredContent: { runs: [] },
        content: [{ text: "0 runs." }],
      });

      await expect(sendMcpRequest(server.endpoint, { host: "untrusted.example" })).resolves.toBe(
        403,
      );
      await expect(
        sendMcpRequest(server.endpoint, { origin: "http://untrusted.example" }),
      ).resolves.toBe(403);
      await expect(fetch(server.endpoint.replace("/mcp", "/other"))).resolves.toMatchObject({
        status: 404,
      });
    } finally {
      await client.close();
      await server.close();
      await store.close();
    }
  });

  it("shares resume supervision across requests and propagates later cancellation", async () => {
    const store = new InMemoryEventStore();
    let resumeSignal: AbortSignal | undefined;
    let markStarted: () => void = () => undefined;
    let markAborted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const aborted = new Promise<void>((resolve) => {
      markAborted = resolve;
    });
    const server = await startControlPlaneHttp(store, 0, {
      approvalHtml: "<html>test</html>",
      maxConcurrentRuns: 1,
      isAppContext: () => true,
      operations: {
        resumeRun: (_runId, signal, onClaimed) => {
          resumeSignal = signal;
          onClaimed();
          markStarted();
          return new Promise((resolve) => {
            signal.addEventListener(
              "abort",
              () => {
                markAborted();
                resolve({ status: "suspended" });
              },
              { once: true },
            );
          });
        },
        cancelRun: () => Promise.resolve("cancelled"),
      },
    });
    const firstClient = new Client({ name: "control-plane-http-first", version: "1.0.0" });
    const secondClient = new Client({ name: "control-plane-http-second", version: "1.0.0" });
    try {
      await firstClient.connect(new StreamableHTTPClientTransport(new URL(server.endpoint)));
      await secondClient.connect(new StreamableHTTPClientTransport(new URL(server.endpoint)));
      const firstRunId = Id.parse("00000000000000000000000001");
      const secondRunId = Id.parse("00000000000000000000000002");

      await expect(
        firstClient.callTool({ name: "resume_run", arguments: { runId: firstRunId } }),
      ).resolves.toMatchObject({ structuredContent: { started: true } });
      await started;
      await expect(
        secondClient.callTool({ name: "resume_run", arguments: { runId: secondRunId } }),
      ).resolves.toMatchObject({
        isError: true,
        structuredContent: { started: false, code: "capacity_exceeded" },
      });
      await expect(
        secondClient.callTool({ name: "cancel_run", arguments: { runId: firstRunId } }),
      ).resolves.toMatchObject({ structuredContent: { ok: true } });
      await aborted;

      expect(resumeSignal?.aborted).toBe(true);
    } finally {
      await firstClient.close();
      await secondClient.close();
      await server.close();
      await store.close();
    }
  });
});
