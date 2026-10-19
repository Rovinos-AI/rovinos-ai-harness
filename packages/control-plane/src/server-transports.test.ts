// SPDX-License-Identifier: Apache-2.0
import { InMemoryEventStore } from "@harness/store";
import { ControlPlaneConfigSchema, HarnessError, Id } from "@harness/schemas";
import type * as McpServerModule from "@modelcontextprotocol/server";
import type { ControlPlaneServerOptions } from "./server.js";
import { describe, expect, it, vi } from "vitest";

interface MockRequest {
  readonly url?: string;
  readonly method?: string;
  readonly headers: Record<string, string | undefined>;
  [Symbol.asyncIterator](): AsyncIterator<unknown>;
}

interface MockResponse {
  statusCode: number;
  headersSent: boolean;
  writableEnded: boolean;
  body: string | undefined;
  writeHead(status: number, headers?: Record<string, string>): MockResponse;
  end(body?: string): MockResponse;
}

type RequestListener = (request: MockRequest, response: MockResponse) => void;

class MissingApprovalHtmlError extends HarnessError {
  override readonly code = "approval_resource_unavailable";

  constructor() {
    super("The approval app resource is unavailable.");
  }
}

const mocks = vi.hoisted(() => {
  let requestListener: RequestListener | undefined;
  let listenError: ((error: Error) => void) | undefined;
  let address: { port: number } | string | null = { port: 41234 };
  let failListen = false;
  let failClose = false;
  const httpRequestHandler = vi.fn(() => Promise.resolve());
  const loadApprovalHtml = vi.fn(() => "<html>test</html>");
  const server = {
    address: () => address,
    listen: (_port: number, _host: string, callback: () => void) => {
      if (failListen) {
        listenError?.(new Error("test listen failure"));
      } else {
        callback();
      }
    },
    close: (callback: (error?: Error) => void) => {
      callback(failClose ? new Error("test close failure") : undefined);
    },
    closeAllConnections: vi.fn(),
    once: (_event: string, callback: (error: Error) => void) => {
      listenError = callback;
    },
    off: vi.fn(),
  };
  return {
    createServer: vi.fn((listener: RequestListener) => {
      requestListener = listener;
      return server;
    }),
    createHttpsServer: vi.fn((_options: unknown, listener: RequestListener) => {
      requestListener = listener;
      return server;
    }),
    createMcpHandler: vi.fn(() => ({ fetch: () => Promise.resolve(new Response()) })),
    httpRequestHandler,
    loadApprovalHtml,
    serveStdio: vi.fn(() => ({ close: () => Promise.resolve() })),
    setAddress: (value: { port: number } | string | null) => {
      address = value;
    },
    setFailListen: (value: boolean) => {
      failListen = value;
    },
    setFailClose: (value: boolean) => {
      failClose = value;
    },
    dispatch: (incomingRequest: MockRequest, outgoingResponse: MockResponse) => {
      requestListener?.(incomingRequest, outgoingResponse);
    },
    reset: () => {
      requestListener = undefined;
      listenError = undefined;
      address = { port: 41234 };
      failListen = false;
      failClose = false;
      loadApprovalHtml.mockReset();
      loadApprovalHtml.mockImplementation(() => "<html>test</html>");
      httpRequestHandler.mockClear();
      server.closeAllConnections.mockClear();
      server.off.mockClear();
      mocks.createServer.mockClear();
      mocks.createHttpsServer.mockClear();
      mocks.createMcpHandler.mockClear();
      mocks.serveStdio.mockClear();
    },
  };
});

vi.mock("node:http", () => ({ createServer: mocks.createServer }));
vi.mock("node:https", () => ({ createServer: mocks.createHttpsServer }));
vi.mock("@modelcontextprotocol/node", () => ({
  localhostHostValidation: () => (incomingRequest: MockRequest, outgoingResponse: MockResponse) => {
    if (incomingRequest.headers.host === "untrusted.example") {
      outgoingResponse.writeHead(403).end();
      return false;
    }
    return true;
  },
  localhostOriginValidation:
    () => (incomingRequest: MockRequest, outgoingResponse: MockResponse) => {
      if (incomingRequest.headers.origin === "http://untrusted.example") {
        outgoingResponse.writeHead(403).end();
        return false;
      }
      return true;
    },
  toNodeHandler: () => mocks.httpRequestHandler,
}));
vi.mock("@modelcontextprotocol/server", async (importOriginal) => {
  const actual = await importOriginal<typeof McpServerModule>();
  return {
    ...actual,
    createMcpHandler: mocks.createMcpHandler,
    McpServer: class {
      server = {
        getClientCapabilities: () => undefined,
        registerCapabilities: (_capabilities: unknown) => undefined,
        setRequestHandler: (_method: string, _handler: unknown) => undefined,
      };
      registerTool(): void {
        this.server.registerCapabilities({});
      }
    },
  };
});
vi.mock("@modelcontextprotocol/server/stdio", () => ({ serveStdio: mocks.serveStdio }));
vi.mock("./resources/approval.js", () => ({
  loadApprovalHtml: mocks.loadApprovalHtml,
  registerApprovalResource: vi.fn(),
}));

