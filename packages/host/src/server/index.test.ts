// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseJson } from "@harness/schemas";
import { z } from "zod";
import {
  createReferenceHost,
  REFERENCE_CSP,
  type ReferenceHostDependencies,
} from "./index.js";

const appConfig = {
  apps: [
    {
      id: "approval",
      resourceUri: "ui://approval/index.html",
      telemetry: true,
      allowedTools: ["approve"],
    },
  ],
  listen: { host: "127.0.0.1", port: 0 },
};
const sessionId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const resource = {
  contents: [{ mimeType: "text/html;profile=mcp-app", text: "<main>approved</main>" }],
};
const ResourceResponseSchema = z
  .object({ csp: z.string(), permissions: z.array(z.string()) })
  .passthrough();

type RequestListener = Parameters<
  NonNullable<ReferenceHostDependencies["createHttpServer"]>
>[0];
type HttpServer = ReturnType<NonNullable<ReferenceHostDependencies["createHttpServer"]>>;
type Request = Parameters<RequestListener>[0];
type Response = Parameters<RequestListener>[1];

interface FakeResponse {
  readonly response: Response;
  readonly read: () => { readonly status: number; readonly headers: Record<string, string>; readonly body: string };
}

function makeResponse(): FakeResponse {
  let status = 0;
  let headers: Record<string, string> = {};
  let body = "";
  return {
    response: {
      writeHead(code, responseHeaders) {
        status = code;
        headers = responseHeaders;
      },
      write(value) {
        body += value;
        return true;
      },
      end(value) {
        body += value?.toString() ?? "";
      },
    },
    read: () => ({ status, headers, body }),
  };
}

function makeServer(options: {
  readonly address?: { readonly port: number } | string | null;
  readonly listenError?: Error;
  readonly closeError?: Error;
  readonly readResource?: (uri: string) => Promise<unknown>;
  readonly onAppCall?: ReferenceHostDependencies["onAppCall"];
  readonly onCode?: ReferenceHostDependencies["onCode"];
  readonly readStatic?: ReferenceHostDependencies["readStatic"];
  readonly config?: unknown;
  readonly idGenerator?: () => string;
  readonly randomBytes?: (size: number) => Buffer;
  readonly now?: () => number;
} = {}) {
  let listener: RequestListener | undefined;
  let errorListener: ((error: Error) => void) | undefined;
  let hostArgument = "";
  let closed = false;
  const server: HttpServer = {
    once(event, callback) {
      if (event === "error") {
        errorListener = callback;
      }
      return this;
    },
    listen(_port, host, callback) {
      hostArgument = host;
      if (options.listenError !== undefined) {
        errorListener?.(options.listenError);
      } else {
        callback();
      }
      return this;
    },
    address: () => options.address === undefined ? { port: 43210 } : options.address,
    close(callback) {
      closed = true;
      callback(options.closeError);
      return this;
    },
  };
  const dependencies: ReferenceHostDependencies = {
    readResource: options.readResource ?? (async () => resource),
    ...(options.onAppCall === undefined ? {} : { onAppCall: options.onAppCall }),
    ...(options.onCode === undefined ? {} : { onCode: options.onCode }),
    ...(options.readStatic === undefined ? {} : { readStatic: options.readStatic }),
    ...(options.idGenerator === undefined ? {} : { idGenerator: options.idGenerator }),
    ...(options.randomBytes === undefined ? {} : { randomBytes: options.randomBytes }),
    ...(options.now === undefined ? {} : { now: options.now }),
    createHttpServer: (requestListener) => {
      listener = requestListener;
      return server;
    },
  };
  const hostPromise = createReferenceHost(options.config ?? appConfig, dependencies);
  return {
    hostPromise,
    get hostArgument() {
      return hostArgument;
    },
    get closed() {
      return closed;
    },
    request: async (
      method: string,
      url: string,
      headers: Request["headers"] = {},
      body?: string,
    ) => {
      if (listener === undefined) {
        throw new Error("Server listener was not initialized.");
      }
      const response = makeResponse();
      const request: Request = {
        method,
        url,
        headers,
        async *[Symbol.asyncIterator]() {
          if (body !== undefined) {
            yield Buffer.from(body);
          }
        },
      };
      await listener(request, response.response);
      return response.read();
    },
  };
}

