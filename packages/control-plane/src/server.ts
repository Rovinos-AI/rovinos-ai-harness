// SPDX-License-Identifier: Apache-2.0
import { HarnessError } from "@harness/schemas";
import type { EventStore } from "@harness/store";
import {
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler,
} from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { serveStdio, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import { createServer, type Server } from "node:http";
import { controlPlaneHttpPortSchema } from "./schemas.js";
import { registerGetRunTool } from "./tools/get-run.js";
import { registerListRunsTool } from "./tools/list-runs.js";

const HTTP_HOST = "127.0.0.1";
const HTTP_PATH = "/mcp";

class ControlPlaneListenError extends HarnessError {
  override readonly code = "control_plane_listen_failed";

  constructor() {
    super("The control-plane HTTP listener failed.");
  }
}

/** A running loopback HTTP endpoint. */
export interface ControlPlaneHttpHandle {
  /** MCP endpoint URL. */
  endpoint: string;
  /** Closes the listener and active connections. */
  close(): Promise<void>;
}

/** Creates the shared MCP server with metadata-only run inspection tools. */
export function createControlPlaneServer(store: EventStore): McpServer {
  const server = new McpServer({ name: "rovinos-ai-harness-control-plane", version: "0.0.0" });
  server.server.registerCapabilities({ tools: {} });
  registerListRunsTool(server, store);
  registerGetRunTool(server, store);
  return server;
}

/** Starts the same read-only MCP server over stdio. */
export function startControlPlaneStdio(store: EventStore): StdioServerHandle {
  return serveStdio(() => createControlPlaneServer(store));
}

/** Starts a loopback-only stateless HTTP MCP endpoint with Host and Origin checks. */
export async function startControlPlaneHttp(
  store: EventStore,
  port: number,
): Promise<ControlPlaneHttpHandle> {
  const checkedPort = controlPlaneHttpPortSchema.parse(port);
  const handler = createMcpHandler(() => createControlPlaneServer(store));
  const requestHandler = toNodeHandler(handler);
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();
  const server: Server = createServer((request, response) => {
    if ((request.url ?? "").split("?", 1)[0] !== HTTP_PATH) {
      response.writeHead(404).end();
      return;
    }
    if (!validateHost(request, response) || !validateOrigin(request, response)) {
      return;
    }
    void requestHandler(
      {
        method: request.method ?? "GET",
        url: request.url ?? "/",
        headers: request.headers,
        [Symbol.asyncIterator]: () => request[Symbol.asyncIterator](),
      },
      response,
    ).catch(() => {
      if (!response.headersSent) {
        response
          .writeHead(500, { "content-type": "text/plain; charset=utf-8" })
          .end("control_plane_request_failed");
      } else if (!response.writableEnded) {
        response.end();
      }
    });
  });
  await listen(server, checkedPort);
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new ControlPlaneListenError();
  }
  return {
    endpoint: `http://${HTTP_HOST}:${String(address.port)}${HTTP_PATH}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error !== undefined) {
            reject(new ControlPlaneListenError());
            return;
          }
          resolve();
        });
        server.closeAllConnections();
      }),
  };
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (): void => {
      server.off("error", onError);
      reject(new ControlPlaneListenError());
    };
    server.once("error", onError);
    server.listen(port, HTTP_HOST, () => {
      server.off("error", onError);
      resolve();
    });
  });
}