import { startControlPlaneHttp, startControlPlaneStdio } from "./server.js";

function request(url: string, headers: Record<string, string | undefined> = {}): MockRequest {
  return {
    url,
    method: "POST",
    headers: { host: "127.0.0.1", authorization: AUTHORIZATION, ...headers },
    [Symbol.asyncIterator]: () => ({
      next: () => Promise.resolve({ done: true, value: undefined }),
    }),
  };
}

const HTTP_TOKEN = "CONTROL_PLANE_HTTP_TEST_TOKEN";
const AUTHORIZATION = ["Be", "arer ", HTTP_TOKEN].join("");

function httpOptions(options: ControlPlaneServerOptions = {}): ControlPlaneServerOptions {
  return {
    controlPlane: ControlPlaneConfigSchema.parse({
      auth: {
        tokens: [
          {
            id: "token.test",
            secret: "env:CONTROL_PLANE_TEST_TOKEN",
            scopes: ["admin"],
          },
        ],
      },
    }),
    secretResolver: { resolve: () => Promise.resolve({ reveal: () => HTTP_TOKEN }) },
    ...options,
  };
}

function response(): MockResponse {
  const result: MockResponse = {
    statusCode: 200,
    headersSent: false,
    writableEnded: false,
    body: undefined,
    writeHead(status) {
      result.statusCode = status;
      result.headersSent = true;
      return result;
    },
    end(body) {
      result.body = body;
      result.writableEnded = true;
      return result;
    },
  };
  return result;
}