function authorization(host: { readonly token: string; readonly origin: string }) {
  return { authorization: ["Bearer", host.token].join(" "), origin: host.origin };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createReferenceHost", () => {
  it("binds loopback, creates a ULID session, and returns a host-only launch URL", async () => {
    const fixture = makeServer({
      idGenerator: () => sessionId,
      randomBytes: (size) => Buffer.alloc(size, 3),
    });
    const host = await fixture.hostPromise;
    expect(fixture.hostArgument).toBe("127.0.0.1");
    expect(host.origin).toBe("http://127.0.0.1:43210");
    expect(host.url).toContain("#token=");
    expect(host.url).toContain("resourceUri=ui%3A%2F%2Fapproval%2Findex.html");
    expect(host.token).toHaveLength(43);
    const event = await fixture.request(
      "GET",
      "/api/events?resourceUri=ui%3A%2F%2Fapproval%2Findex.html",
      authorization(host),
    );
    expect(event.status).toBe(200);
    expect(event.headers["content-type"]).toContain("text/event-stream");
    expect(event.body).toContain(sessionId);
    await host.close();
    expect(fixture.closed).toBe(true);
  });

  it("generates a ULID from injected time and entropy", async () => {
    const fixture = makeServer({
      randomBytes: (size) => Buffer.alloc(size, 1),
      now: () => 1_700_000_000_000,
    });
    const host = await fixture.hostPromise;
    const response = await fixture.request(
      "GET",
      "/api/events?resourceUri=ui%3A%2F%2Fapproval%2Findex.html",
      authorization(host),
    );
    expect(response.status).toBe(200);
    expect(response.body).toMatch(/[0-9A-HJKMNP-TV-Z]{26}/u);
    await host.close();
  });

  it("requires both the bearer token and same-origin request on protected routes", async () => {
    const fixture = makeServer({ idGenerator: () => sessionId });
    const host = await fixture.hostPromise;
    const path = "/api/app?resourceUri=ui%3A%2F%2Fapproval%2Findex.html";
    expect((await fixture.request("GET", path, { origin: host.origin })).status).toBe(403);
    expect(
      (
        await fixture.request("GET", path, {
          authorization: ["Bearer", "x".repeat(host.token.length)].join(" "),
          origin: "http://foreign.example.test",
        })
      ).status,
    ).toBe(403);
    expect((await fixture.request("GET", path, authorization(host))).status).toBe(200);
    await host.close();
  });

  it("refuses unknown resources and unknown paths with code-only errors", async () => {
    const reader = vi.fn(async () => resource);
    const fixture = makeServer({ readResource: reader, idGenerator: () => sessionId });
    const host = await fixture.hostPromise;
    const unknown = await fixture.request(
      "GET",
      "/api/app?resourceUri=ui%3A%2F%2Funknown",
      authorization(host),
    );
    expect(unknown.status).toBe(404);
    expect(unknown.body).toBe('{"error":"app_unknown"}');
    expect(reader).not.toHaveBeenCalled();
    expect((await fixture.request("GET", "/other")).status).toBe(404);
    await host.close();
  });

  it("validates resource MIME and size and hides resource-reader errors", async () => {
    const invalid = makeServer({
      readResource: async () => ({ contents: [{ mimeType: "text/plain", text: "no" }] }),
      idGenerator: () => sessionId,
    });
    const invalidHost = await invalid.hostPromise;
    const invalidResponse = await invalid.request(
      "GET",
      "/api/app?resourceUri=ui%3A%2F%2Fapproval%2Findex.html",
      authorization(invalidHost),
    );
    expect(invalidResponse.status).toBe(422);
    await invalidHost.close();

    const oversized = makeServer({
      readResource: async () => ({
        contents: [{ mimeType: "text/html;profile=mcp-app", text: "x".repeat(1_048_577) }],
      }),
      idGenerator: () => sessionId,
    });
    const oversizedHost = await oversized.hostPromise;
    expect(
      (
        await oversized.request(
          "GET",
          "/api/app?resourceUri=ui%3A%2F%2Fapproval%2Findex.html",
          authorization(oversizedHost),
        )
      ).status,
    ).toBe(422);
    await oversizedHost.close();

    const failed = makeServer({
      readResource: async () => {
        throw new Error("sensitive reader detail");
      },
      idGenerator: () => sessionId,
    });
    const failedHost = await failed.hostPromise;
    const failureResponse = await failed.request(
      "GET",
      "/api/app?resourceUri=ui%3A%2F%2Fapproval%2Findex.html",
      authorization(failedHost),
    );
    expect(failureResponse.status).toBe(502);
    expect(failureResponse.body).not.toContain("sensitive reader detail");
    await failedHost.close();
  });

  it("filters CSP and permission requests against their allowlists", async () => {
    const onCode = vi.fn();
    const fixture = makeServer({
      config: {
        ...appConfig,
        permissionAllowlist: ["camera", "clipboardWrite"],
        cspAllowlist: ["https://allowed.example.test"],
      },
      onCode,
      idGenerator: () => sessionId,
      readResource: async () => ({
        contents: [
          {
            mimeType: "text/html;profile=mcp-app",
            text: "<main>safe</main>",
            _meta: {
              ui: {
                permissions: { camera: {}, microphone: {}, clipboardWrite: {} },
                csp: {
                  connectDomains: ["https://allowed.example.test", "https://blocked.example.test"],
                  resourceDomains: ["javascript:bad"],
                  frameDomains: ["https://blocked.example.test"],
                },
              },
            },
          },
        ],
      }),
    });
    const host = await fixture.hostPromise;
    const result = await fixture.request(
      "GET",
      "/api/app?resourceUri=ui%3A%2F%2Fapproval%2Findex.html",
      authorization(host),
    );
    expect(result.status).toBe(200);
    const payload = parseJson(ResourceResponseSchema, result.body);
    expect(payload.permissions).toEqual(["camera", "clipboard-write"]);
    expect(payload.csp).toContain("connect-src https://allowed.example.test");
    expect(payload.csp).not.toContain("blocked.example.test");
    expect(payload.csp).not.toContain("javascript:");
    expect(onCode).toHaveBeenCalledWith("app_csp_request_ignored");
    await host.close();
  });

  it("retains the deny-all CSP when there are no resource requests", async () => {
    const fixture = makeServer({
      idGenerator: () => sessionId,
      readResource: async () => ({
        contents: [
          { mimeType: "text/html;profile=mcp-app", text: "<main>safe</main>", _meta: { ui: {} } },
        ],
      }),
    });
    const host = await fixture.hostPromise;
    const result = await fixture.request(
      "GET",
      "/api/app?resourceUri=ui%3A%2F%2Fapproval%2Findex.html",
      authorization(host),
    );
    expect(parseJson(ResourceResponseSchema, result.body).csp).toBe(REFERENCE_CSP);
    await host.close();
  });

  it("serves the static host page and bundle without exposing token-protected data", async () => {
    const readStatic = vi.fn(async (asset: "index" | "bundle") => Buffer.from(asset));
    const fixture = makeServer({ readStatic, idGenerator: () => sessionId });
    const host = await fixture.hostPromise;
    expect((await fixture.request("GET", "/")).body).toBe("index");
    expect((await fixture.request("GET", "/host.js")).body).toBe("bundle");
    expect(readStatic).toHaveBeenNthCalledWith(1, "index");
    expect(readStatic).toHaveBeenNthCalledWith(2, "bundle");
    const unavailable = makeServer({
      readStatic: async () => {
        throw new Error("private file path");
      },
      idGenerator: () => sessionId,
    });
    const failedIndex = await unavailable.request("GET", "/");
    expect(failedIndex.status).toBe(503);
    const failedBundle = await unavailable.request("GET", "/host.js");
    expect(failedBundle.status).toBe(503);
    await host.close();
    const unavailableHost = await unavailable.hostPromise;
    await unavailableHost.close();
  });

  it("validates app calls against the active host session before routing", async () => {
    const onAppCall = vi.fn(async () => ({ content: [{ type: "text" as const, text: "ok" }] }));
    const fixture = makeServer({ idGenerator: () => sessionId, onAppCall });
    const host = await fixture.hostPromise;
    const headers = authorization(host);
    const body = JSON.stringify({
      appId: "approval",
      sessionId,
      toolName: "approve",
      arguments: { decision: "yes" },
    });
    const result = await fixture.request("POST", "/api/call", headers, body);
    expect(result.status).toBe(200);
    expect(onAppCall).toHaveBeenCalledWith({
      appId: "approval",
      sessionId,
      toolName: "approve",
      arguments: { decision: "yes" },
    });
    const invalid = await fixture.request("POST", "/api/call", headers, "{");
    expect(invalid.status).toBe(400);
    const mismatched = await fixture.request(
      "POST",
      "/api/call",
      headers,
      body.replace(sessionId, "01ARZ3NDEKTSV4RRFFQ69G5FAW"),
    );
    expect(mismatched.status).toBe(404);
    const large = await fixture.request("POST", "/api/call", headers, "x".repeat(16_385));
    expect(large.status).toBe(413);
    await host.close();
  });

  it("returns a bounded error result if app calls are not handled or fail", async () => {
    const body = JSON.stringify({
      appId: "approval",
      sessionId,
      toolName: "approve",
      arguments: {},
    });
    const noHandler = makeServer({ idGenerator: () => sessionId });
    const noHandlerHost = await noHandler.hostPromise;
    const noHandlerResult = await noHandler.request(
      "POST",
      "/api/call",
      authorization(noHandlerHost),
      body,
    );
    expect(JSON.parse(noHandlerResult.body)).toEqual({ content: [], isError: true });
    await noHandlerHost.close();
    const failing = makeServer({
      idGenerator: () => sessionId,
      onAppCall: async () => {
        throw new Error("sensitive tool error");
      },
    });
    const failingHost = await failing.hostPromise;
    const failure = await failing.request(
      "POST",
      "/api/call",
      authorization(failingHost),
      body,
    );
    expect(failure.body).toBe('{"content":[],"isError":true}');
    await failingHost.close();
  });

  it("rejects non-loopback configuration and invalid session identifiers", async () => {
    await expect(createReferenceHost(
      { ...appConfig, listen: { host: "0.0.0.0", port: 8080 } },
      { readResource: async () => resource },
    )).rejects.toThrow();
    await expect(createReferenceHost(appConfig, {
      readResource: async () => resource,
      idGenerator: () => "invalid",
      createHttpServer: () => {
        throw new Error("server should not start");
      },
    })).rejects.toThrow();
  });

  it("handles listen failure, invalid bound addresses, and close errors", async () => {
    const listenFailure = makeServer({ listenError: new Error("private listen detail") });
    await expect(listenFailure.hostPromise).rejects.toThrow("private listen detail");

    const invalidAddress = makeServer({ address: null });
    await expect(invalidAddress.hostPromise).rejects.toThrow();
    expect(invalidAddress.closed).toBe(true);

    const badClose = makeServer({ idGenerator: () => sessionId, closeError: new Error("close") });
    const host = await badClose.hostPromise;
    await expect(host.close()).rejects.toThrow("close");
  });
});
