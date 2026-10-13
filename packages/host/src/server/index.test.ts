// SPDX-License-Identifier: Apache-2.0
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { trace } from "@opentelemetry/api";
import { CallToolResultSchema, ListToolsResultSchema } from "@modelcontextprotocol/core";
import { Code, parseJson, Traceparent } from "@harness/schemas";
import { createTestSpanCollector } from "@harness/telemetry/testing";
import type { PolicyPort, ToolPort } from "@harness/core";
import { z } from "zod";
import {
  APP_TELEMETRY_TOOL_NAME,
  createReferenceHost,
  ReferenceHostError,
  REFERENCE_CSP,
  type ReferenceHostDependencies,
} from "./index.js";

const appResourceUri = "ui://approval/index.html";
const spanCollector = createTestSpanCollector();
trace.setGlobalTracerProvider(spanCollector.provider);
afterAll(async () => {
  await spanCollector.provider.shutdown();
});
const appConfig = {
  apps: [
    {
      id: "approval",
      resourceUri: appResourceUri,
      telemetry: true,
      allowedTools: ["approve"],
    },
  ],
  listen: { host: "127.0.0.1", port: 0 },
};
const sessionId = "00000000000000000000000000";
const foreignRunId = "00000000000000000000000001";
const resource = {
  contents: [{ mimeType: "text/html;profile=mcp-app", text: "<main>approved</main>" }],
};
const ResourceResponseSchema = z
  .object({ csp: z.string(), permissions: z.array(z.string()) })
  .loose();
const AppResourceResponseSchema = z
  .object({
    sessionId: z.string(),
    telemetry: z.boolean(),
    traceparent: Traceparent.optional(),
  })
  .loose();

type RequestListener = Parameters<NonNullable<ReferenceHostDependencies["createHttpServer"]>>[0];
type HttpServer = ReturnType<NonNullable<ReferenceHostDependencies["createHttpServer"]>>;
type Request = Parameters<RequestListener>[0];
type Response = Parameters<RequestListener>[1];

const eventsPath = `/api/events?resourceUri=${encodeURIComponent(appResourceUri)}`;
const AppReadySchema = z.object({ appId: z.string(), sessionId: z.string() }).strict();

interface FakeResponse {
  readonly response: Response;
  readonly read: () => {
    readonly status: number;
    readonly headers: Record<string, string>;
    readonly body: string;
  };
}

function makeResponse(): FakeResponse {
  let status = 0;
  let headers: Record<string, string> = {};
  let body = "";
  const destroy = vi.fn();
  return {
    response: {
      get headersSent() {
        return status !== 0;
      },
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
      destroy,
    },
    read: () => ({ status, headers, body }),
  };
}

function makeServer(
  options: {
    readonly address?: { readonly port: number } | string | null;
    readonly listenError?: Error;
    readonly closeError?: Error;
    readonly readResource?: (uri: string) => Promise<unknown>;
    readonly onAppCall?: ReferenceHostDependencies["onAppCall"];
    readonly onTelemetryEmit?: ReferenceHostDependencies["onTelemetryEmit"];
    readonly onAppToolsList?: ReferenceHostDependencies["onAppToolsList"];
    readonly isIdOwnedByRun?: ReferenceHostDependencies["isIdOwnedByRun"];
    readonly onAppRejected?: ReferenceHostDependencies["onAppRejected"];
    readonly onCode?: ReferenceHostDependencies["onCode"];
    readonly readStatic?: ReferenceHostDependencies["readStatic"];
    readonly config?: unknown;
    readonly idGenerator?: () => string;
    readonly randomBytes?: (size: number) => Buffer;
    readonly now?: () => number;
    readonly maxAppTelemetryBatchesPerMinute?: number;
    readonly runId?: ReferenceHostDependencies["runId"];
    readonly policy?: ReferenceHostDependencies["policy"];
    readonly tool?: ReferenceHostDependencies["tool"];
    readonly scheduleUiSessionExpiry?: ReferenceHostDependencies["scheduleUiSessionExpiry"];
    readonly uiSessionContext?: ReferenceHostDependencies["uiSessionContext"];
  } = {},
) {
  let listener: RequestListener | undefined;
  let errorListener: ((error: Error) => void) | undefined;
  let hostArgument = "";
  let closed = false;
  const server: HttpServer = {
    once(event, callback) {
      errorListener = callback;
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
    address: () => (options.address === undefined ? { port: 43210 } : options.address),
    close(callback) {
      closed = true;
      callback(options.closeError);
      return this;
    },
  };
  const dependencies: ReferenceHostDependencies = {
    readResource: options.readResource ?? (() => Promise.resolve(resource)),
    onCode: options.onCode ?? (() => undefined),
    ...(options.onAppCall === undefined ? {} : { onAppCall: options.onAppCall }),
    ...(options.onTelemetryEmit === undefined ? {} : { onTelemetryEmit: options.onTelemetryEmit }),
    ...(options.onAppToolsList === undefined ? {} : { onAppToolsList: options.onAppToolsList }),
    ...(options.isIdOwnedByRun === undefined ? {} : { isIdOwnedByRun: options.isIdOwnedByRun }),
    ...(options.onAppRejected === undefined ? {} : { onAppRejected: options.onAppRejected }),
    ...(options.onCode === undefined ? {} : { onCode: options.onCode }),
    ...(options.readStatic === undefined ? {} : { readStatic: options.readStatic }),
    ...(options.idGenerator === undefined ? {} : { idGenerator: options.idGenerator }),
    ...(options.randomBytes === undefined ? {} : { randomBytes: options.randomBytes }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.maxAppTelemetryBatchesPerMinute === undefined
      ? {}
      : { maxAppTelemetryBatchesPerMinute: options.maxAppTelemetryBatchesPerMinute }),
    runId: options.runId ?? sessionId,
    ...(options.policy === undefined ? {} : { policy: options.policy }),
    ...(options.tool === undefined ? {} : { tool: options.tool }),
    ...(options.scheduleUiSessionExpiry === undefined
      ? {}
      : { scheduleUiSessionExpiry: options.scheduleUiSessionExpiry }),
    ...(options.uiSessionContext === undefined
      ? {}
      : { uiSessionContext: options.uiSessionContext }),
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
        headers: { host: "127.0.0.1:43210", ...headers },
        async *[Symbol.asyncIterator]() {
          if (body !== undefined) {
            yield await Promise.resolve(Buffer.from(body));
          }
        },
      };
      await listener(request, response.response);
      return response.read();
    },
  };
}