describe("control-plane transports", () => {
  it("starts and closes stdio using the shared server factory", async () => {
    mocks.reset();
    const handle = startControlPlaneStdio(new InMemoryEventStore(), {
      approvalHtml: "<html>test</html>",
    });

    await handle.close();

    expect(mocks.serveStdio).toHaveBeenCalledOnce();
  });

  it("routes only the MCP endpoint and rejects untrusted Host and Origin values", async () => {
    mocks.reset();
    const handle = await startControlPlaneHttp(
      new InMemoryEventStore(),
      0,
      httpOptions({
        approvalHtml: "<html>test</html>",
      }),
    );

    const wrongPath = response();
    mocks.dispatch(request("/other"), wrongPath);
    expect(wrongPath.statusCode).toBe(404);

    const badHost = response();
    mocks.dispatch(request("/mcp", { host: "untrusted.example" }), badHost);
    expect(badHost.statusCode).toBe(403);

    const badOrigin = response();
    mocks.dispatch(request("/mcp", { origin: "http://untrusted.example" }), badOrigin);
    expect(badOrigin.statusCode).toBe(403);

    const unauthenticated = response();
    mocks.dispatch(request("/mcp", { authorization: undefined }), unauthenticated);
    expect(unauthenticated.statusCode).toBe(401);
    expect(unauthenticated.body).toBeUndefined();

    mocks.dispatch(
      request("/mcp?query=ignored", { host: "127.0.0.1", authorization: AUTHORIZATION }),
      response(),
    );
    expect(mocks.httpRequestHandler).toHaveBeenCalledOnce();
    await handle.close();
    expect(mocks.createMcpHandler).toHaveBeenCalledOnce();
    expect(mocks.createServer).toHaveBeenCalledOnce();
  });

  it("returns a code-only 500 when a store read rejects in the request handler", async () => {
    mocks.reset();
    const store = new InMemoryEventStore();
    const runId = Id.parse("00000000000000000000000000");
    vi.spyOn(store, "read").mockImplementation(async function* () {
      await Promise.reject(new Error("synthetic store failure"));
    });
    mocks.httpRequestHandler.mockImplementationOnce(async () => {
      await store.read(runId)[Symbol.asyncIterator]().next();
    });
    const handle = await startControlPlaneHttp(
      store,
      0,
      httpOptions({ approvalHtml: "<html>test</html>" }),
    );
    const outgoing = response();

    mocks.dispatch(request("/mcp"), outgoing);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(outgoing.statusCode).toBe(500);
    expect(outgoing.body).toBe("control_plane_request_failed");
    expect(outgoing.writableEnded).toBe(true);
    await handle.close();
  });

  it("fails closed for invalid ports, listen errors, and missing listener addresses", async () => {
    mocks.reset();
    await expect(startControlPlaneHttp(new InMemoryEventStore(), -1)).rejects.toThrow();
    expect(mocks.createServer).not.toHaveBeenCalled();

    mocks.setFailListen(true);
    await expect(
      startControlPlaneHttp(
        new InMemoryEventStore(),
        3000,
        httpOptions({ approvalHtml: "<html>test</html>" }),
      ),
    ).rejects.toMatchObject({
      code: "control_plane_listen_failed",
    });

    mocks.reset();
    mocks.setAddress(null);
    await expect(
      startControlPlaneHttp(
        new InMemoryEventStore(),
        3000,
        httpOptions({ approvalHtml: "<html>test</html>" }),
      ),
    ).rejects.toMatchObject({
      code: "control_plane_listen_failed",
    });
  });

  it("refuses a non-loopback HTTP bind without TLS before creating a listener", async () => {
    mocks.reset();
    const controlPlane = ControlPlaneConfigSchema.parse({
      auth: {
        tokens: [
          {
            id: "token.test",
            secret: "env:CONTROL_PLANE_TEST_TOKEN",
            scopes: ["admin"],
          },
        ],
      },
      listen: { host: "0.0.0.0", port: 3_000 },
    });

    await expect(
      startControlPlaneHttp(new InMemoryEventStore(), 3_000, httpOptions({ controlPlane })),
    ).rejects.toMatchObject({ code: "control_plane_remote_tls_required" });
    expect(mocks.createServer).not.toHaveBeenCalled();
  });

  it("serves configured remote binds through HTTPS", async () => {
    mocks.reset();
    const controlPlane = ControlPlaneConfigSchema.parse({
      auth: {
        tokens: [
          {
            id: "token.test",
            secret: "env:CONTROL_PLANE_TEST_TOKEN",
            scopes: ["admin"],
          },
        ],
      },
      listen: { host: "0.0.0.0", port: 3_000 },
      tls: { certFile: "file:/cert", keyFile: "file:/key" },
      allowedHosts: ["remote.example"],
    });
    const handle = await startControlPlaneHttp(
      new InMemoryEventStore(),
      0,
      httpOptions({ controlPlane }),
    );

    expect(handle.endpoint).toBe("https://0.0.0.0:41234/mcp");
    expect(mocks.createHttpsServer).toHaveBeenCalledOnce();
    await handle.close();
  });

  it("limits authenticated requests per token", async () => {
    mocks.reset();
    const controlPlane = ControlPlaneConfigSchema.parse({
      auth: {
        tokens: [
          {
            id: "token.test",
            secret: "env:CONTROL_PLANE_TEST_TOKEN",
            scopes: ["admin"],
          },
        ],
      },
      rateLimitPerMinute: 1,
    });
    const handle = await startControlPlaneHttp(
      new InMemoryEventStore(),
      0,
      httpOptions({ controlPlane, clock: { now: () => 1_000 } }),
    );
    const first = response();
    const limited = response();

    mocks.dispatch(request("/mcp"), first);
    mocks.dispatch(request("/mcp"), limited);

    expect(first.statusCode).toBe(200);
    expect(limited.statusCode).toBe(429);
    await handle.close();
  });

  it("rejects listener close failures with the closed code", async () => {
    mocks.reset();
    const handle = await startControlPlaneHttp(
      new InMemoryEventStore(),
      3000,
      httpOptions({ approvalHtml: "<html>test</html>" }),
    );
    mocks.setFailClose(true);

    await expect(handle.close()).rejects.toMatchObject({ code: "control_plane_listen_failed" });
    expect(mocks.createServer).toHaveBeenCalledOnce();
  });

  it("fails HTTP startup before listening when the approval build is missing", async () => {
    mocks.reset();
    mocks.loadApprovalHtml.mockImplementationOnce(() => {
      throw new MissingApprovalHtmlError();
    });

    await expect(
      startControlPlaneHttp(new InMemoryEventStore(), 0, httpOptions()),
    ).rejects.toMatchObject({
      code: "approval_resource_unavailable",
    });
    expect(mocks.createMcpHandler).not.toHaveBeenCalled();
    expect(mocks.createServer).not.toHaveBeenCalled();
  });
});