async function newAppSession(
  fixture: ReturnType<typeof makeServer>,
  host: { readonly token: string; readonly origin: string },
): Promise<string> {
  const event = await fixture.request("GET", eventsPath, authorization(host));
  const launchEvent = event.body.split("\n").find((line) => line.startsWith("data: "));
  if (launchEvent === undefined) {
    throw new Error("Host launch event is missing.");
  }
  return parseJson(AppReadySchema, launchEvent.slice("data: ".length)).sessionId;
}

function appPath(appSession: string): string {
  return `/api/app?resourceUri=${encodeURIComponent(appResourceUri)}&sessionId=${encodeURIComponent(appSession)}`;
}

function authorization(host: { readonly token: string; readonly origin: string }) {
  return { authorization: ["Bearer", host.token].join(" "), origin: host.origin };
}

function telemetryCallBody(appSession: string, batch: unknown): string {
  return JSON.stringify({
    appId: "approval",
    sessionId: appSession,
    toolName: APP_TELEMETRY_TOOL_NAME,
    arguments: batch,
  });
}

function expectTelemetryAck(
  response: { readonly status: number; readonly body: string },
  accepted: number,
  dropped: number,
): void {
  expect(response.status).toBe(200);
  expect(parseJson(CallToolResultSchema, response.body).content).toEqual([
    { type: "text", text: JSON.stringify({ accepted, dropped }) },
  ]);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createReferenceHost", () => {
  it("serves authenticated resources through the Node HTTP adapter", async () => {
    const host = await createReferenceHost(appConfig, {
      readStatic: (asset) =>
        Promise.resolve(Buffer.from(asset === "index" ? "<!doctype html>" : "void 0;")),
      readResource: () => Promise.resolve(resource),
      onCode: () => undefined,
      onAppCall: () =>
        Promise.resolve(CallToolResultSchema.parse({ content: [{ type: "text", text: "ok" }] })),
      idGenerator: () => sessionId,
      runId: sessionId,
    });

    try {
      const page = await fetch(host.origin);
      expect(page.status).toBe(200);
      expect(page.headers.get("content-type")).toContain("text/html");
      expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
      expect(page.headers.get("x-frame-options")).toBe("DENY");
      expect(page.headers.get("referrer-policy")).toBe("no-referrer");

      const bundle = await fetch(new URL("/host.js", host.origin));
      expect(bundle.headers.get("content-security-policy")).toContain("frame-src 'self'");
      expect(bundle.headers.get("x-frame-options")).toBe("DENY");
      expect(bundle.headers.get("referrer-policy")).toBe("no-referrer");

      const eventResponse = await fetch(new URL(eventsPath, host.origin), {
        headers: { authorization: ["Bearer", host.token].join(" "), origin: host.origin },
      });
      const eventData = (await eventResponse.text())
        .split("\n")
        .find((line) => line.startsWith("data: "));
      if (eventData === undefined) {
        throw new Error("Host launch event is missing.");
      }
      const launchedSessionId = parseJson(
        AppReadySchema,
        eventData.slice("data: ".length),
      ).sessionId;

      const appResponse = await fetch(new URL(appPath(launchedSessionId), host.origin), {
        headers: {
          authorization: ["Bearer", host.token].join(" "),
          origin: host.origin,
        },
      });
      expect(appResponse.status).toBe(200);

      const callResponse = await fetch(new URL("/api/call", host.origin), {
        method: "POST",
        headers: {
          authorization: ["Bearer", host.token].join(" "),
          origin: host.origin,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          appId: "approval",
          sessionId: launchedSessionId,
          toolName: "approve",
          arguments: {},
        }),
      });
      expect(callResponse.status).toBe(200);
      expect(await callResponse.json()).toEqual({
        content: [{ type: "text", text: "ok" }],
      });
    } finally {
      await host.close();
    }
  });

  it("routes app telemetry locally, enforces policy context, filters discovery, and rejects cross-run ids", async () => {
    const onAppCall = vi.fn(() =>
      Promise.resolve(CallToolResultSchema.parse({ content: [{ type: "text", text: "ok" }] })),
    );
    const onTelemetryEmit = vi.fn(() =>
      Promise.resolve(
        CallToolResultSchema.parse({ content: [{ type: "text", text: "accepted" }] }),
      ),
    );
    const onAppToolsList = vi.fn(() =>
      Promise.resolve(
        ListToolsResultSchema.parse({
          tools: [
            { name: "approve", description: "allowed", inputSchema: { type: "object" } },
            {
              name: "filesystem.write",
              description: "not allowed",
              inputSchema: { type: "object" },
            },
          ],
        }),
      ),
    );
    const onAppRejected = vi.fn();
    const foreignId = "00000000000000000000000006";
    const fixture = makeServer({
      onAppCall,
      onTelemetryEmit,
      onAppToolsList,
      onAppRejected,
      isIdOwnedByRun: (_owner, id) => id !== foreignId,
      idGenerator: () => sessionId,
    });
    const host = await fixture.hostPromise;
    const launchedSessionId = await newAppSession(fixture, host);
    const auth = authorization(host);
    const local = await fixture.request(
      "POST",
      "/api/call",
      auth,
      JSON.stringify({
        appId: "approval",
        sessionId: launchedSessionId,
        toolName: APP_TELEMETRY_TOOL_NAME,
        arguments: { spans: [{ name: "ui.render" }] },
      }),
    );
    expect(local.status).toBe(200);
    expect(onTelemetryEmit).toHaveBeenCalledOnce();
    expect(onAppCall).not.toHaveBeenCalled();

    const forwarded = await fixture.request(
      "POST",
      "/api/call",
      auth,
      JSON.stringify({
        appId: "approval",
        sessionId: launchedSessionId,
        toolName: "approve",
        arguments: {},
      }),
    );
    expect(forwarded.status).toBe(200);
    expect(onAppCall).toHaveBeenCalledWith(expect.objectContaining({ toolName: "approve" }), {
      runId: sessionId,
      policyContext: { subagent: false, app: "approval" },
    });

    const discovered = await fixture.request(
      "GET",
      `/api/tools?sessionId=${encodeURIComponent(launchedSessionId)}`,
      auth,
    );
    const tools = parseJson(ListToolsResultSchema, discovered.body).tools;
    expect(tools.map(({ name }) => name)).toEqual(["approve", APP_TELEMETRY_TOOL_NAME]);
    expect(tools[1]?._meta).toEqual({ ui: { visibility: ["app"] } });

    const crossRun = await fixture.request(
      "POST",
      "/api/call",
      auth,
      JSON.stringify({
        appId: "approval",
        sessionId: launchedSessionId,
        callId: foreignId,
        toolName: "approve",
        arguments: {},
      }),
    );
    expect(crossRun.status).toBe(409);
    expect(crossRun.body).toBe('{"error":"app_run_mismatch"}');

    const embeddedApprovalId = await fixture.request(
      "POST",
      "/api/call",
      auth,
      JSON.stringify({
        appId: "approval",
        sessionId: launchedSessionId,
        toolName: "approve",
        arguments: { approvalId: foreignId },
      }),
    );
    expect(embeddedApprovalId.status).toBe(409);
    expect(embeddedApprovalId.body).toBe('{"error":"app_run_mismatch"}');

    const embeddedRunId = await fixture.request(
      "POST",
      "/api/call",
      auth,
      JSON.stringify({
        appId: "approval",
        sessionId: launchedSessionId,
        toolName: "approve",
        arguments: { runId: foreignRunId },
      }),
    );
    expect(embeddedRunId.status).toBe(409);
    expect(embeddedRunId.body).toBe('{"error":"app_run_mismatch"}');

    const disallowed = await fixture.request(
      "POST",
      "/api/call",
      auth,
      JSON.stringify({
        appId: "approval",
        sessionId: launchedSessionId,
        toolName: "filesystem.write",
        arguments: {},
      }),
    );
    expect(disallowed.status).toBe(403);
    expect(disallowed.body).toBe('{"error":"app_tool_not_allowed"}');
    expect(onAppRejected).toHaveBeenCalledWith("unknown_tool");
    await host.close();
  });

  it("sends anti-framing headers on JSON error responses", async () => {
    const host = await createReferenceHost(appConfig, {
      readStatic: () => Promise.reject(new Error("asset missing")),
      readResource: () => Promise.resolve(resource),
      onCode: () => undefined,
      idGenerator: () => sessionId,
    });
    try {
      const bundle = await fetch(new URL("/host.js", host.origin));
      expect(bundle.status).toBe(503);
      expect(bundle.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
      expect(bundle.headers.get("x-frame-options")).toBe("DENY");
      expect(bundle.headers.get("referrer-policy")).toBe("no-referrer");
    } finally {
      await host.close();
    }
  });

  it("binds loopback, creates a ULID session, and returns a host-only launch URL", async () => {
    const fixture = makeServer({
      idGenerator: () => sessionId,
      randomBytes: (size) => Buffer.alloc(size, 3),
    });
    const host = await fixture.hostPromise;
    expect(fixture.hostArgument).toBe("127.0.0.1");
    expect(host.origin).toBe("http://127.0.0.1:43210");
    expect(host.url).toContain("#token=");
    expect(new URL(host.url).hash).toContain(encodeURIComponent(appResourceUri));
    expect(host.token).toHaveLength(43);
    const event = await fixture.request("GET", eventsPath, authorization(host));
    expect(event.status).toBe(200);
    expect(event.headers["content-type"]).toContain("text/event-stream");
    expect(event.body).toContain(sessionId);
    await host.close();
    expect(fixture.closed).toBe(true);
  });

  it("creates a distinct ULID session for each launched app instance", async () => {
    let next = 0;
    const fixture = makeServer({
      idGenerator: () => String(next++).padStart(26, "0"),
    });
    const host = await fixture.hostPromise;
    const firstSession = await newAppSession(fixture, host);
    const secondSession = await newAppSession(fixture, host);
    expect(firstSession).not.toBe(secondSession);
    const first = await fixture.request("GET", appPath(firstSession), authorization(host));
    const second = await fixture.request("GET", appPath(secondSession), authorization(host));
    expect(parseJson(AppResourceResponseSchema, first.body).sessionId).toBe(firstSession);
    expect(parseJson(AppResourceResponseSchema, second.body).sessionId).toBe(secondSession);
    await host.close();
  });

  it("expires and removes abandoned sessions after the configured lifetime", async () => {
    let expire: (() => void) | undefined;
    const scheduleUiSessionExpiry = vi.fn((callback: () => void) => {
      expire = callback;
      return vi.fn();
    });
    const onCode = vi.fn();
    const parent = spanCollector.provider.getTracer("host-test").startSpan("harness.tool_call");
    const fixture = makeServer({
      config: { ...appConfig, uiSessionMaxMs: 60_000 },
      idGenerator: () => sessionId,
      onCode,
      scheduleUiSessionExpiry,
      uiSessionContext: {
        runId: sessionId,
        toolCallSpanContext: parent.spanContext(),
      },
    });
    const host = await fixture.hostPromise;

    expect(await newAppSession(fixture, host)).toBe(sessionId);
    expect(scheduleUiSessionExpiry).toHaveBeenCalledWith(expect.any(Function), 60_000);
    parent.end();
    expire?.();
    expect(onCode).toHaveBeenCalledWith("ui_session_expired");
    expect(
      spanCollector
        .getFinishedSpans()
        .some(
          (span) =>
            span.name === "harness.ui_session" &&
            span.attributes["harness.ui.session_id"] === sessionId,
        ),
    ).toBe(true);
    expect((await fixture.request("GET", appPath(sessionId), authorization(host))).status).toBe(
      404,
    );
    await host.close();
  });

  it("rejects launches after the configured active-session limit", async () => {
    let nextId = 0;
    const fixture = makeServer({
      config: { ...appConfig, maxUiSessions: 1 },
      idGenerator: () => String(nextId++).padStart(26, "0"),
    });
    const host = await fixture.hostPromise;

    expect(await newAppSession(fixture, host)).toBe("00000000000000000000000000");
    const rejected = await fixture.request("GET", eventsPath, authorization(host));
    expect(rejected.status).toBe(429);
    expect(rejected.body).toBe('{"error":"app_session_limit"}');
    expect((await fixture.request("GET", appPath(sessionId), authorization(host))).status).toBe(
      200,
    );
    await host.close();
  });

  it("reports unavailable trace context and omits traceparent from the app payload", async () => {
    const onCode = vi.fn();
    const fixture = makeServer({ onCode, idGenerator: () => sessionId });
    const host = await fixture.hostPromise;
    const launchedSessionId = await newAppSession(fixture, host);
    const result = await fixture.request("GET", appPath(launchedSessionId), authorization(host));
    const payload = parseJson(AppResourceResponseSchema, result.body);

    expect(payload.telemetry).toBe(true);
    expect(payload.traceparent).toBeUndefined();
    expect(onCode).toHaveBeenCalledWith("ui_trace_unavailable");
    await host.close();
  });

  it("generates a ULID from injected time and entropy", async () => {
    const fixture = makeServer({
      randomBytes: (size) => Buffer.alloc(size, 1),
      now: () => 1_700_000_000_000,
    });
    const host = await fixture.hostPromise;
    const response = await fixture.request("GET", eventsPath, authorization(host));
    expect(response.status).toBe(200);
    expect(response.body).toMatch(/[0-9A-HJKMNP-TV-Z]{26}/u);
    await host.close();
  });

  it("reuses the bearer token for every host instance in the process", async () => {
    const first = makeServer({ idGenerator: () => sessionId });
    const firstHost = await first.hostPromise;
    const second = makeServer({ idGenerator: () => sessionId });
    const secondHost = await second.hostPromise;
    expect(secondHost.token).toBe(firstHost.token);
    await firstHost.close();
    await secondHost.close();
  });

  it("uses the UI-session run when a conflicting fallback run id is supplied", async () => {
    const onAppCall = vi.fn(() =>
      Promise.resolve(CallToolResultSchema.parse({ content: [{ type: "text", text: "ok" }] })),
    );
    const parent = spanCollector.provider.getTracer("host-test").startSpan("harness.tool_call");
    const fixture = makeServer({
      onAppCall,
      runId: foreignRunId,
      uiSessionContext: { runId: sessionId, toolCallSpanContext: parent.spanContext() },
      idGenerator: () => sessionId,
    });
    const host = await fixture.hostPromise;
    const launchedSessionId = await newAppSession(fixture, host);

    const response = await fixture.request(
      "POST",
      "/api/call",
      authorization(host),
      JSON.stringify({
        appId: "approval",
        sessionId: launchedSessionId,
        toolName: "approve",
        arguments: {},
      }),
    );

    expect(response.status).toBe(200);
    expect(onAppCall).toHaveBeenCalledWith(expect.anything(), {
      runId: sessionId,
      policyContext: { subagent: false, app: "approval" },
    });
    parent.end();
    await host.close();
  });

  it("uses the policy-checked handler by default when policy and tool ports are supplied", async () => {
    const decide = vi.fn(() => ({
      decision: "allow" as const,
      ruleId: Code.parse("allow_app"),
      reason: Code.parse("app_allowed"),
      editable: [],
    }));
    const policy: PolicyPort = {
      version: Code.parse("test.policy"),
      decide,
    };
    const execute = vi.fn(() =>
      Promise.resolve({ outcome: "ok" as const, result: { completed: true } }),
    );
    const tool: ToolPort = {
      prepare: vi.fn((call) => Promise.resolve({ ...call, args: { prepared: true } })),
      describe: (toolId) =>
        toolId === "approve" ? { idempotent: false, timeoutMs: 1_000 } : undefined,
      execute,
    };
    const fixture = makeServer({ policy, tool, idGenerator: () => sessionId });
    const host = await fixture.hostPromise;
    const launchedSessionId = await newAppSession(fixture, host);
    const response = await fixture.request(
      "POST",
      "/api/call",
      authorization(host),
      JSON.stringify({
        appId: "approval",
        sessionId: launchedSessionId,
        toolName: "approve",
        arguments: { raw: "synthetic value" },
      }),
    );

    expect(response.status).toBe(200);
    expect(decide).toHaveBeenCalledWith(
      { toolId: "approve", args: { prepared: true } },
      { subagent: false, app: "approval" },
    );
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ args: { prepared: true } }),
      expect.objectContaining({ runId: sessionId }),
    );
    expect(parseJson(CallToolResultSchema, response.body)).toEqual({
      content: [{ type: "text", text: '{"completed":true}' }],
    });
    await host.close();
  });

  it("validates app telemetry through the default host handler", async () => {
    const onAppRejected = vi.fn();
    const spanStart = spanCollector.getFinishedSpans().length;
    const fixture = makeServer({ onAppRejected, idGenerator: () => sessionId });
    const host = await fixture.hostPromise;
    const launchedSessionId = await newAppSession(fixture, host);
    const response = await fixture.request(
      "POST",
      "/api/call",
      authorization(host),
      JSON.stringify({
        appId: "approval",
        sessionId: launchedSessionId,
        toolName: APP_TELEMETRY_TOOL_NAME,
        arguments: {
          spans: [
            { name: "ui.render", startOffsetMs: 0, durationMs: 1 },
            { name: "ui.render", startOffsetMs: "INVALID-CANARY", durationMs: 1 },
          ],
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(parseJson(CallToolResultSchema, response.body)).toEqual({
      content: [{ type: "text", text: '{"accepted":1,"dropped":1}' }],
    });
    expect(onAppRejected).toHaveBeenCalledWith("schema");
    const exported = JSON.stringify(
      spanCollector
        .getFinishedSpans()
        .slice(spanStart)
        .map(({ name, attributes }) => ({ name, attributes })),
    );
    expect(exported).not.toContain("INVALID-CANARY");
    expect(
      spanCollector
        .getFinishedSpans()
        .slice(spanStart)
        .map(({ name }) => name),
    ).toContain("harness.ui.render");
    await host.close();
  });

  it("requires both the bearer token and same-origin request on protected routes", async () => {
    const fixture = makeServer({ idGenerator: () => sessionId });
    const host = await fixture.hostPromise;
    const path = appPath(await newAppSession(fixture, host));
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

  it("rejects a foreign Host header on every route", async () => {
    const fixture = makeServer({
      readStatic: () => Promise.resolve(Buffer.from("index")),
    });
    const host = await fixture.hostPromise;
    for (const hostHeader of ["127.0.0.1:43210", "[::1]:43210", "localhost:43210"]) {
      expect((await fixture.request("GET", "/", { host: hostHeader })).status).toBe(200);
    }
    const response = await fixture.request("GET", "/", { host: "foreign.example.test:43210" });
    expect(response.status).toBe(403);
    expect(response.body).toBe('{"error":"app_host_invalid"}');
    expect((await fixture.request("GET", "/", { host: host.origin })).status).toBe(403);
    await host.close();
  });

  it("refuses unknown resources and unknown paths with code-only errors", async () => {
    const reader = vi.fn(() => Promise.resolve(resource));
    const fixture = makeServer({ readResource: reader, idGenerator: () => sessionId });
    const host = await fixture.hostPromise;
    const unknown = await fixture.request(
      "GET",
      `/api/app?resourceUri=${encodeURIComponent("ui://unknown")}`,
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
      readResource: () => Promise.resolve({ contents: [{ mimeType: "text/plain", text: "no" }] }),
      idGenerator: () => sessionId,
    });
    const invalidHost = await invalid.hostPromise;
    const invalidResponse = await invalid.request(
      "GET",
      appPath(await newAppSession(invalid, invalidHost)),
      authorization(invalidHost),
    );
    expect(invalidResponse.status).toBe(422);
    await invalidHost.close();

    const oversized = makeServer({
      readResource: () =>
        Promise.resolve({
          contents: [{ mimeType: "text/html;profile=mcp-app", text: "x".repeat(1_048_577) }],
        }),
      idGenerator: () => sessionId,
    });
    const oversizedHost = await oversized.hostPromise;
    expect(
      (
        await oversized.request(
          "GET",
          appPath(await newAppSession(oversized, oversizedHost)),
          authorization(oversizedHost),
        )
      ).status,
    ).toBe(422);
    await oversizedHost.close();

    const failed = makeServer({
      readResource: () => Promise.reject(new Error("sensitive reader detail")),
      idGenerator: () => sessionId,
    });
    const failedHost = await failed.hostPromise;
    const failureResponse = await failed.request(
      "GET",
      appPath(await newAppSession(failed, failedHost)),
      authorization(failedHost),
    );
    expect(failureResponse.status).toBe(502);
    expect(failureResponse.body).not.toContain("sensitive reader detail");
    await failedHost.close();
  });

  it("accepts MIME parameter spacing and case but requires the exact app profile", async () => {
    for (const [mimeType, expectedStatus] of [
      ["TEXT/HTML ; profile = mcp-app", 200],
      ['text/html; charset=utf-8 ; profile="mcp-app"', 200],
      ["text/html", 422],
      ["text/html; profile=other", 422],
    ] as const) {
      const fixture = makeServer({
        readResource: () =>
          Promise.resolve({ contents: [{ mimeType, text: "<main>test</main>" }] }),
      });
      const host = await fixture.hostPromise;
      const launchedSessionId = await newAppSession(fixture, host);
      const result = await fixture.request("GET", appPath(launchedSessionId), authorization(host));
      expect(result.status).toBe(expectedStatus);
      await host.close();
    }
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
      readResource: () =>
        Promise.resolve({
          contents: [
            {
              mimeType: "text/html;profile=mcp-app",
              text: "<main>safe</main>",
              _meta: {
                ui: {
                  permissions: { camera: {}, microphone: {}, clipboardWrite: {} },
                  csp: {
                    connectDomains: [
                      "https://allowed.example.test",
                      "https://blocked.example.test",
                    ],
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
      appPath(await newAppSession(fixture, host)),
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
      readResource: () =>
        Promise.resolve({
          contents: [
            { mimeType: "text/html;profile=mcp-app", text: "<main>safe</main>", _meta: { ui: {} } },
          ],
        }),
    });
    const host = await fixture.hostPromise;
    const result = await fixture.request(
      "GET",
      appPath(await newAppSession(fixture, host)),
      authorization(host),
    );
    expect(parseJson(ResourceResponseSchema, result.body).csp).toBe(REFERENCE_CSP);
    await host.close();
  });

  it("serves the static host page and bundle without exposing token-protected data", async () => {
    const readStatic = vi.fn((asset: "index" | "bundle") => Promise.resolve(Buffer.from(asset)));
    const fixture = makeServer({ readStatic, idGenerator: () => sessionId });
    const host = await fixture.hostPromise;
    expect((await fixture.request("GET", "/")).body).toBe("index");
    expect((await fixture.request("GET", "/host.js")).body).toBe("bundle");
    expect(readStatic).toHaveBeenNthCalledWith(1, "index");
    expect(readStatic).toHaveBeenNthCalledWith(2, "bundle");
    const unavailable = makeServer({
      readStatic: () => Promise.reject(new Error("private file path")),
      idGenerator: () => sessionId,
    });
    const unavailableHost = await unavailable.hostPromise;
    const failedIndex = await unavailable.request("GET", "/");
    expect(failedIndex.status).toBe(503);
    const failedBundle = await unavailable.request("GET", "/host.js");
    expect(failedBundle.status).toBe(503);
    await host.close();
    await unavailableHost.close();
  });

  it("validates app calls against the active host session before routing", async () => {
    const onAppCall = vi.fn(() =>
      Promise.resolve(CallToolResultSchema.parse({ content: [{ type: "text", text: "ok" }] })),
    );
    const fixture = makeServer({ idGenerator: () => sessionId, onAppCall });
    const host = await fixture.hostPromise;
    await newAppSession(fixture, host);
    const headers = authorization(host);
    const body = JSON.stringify({
      appId: "approval",
      sessionId,
      toolName: "approve",
      arguments: { decision: "yes" },
    });
    const result = await fixture.request("POST", "/api/call", headers, body);
    expect(result.status).toBe(200);
    expect(onAppCall).toHaveBeenCalledExactlyOnceWith(
      {
        appId: "approval",
        sessionId,
        toolName: "approve",
        arguments: { decision: "yes" },
      },
      { runId: sessionId, policyContext: { subagent: false, app: "approval" } },
    );
    const disallowed = await fixture.request(
      "POST",
      "/api/call",
      headers,
      body.replace('"approve"', '"filesystem.write"'),
    );
    expect(disallowed.status).toBe(403);
    expect(disallowed.body).toBe('{"error":"app_tool_not_allowed"}');
    const invalid = await fixture.request("POST", "/api/call", headers, "{");
    expect(invalid.status).toBe(400);
    const mismatched = await fixture.request(
      "POST",
      "/api/call",
      headers,
      body.replace(sessionId, "00000000000000000000000001"),
    );
    expect(mismatched.status).toBe(404);
    const large = await fixture.request("POST", "/api/call", headers, "x".repeat(32_769));
    expect(large.status).toBe(413);
    await host.close();
  });

  it("accepts exact-limit telemetry and acknowledges over-limit batches through the endpoint", async () => {
    const onAppRejected = vi.fn();
    const fixture = makeServer({ onAppRejected, idGenerator: () => sessionId });
    const host = await fixture.hostPromise;
    const launchedSessionId = await newAppSession(fixture, host);
    const size = 16 * 1024;
    const prefix = '{"spans":[{"padding":"';
    const suffix = '"}]}';
    const exactBatch = {
      spans: [{ padding: "x".repeat(size - prefix.length - suffix.length) }],
    };
    const oversizedBatch = {
      spans: [{ padding: "x".repeat(size + 1 - prefix.length - suffix.length) }],
    };
    const exactBody = telemetryCallBody(launchedSessionId, exactBatch);
    const oversizedBody = telemetryCallBody(launchedSessionId, oversizedBatch);

    expect(Buffer.byteLength(JSON.stringify(exactBatch), "utf8")).toBe(size);
    expect(Buffer.byteLength(JSON.stringify(oversizedBatch), "utf8")).toBe(size + 1);
    expect(Buffer.byteLength(exactBody, "utf8")).toBeGreaterThan(size);
    expect(Buffer.byteLength(oversizedBody, "utf8")).toBeLessThan(32 * 1024);

    const exact = await fixture.request("POST", "/api/call", authorization(host), exactBody);
    const oversized = await fixture.request(
      "POST",
      "/api/call",
      authorization(host),
      oversizedBody,
    );

    expectTelemetryAck(exact, 0, 1);
    expectTelemetryAck(oversized, 0, 1);
    expect(onAppRejected.mock.calls).toEqual([["schema"], ["size"]]);
    await host.close();
  });

  it("parents ingested app spans to their active UI-session span", async () => {
    const start = spanCollector.getFinishedSpans().length;
    const toolCallSpan = spanCollector.provider
      .getTracer("host-test")
      .startSpan("harness.tool_call");
    const fixture = makeServer({
      idGenerator: () => sessionId,
      uiSessionContext: {
        runId: sessionId,
        toolCallSpanContext: toolCallSpan.spanContext(),
      },
    });
    const host = await fixture.hostPromise;
    const launchedSessionId = await newAppSession(fixture, host);
    const response = await fixture.request(
      "POST",
      "/api/call",
      authorization(host),
      telemetryCallBody(launchedSessionId, {
        spans: [{ name: "ui.render", startOffsetMs: 0, durationMs: 1 }],
      }),
    );
    expectTelemetryAck(response, 1, 0);
    await host.close();
    toolCallSpan.end();

    const spans = spanCollector.getFinishedSpans().slice(start);
    const sessionSpan = spans.find(
      (span) =>
        span.name === "harness.ui_session" &&
        span.attributes["harness.ui.session_id"] === launchedSessionId,
    );
    const appSpan = spans.find((span) => span.name === "harness.ui.render");
    expect(sessionSpan).toBeDefined();
    expect(appSpan?.parentSpanContext?.spanId).toBe(sessionSpan?.spanContext().spanId);
  });

  it("limits telemetry batches per session in a rolling minute", async () => {
    let now = 0;
    let nextId = 0;
    const onAppRejected = vi.fn();
    const fixture = makeServer({
      idGenerator: () => String(nextId++).padStart(26, "0"),
      maxAppTelemetryBatchesPerMinute: 2,
      now: () => now,
      onAppRejected,
    });
    const host = await fixture.hostPromise;
    const firstSession = await newAppSession(fixture, host);
    const secondSession = await newAppSession(fixture, host);
    const batch = { spans: [{ name: "ui.render", startOffsetMs: 0, durationMs: 1 }] };
    const emit = (appSession: string) =>
      fixture.request(
        "POST",
        "/api/call",
        authorization(host),
        telemetryCallBody(appSession, batch),
      );

    expectTelemetryAck(await emit(firstSession), 1, 0);
    expectTelemetryAck(await emit(firstSession), 1, 0);
    expectTelemetryAck(
      await fixture.request(
        "POST",
        "/api/call",
        authorization(host),
        telemetryCallBody(firstSession, { spans: [batch.spans[0], batch.spans[0]] }),
      ),
      0,
      2,
    );
    expectTelemetryAck(await emit(secondSession), 1, 0);
    expect(onAppRejected).toHaveBeenCalledExactlyOnceWith("rate");

    now = 60_000;
    expectTelemetryAck(await emit(firstSession), 1, 0);
    await host.close();
  });

  it("returns a bounded error result if app calls are not handled or fail", async () => {
    const noHandler = makeServer({ idGenerator: () => sessionId });
    const noHandlerHost = await noHandler.hostPromise;
    const sessionForNoHandler = await newAppSession(noHandler, noHandlerHost);
    const body = JSON.stringify({
      appId: "approval",
      sessionId: sessionForNoHandler,
      toolName: "approve",
      arguments: {},
    });
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
      onAppCall: () => Promise.reject(new Error("sensitive tool error")),
    });
    const failingHost = await failing.hostPromise;
    await newAppSession(failing, failingHost);
    const failure = await failing.request("POST", "/api/call", authorization(failingHost), body);
    expect(failure.body).toBe('{"content":[],"isError":true}');
    await failingHost.close();
  });

  it("rejects non-loopback configuration and invalid session identifiers", async () => {
    await expect(
      createReferenceHost(
        { ...appConfig, listen: { host: "0.0.0.0", port: 8080 } },
        { readResource: () => Promise.resolve(resource), onCode: () => undefined },
      ),
    ).rejects.toThrow();
    await expect(
      createReferenceHost(appConfig, {
        readResource: () => Promise.resolve(resource),
        onCode: () => undefined,
        idGenerator: () => "invalid",
        createHttpServer: () => {
          throw new Error("server should not start");
        },
      }),
    ).rejects.toThrow();
  });

  it("handles listen failure, invalid bound addresses, and close errors", async () => {
    const listenFailure = makeServer({ listenError: new Error("private listen detail") });
    await expect(listenFailure.hostPromise).rejects.toMatchObject({
      code: "app_host_bind_failed",
    });

    const invalidAddress = makeServer({ address: null });
    await expect(invalidAddress.hostPromise).rejects.toMatchObject({
      code: "app_host_address_unavailable",
    });
    expect(invalidAddress.closed).toBe(true);

    const badClose = makeServer({ idGenerator: () => sessionId, closeError: new Error("close") });
    const host = await badClose.hostPromise;
    const closeOperation = host.close();
    await expect(closeOperation).rejects.toBeInstanceOf(ReferenceHostError);
    await expect(closeOperation).rejects.toMatchObject({ code: "app_host_close_failed" });
  });
});
