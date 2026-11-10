// SPDX-License-Identifier: Apache-2.0
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import {
  ApprovalAppInputSchema,
  ApprovalAppGetRequestSchema,
  ApprovalPayloadSchema,
  Code,
  ControlPlaneConfigSchema,
  JsonValue,
  parseJson,
} from "@rovinos/schemas";
import type { Event as HarnessEvent, Id, NewEvent } from "@rovinos/schemas";
import { createEventBuilders } from "@rovinos/store/testing";
import { SqliteEventStore } from "@rovinos/store-sqlite";
import { z } from "zod";
import {
  INSPECTOR_HTTP_TOKEN,
  minimalInspectorEnvironment,
  startInspectorHttpServer,
} from "../scripts/ci/inspector-http.js";
import {
  startInspectorWebClient,
  type RunningInspectorWebClient,
} from "../scripts/ci/inspector-web.js";

const root = resolve(import.meta.dirname, "..");
const harness = resolve(root, "packages/cli/dist/bin.js");
const inspector = resolve(
  root,
  "node_modules/@modelcontextprotocol/inspector/clients/launcher/build/index.js",
);
const emailCanary = "inspector-private-canary@example.test";
const textCanary = "INSPECTOR_RAW_CANARY";
const rawCanaries = [emailCanary, textCanary];
const inspectorApiToken = "INSPECTOR_APPS_TEST_API_TOKEN_LONG_ENOUGH";
const authorization = `${String.fromCharCode(66, 101, 97, 114, 101, 114)} ${INSPECTOR_HTTP_TOKEN}`;
const traceId = "a".repeat(32);
const spanId = "b".repeat(16);
const inspectorConnectRequestSchema = z.looseObject({
  config: z.looseObject({
    type: z.enum(["streamable-http", "sse"]),
    url: z.url(),
  }),
  settings: z
    .looseObject({
      headers: z.array(z.object({ key: z.string(), value: z.string() })).optional(),
      metadata: z.looseObject({}).optional(),
      protocolEra: z.enum(["legacy", "auto", "modern"]).optional(),
      connectionTimeout: z.number().optional(),
      requestTimeout: z.number().optional(),
    })
    .optional(),
});
const inspectorServerCreateRequestSchema = z.looseObject({
  id: z.string(),
  config: z.looseObject({ type: z.enum(["streamable-http", "sse"]), url: z.url() }),
  settings: z
    .looseObject({
      headers: z.array(z.object({ key: z.string(), value: z.string() })).optional(),
      protocolEra: z.enum(["legacy", "auto", "modern"]).optional(),
    })
    .optional(),
});
const inspectorJsonRpcMessageSchema = z.looseObject({
  id: z.union([z.number(), z.string()]).optional(),
  method: z.string().optional(),
  result: z
    .looseObject({
      structuredContent: z.unknown().optional(),
    })
    .optional(),
  params: z
    .looseObject({
      name: z.string().optional(),
      isError: z.boolean().optional(),
      html: z.string().optional(),
      structuredContent: z.unknown().optional(),
      content: z.array(z.looseObject({ type: z.string() })).optional(),
      arguments: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
  error: z.looseObject({ code: z.union([z.number(), z.string()]).optional() }).optional(),
});
const inspectorServerEventSchema = z.looseObject({
  type: z.literal("message"),
  data: inspectorJsonRpcMessageSchema,
});
const recordSchema = z.record(z.string(), z.unknown());
const inspectorSendRequestSchema = z.looseObject({
  message: inspectorJsonRpcMessageSchema,
});

interface ApprovalFixture {
  readonly runId: Id;
  readonly approvalId: Id;
  readonly payload: ReturnType<typeof ApprovalPayloadSchema.parse>;
}

interface CapturedRequest {
  readonly url: string;
  readonly body: string | undefined;
  readonly frameUrl: string;
}

interface CapturedResponse {
  readonly url: string;
  readonly status: number;
  readonly body?: string;
}

interface BrowserDiagnostics {
  readonly console: string[];
  readonly jsonRpcMessages: string[];
  readonly pageErrors: string[];
  readonly networkFailures: string[];
  readonly failedResponses: string[];
}

function redactDiagnostic(value: string): string {
  return [emailCanary, textCanary, inspectorApiToken, INSPECTOR_HTTP_TOKEN, authorization].reduce(
    (result, secret) => result.replaceAll(secret, "[redacted]"),
    value,
  );
}

function safeRequestUrl(value: string): string {
  const url = new URL(value);
  return `${url.origin}${url.pathname}`;
}

function captureBrowserDiagnostics(page: Page, diagnostics: BrowserDiagnostics): void {
  page.on("console", async (message) => {
    diagnostics.console.push(redactDiagnostic(`${message.type()}: ${message.text()}`));
    const values = await Promise.all(
      message.args().map((argument) => argument.jsonValue().catch(() => undefined)),
    );
    for (const value of values) {
      const parsed = inspectorJsonRpcMessageSchema.safeParse(value);
      if (!parsed.success) {
        continue;
      }
      const record = parsed.data;
      const errorCode = record.error?.code;
      let safeErrorCode: string | number | undefined;
      if (typeof errorCode === "number") {
        safeErrorCode = errorCode;
      } else if (typeof errorCode === "string" && /^[\w.-]{1,80}$/u.test(errorCode)) {
        safeErrorCode = errorCode;
      }
      const method =
        record.method !== undefined && /^[\w/.-]{1,100}$/u.test(record.method)
          ? record.method
          : undefined;
      const toolName =
        record.params?.name !== undefined && /^harness\.[\w.-]{1,100}$/u.test(record.params.name)
          ? record.params.name
          : undefined;
      const toolResult =
        method === "ui/notifications/tool-result" && record.params !== undefined
          ? {
              isError: record.params.isError === true,
              hasStructuredContent: record.params.structuredContent !== undefined,
              structuredCode: (() => {
                const content = recordSchema.safeParse(record.params.structuredContent);
                const code = content.success ? content.data.code : undefined;
                return typeof code === "string" && /^[\w.-]{1,80}$/u.test(code) ? code : undefined;
              })(),
              contentTypes: record.params.content?.map((part) => part.type) ?? [],
              validApprovalInput: ApprovalAppInputSchema.safeParse(record.params.structuredContent)
                .success,
              structuredKeys: (() => {
                const content = recordSchema.safeParse(record.params.structuredContent);
                return content.success ? Object.keys(content.data) : [];
              })(),
            }
          : undefined;
      const resourceHtml =
        method === "ui/notifications/sandbox-resource-ready" && record.params?.html !== undefined
          ? {
              length: record.params.html.length,
              hasScript: /<script\b/iu.test(record.params.html),
            }
          : undefined;
      if (
        safeErrorCode !== undefined ||
        method !== undefined ||
        toolName !== undefined ||
        toolResult !== undefined ||
        resourceHtml !== undefined
      ) {
        diagnostics.jsonRpcMessages.push(
          JSON.stringify({
            ...(record.id === undefined ? {} : { id: record.id }),
            ...(method === undefined ? {} : { method }),
            ...(toolName === undefined ? {} : { toolName }),
            ...(toolResult === undefined ? {} : { toolResult }),
            ...(resourceHtml === undefined ? {} : { resourceHtml }),
            ...(safeErrorCode === undefined ? {} : { errorCode: safeErrorCode }),
          }),
        );
      }
    }
  });
  page.on("pageerror", (error) => {
    diagnostics.pageErrors.push(redactDiagnostic(error.message));
  });
  page.on("requestfailed", (request) => {
    diagnostics.networkFailures.push(
      `${safeRequestUrl(request.url())}: ${redactDiagnostic(request.failure()?.errorText ?? "unknown failure")}`,
    );
  });
  page.on("response", (response) => {
    if (response.status() >= 400) {
      diagnostics.failedResponses.push(
        `${safeRequestUrl(response.url())}: HTTP ${String(response.status())}`,
      );
    }
  });
}

async function captureInspectorServerResults(
  page: Page,
  diagnostics: BrowserDiagnostics,
): Promise<void> {
  await page.exposeBinding("__captureInspectorMcpEvent", (_source, payload: unknown) => {
    if (typeof payload !== "string") {
      return;
    }
    if (payload === "inspector-event-stream-open") {
      diagnostics.jsonRpcMessages.push(JSON.stringify({ eventStream: "opened" }));
      return;
    }
    let event: z.infer<typeof inspectorServerEventSchema>;
    try {
      event = parseJson(inspectorServerEventSchema, payload);
    } catch {
      return;
    }
    const result = recordSchema.safeParse(event.data.result?.structuredContent);
    const code = result.success ? result.data.code : undefined;
    const errorCode = event.data.error?.code;
    diagnostics.jsonRpcMessages.push(
      JSON.stringify({
        ...(event.data.id === undefined ? {} : { id: event.data.id }),
        hasResult: event.data.result !== undefined,
        ...(typeof code === "string" && /^[\w.-]{1,80}$/u.test(code)
          ? { structuredCode: code }
          : {}),
        ...(typeof errorCode === "number" ||
        (typeof errorCode === "string" && /^[\w.-]{1,80}$/u.test(errorCode))
          ? { errorCode }
          : {}),
      }),
    );
  });
  await page.addInitScript(() => {
    const fetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const response = await fetch(...args);
      const input = args[0];
      const url =
        typeof input === "string"
          ? input
          : input instanceof Request
            ? input.url
            : input instanceof URL
              ? input.href
              : undefined;
      if (url !== undefined && new URL(url, window.location.href).pathname === "/api/mcp/events") {
        const capture = Reflect.get(window, "__captureInspectorMcpEvent");
        if (typeof capture === "function") {
          Reflect.apply(capture, window, ["inspector-event-stream-open"]);
        }
        const reader = response.clone().body?.getReader();
        if (reader !== undefined) {
          void (async () => {
            const decoder = new TextDecoder();
            let buffer = "";
            while (true) {
              const { done, value } = await reader.read();
              buffer += decoder.decode(value, { stream: !done });
              const chunks = buffer.split("\n\n");
              buffer = chunks.pop() ?? "";
              for (const chunk of chunks) {
                const data = chunk
                  .split("\n")
                  .find((line) => line.startsWith("data: "))
                  ?.slice(6);
                const capture = Reflect.get(window, "__captureInspectorMcpEvent");
                if (data !== undefined && typeof capture === "function") {
                  Reflect.apply(capture, window, [data]);
                }
              }
              if (done) {
                break;
              }
            }
          })();
        }
      }
      return response;
    };
  });
}

function captureInspectorResponses(page: Page, responses: CapturedResponse[]): void {
  page.on("response", async (response) => {
    const url = response.url();
    const body =
      new URL(url).pathname === "/api/mcp/send"
        ? redactDiagnostic(await response.text().catch(() => "")).slice(0, 2_000)
        : undefined;
    responses.push({
      url,
      status: response.status(),
      ...(body === undefined ? {} : { body }),
    });
  });
}

function expectNoExternalSandboxRequests(requests: readonly CapturedRequest[]): void {
  const sandboxRequests = requests.filter((request) => isSandboxFrame(request.frameUrl));
  expect(
    sandboxRequests.filter(
      (request) => !["127.0.0.1", "localhost", "::1"].includes(new URL(request.url).hostname),
    ),
  ).toEqual([]);
}

function isSandboxFrame(frameUrl: string): boolean {
  if (frameUrl === "about:srcdoc") {
    return true;
  }
  try {
    return new URL(frameUrl).pathname === "/sandbox";
  } catch {
    return false;
  }
}

function approvalAppFrame(page: Page) {
  return page.frameLocator('[data-testid="apps-form"] iframe').frameLocator("iframe");
}

async function configureInspectorAuthorization(
  page: Page,
  inspectorUrl: string,
  serverUrl: string,
): Promise<void> {
  const inspectorOrigin = new URL(inspectorUrl).origin;
  await page.route(
    (url) => url.origin === inspectorOrigin && url.pathname === "/api/servers",
    async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      const body = route.request().postData();
      if (body === null) {
        throw new Error("Inspector server registration did not contain a body.");
      }
      const request = parseJson(inspectorServerCreateRequestSchema, body);
      if (request.config.url !== serverUrl) {
        await route.continue();
        return;
      }
      await route.continue({
        postData: JSON.stringify({
          ...request,
          settings: {
            ...request.settings,
            headers: request.settings?.headers ?? [],
            metadata: request.settings?.metadata ?? {},
            protocolEra: "modern",
            connectionTimeout: request.settings?.connectionTimeout ?? 30_000,
            requestTimeout: request.settings?.requestTimeout ?? 0,
          },
        }),
      });
    },
  );
  await page.route(
    (url) => url.origin === inspectorOrigin && url.pathname === "/api/mcp/connect",
    async (route) => {
      const body = route.request().postData();
      if (body === null) {
        throw new Error("Inspector connect request did not contain a body.");
      }
      const request = parseJson(inspectorConnectRequestSchema, body);
      if (request.config.url !== serverUrl) {
        await route.continue();
        return;
      }
      await route.continue({
        postData: JSON.stringify({
          ...request,
          settings: {
            ...request.settings,
            headers: [
              ...(request.settings?.headers ?? []),
              { key: "Authorization", value: authorization },
            ],
          },
        }),
      });
    },
  );
}

let browser: Browser | undefined;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  await browser?.close();
});

async function seedApprovals(dataDir: string): Promise<ApprovalFixture[]> {
  const store = new SqliteEventStore(join(dataDir, "harness.db"));
  const builders = createEventBuilders();
  const fixtures: ApprovalFixture[] = [];
  try {
    for (const [index, decision] of (["approve", "deny", "resolved"] as const).entries()) {
      const runId = builders.nextRunId();
      const callId = builders.nextRunId();
      const approvalId = builders.nextRunId();
      const toolId = Code.parse("mail.send");
      const ruleId = Code.parse("mail.review");
      const tokenizedArgs = { email: "<EMAIL_1>", note: "<SECRET_1>" };
      const payload = ApprovalPayloadSchema.parse({
        payloadVersion: 1,
        kind: "tool_call",
        callId,
        toolId,
        ruleId,
        reason: "approval_required",
        summary: `Review synthetic mail action ${String(index + 1)}.`,
        args: tokenizedArgs,
        ui: {
          resourceUri: "ui://harness/approval/v1",
          fallbackText: "Review this action in the command line.",
        },
        editableFields: [],
      });
      const created = builders.runCreated(runId);
      const running = builders.runStatusChanged(runId, "pending", "running");
      const modelRequest = builders.modelRequest(runId, `${emailCanary} ${textCanary}`);
      const suspended = builders.runStatusChanged(runId, "running", "suspended");
      const events: NewEvent[] = [
        created,
        running,
        modelRequest,
        {
          runId,
          ts: 5,
          v: 1,
          traceId,
          spanId,
          segmentId: runId,
          type: "tool_intent",
          callId,
          toolId,
          idempotent: false,
          policyDecision: "ask",
          ruleId,
          argsHash: "c".repeat(64),
          args: tokenizedArgs,
        },
        {
          runId,
          ts: 6,
          v: 1,
          traceId,
          spanId,
          segmentId: runId,
          type: "approval_requested",
          approvalId,
          callId,
          payload: JsonValue.parse(payload),
        },
        { ...suspended, ts: 7 },
      ];
      await store.append(runId, events, 0);
      if (decision === "resolved") {
        await store.append(
          runId,
          [
            {
              runId,
              ts: 8,
              v: 2,
              traceId,
              spanId,
              segmentId: runId,
              type: "approval_resolved",
              approvalId,
              decision: "approve",
              decidedBy: "human",
              approverId: "cli.inspector_test",
              waitMs: 1,
            },
          ],
          events.length,
        );
      }
      fixtures.push({ runId, approvalId, payload });
    }
  } finally {
    await store.close();
  }
  return fixtures;
}

function deepLink(inspectorUrl: string, serverUrl: string, fixture: ApprovalFixture): string {
  const appArgs = ApprovalAppGetRequestSchema.parse({ approvalId: fixture.approvalId });
  const query = new URLSearchParams({
    serverUrl,
    transport: "http",
    autoConnect: inspectorApiToken,
    openApp: "harness.approvals.get",
    appArgs: Buffer.from(JSON.stringify(appArgs)).toString("base64url"),
    autoOpen: inspectorApiToken,
  });
  return `${inspectorUrl}/?${query.toString()}`;
}

async function openApproval(
  page: Page,
  inspectorUrl: string,
  serverUrl: string,
  fixture: ApprovalFixture,
  requestLog: CapturedRequest[],
  responseLog: CapturedResponse[],
  diagnostics: BrowserDiagnostics,
): Promise<void> {
  await page.goto(deepLink(inspectorUrl, serverUrl, fixture), { waitUntil: "domcontentloaded" });
  const connected = page.locator('[data-testid="connection-status"][data-status="connected"]');
  try {
    await connected.waitFor({ state: "visible", timeout: 30_000 });
  } catch {
    const status = await page.getByTestId("connection-status").getAttribute("data-status");
    const error = await page.getByTestId("connection-status").getAttribute("data-error-message");
    const observed = responseLog.map((response) => ({
      path: new URL(response.url).pathname,
      status: response.status,
    }));
    throw new Error(
      `Inspector connection status: ${String(status)}; ${String(error)}; ${JSON.stringify(observed)}`,
    );
  }
  try {
    await page
      .locator('[data-testid="apps-form"][data-app-status="ready"]')
      .waitFor({ state: "visible", timeout: 30_000 });
  } catch {
    const form = page.locator('[data-testid="apps-form"]');
    const formCount = await form.count();
    const body = await page
      .locator("body")
      .innerText()
      .catch(() => "");
    const appsTab = page.getByText("Apps", { exact: true });
    const appsTabCount = await appsTab.count();
    if (appsTabCount === 1) {
      await appsTab.click();
    }
    const appsPanel = await page
      .locator("body")
      .innerText()
      .catch(() => "");
    throw new Error(
      `Inspector Apps form did not become ready: ${JSON.stringify({
        formCount,
        appsTabCount,
        appStatus: formCount === 0 ? null : await form.getAttribute("data-app-status"),
        pageText: redactDiagnostic(body).slice(0, 2_000),
        appsPanel: redactDiagnostic(appsPanel).slice(0, 2_000),
        console: diagnostics.console,
        jsonRpcMessages: diagnostics.jsonRpcMessages,
        inspectorRequests: requestLog.map((request) => {
          let message: z.infer<typeof inspectorJsonRpcMessageSchema> | undefined;
          if (request.body !== undefined) {
            try {
              message = parseJson(inspectorSendRequestSchema, request.body).message;
            } catch {
              message = undefined;
            }
          }
          return {
            path: new URL(request.url).pathname,
            ...(message !== undefined
              ? {
                  method: message.method,
                  toolName:
                    message.params?.name !== undefined &&
                    /^harness\.[\w.-]{1,100}$/u.test(message.params.name)
                      ? message.params.name
                      : undefined,
                }
              : {}),
          };
        }),
        inspectorResponses: responseLog.map(({ url, status }) => ({
          path: new URL(url).pathname,
          status,
        })),
        pageErrors: diagnostics.pageErrors,
        networkFailures: diagnostics.networkFailures,
        failedResponses: diagnostics.failedResponses,
        serverMessages: responseLog.filter((response) => response.body !== undefined),
      })}`,
    );
  }
  const sandboxFrame = page.getByTestId("apps-form").locator("iframe");
  expect(await sandboxFrame.count()).toBe(1);
  expect(
    await page.frameLocator('[data-testid="apps-form"] iframe').locator("iframe").count(),
  ).toBe(1);
  const app = approvalAppFrame(page);
  try {
    await app.getByRole("heading", { name: fixture.payload.summary }).waitFor({ state: "visible" });
    await app.getByText(fixture.payload.ruleId, { exact: true }).waitFor({ state: "visible" });
    const emailPill = app.locator('[aria-label="<EMAIL_1>"]');
    const secretPill = app.locator('[aria-label="<SECRET_1>"]');
    await emailPill.waitFor({ state: "visible" });
    await secretPill.waitFor({ state: "visible" });
    expect(await emailPill.innerText()).toBe("email 1");
    expect(await secretPill.innerText()).toBe("secret 1");
  } catch {
    const appText = await app
      .locator("body")
      .innerText()
      .catch(() => "");
    const appMessages = await page.getByTestId("apps-messages").allInnerTexts();
    const appLogs = await page.getByTestId("apps-logs").allInnerTexts();
    const appError = await page
      .getByTestId("apps-error")
      .allInnerTexts()
      .then((texts) => texts.join("\n"))
      .catch(() => "");
    const appDocument = await app
      .locator("body")
      .evaluate((body) => ({
        childCount: body.childElementCount,
        readyState: body.ownerDocument.readyState,
        title: body.ownerDocument.title,
      }))
      .catch(() => null);
    throw new Error(
      `Inspector app content did not render: ${JSON.stringify({
        appText: redactDiagnostic(appText).slice(0, 2_000),
        appMessages: redactDiagnostic(appMessages.join("\n")).slice(0, 2_000),
        appLogs: redactDiagnostic(appLogs.join("\n")).slice(0, 2_000),
        appError: redactDiagnostic(appError).slice(0, 500),
        appDocument,
        frameUrls: page.frames().map((frame) => safeRequestUrl(frame.url())),
        console: diagnostics.console,
        jsonRpcMessages: diagnostics.jsonRpcMessages,
        inspectorRequests: requestLog.map((request) => {
          let message: z.infer<typeof inspectorJsonRpcMessageSchema> | undefined;
          if (request.body !== undefined) {
            try {
              message = parseJson(inspectorSendRequestSchema, request.body).message;
            } catch {
              message = undefined;
            }
          }
          return {
            path: new URL(request.url).pathname,
            frame: request.frameUrl === "about:srcdoc" ? "app" : "host",
            ...(message !== undefined
              ? {
                  method: message.method,
                  toolName:
                    message.params?.name !== undefined &&
                    /^harness\.[\w.-]{1,100}$/u.test(message.params.name)
                      ? message.params.name
                      : undefined,
                }
              : {}),
          };
        }),
        inspectorResponses: responseLog.map(({ url, status }) => ({
          path: new URL(url).pathname,
          status,
        })),
        pageErrors: diagnostics.pageErrors,
        networkFailures: diagnostics.networkFailures,
        failedResponses: diagnostics.failedResponses,
      })}`,
    );
  }
  const inspectorText = await page.locator("body").innerText();
  const appText = await app.locator("body").innerText();
  const messages = await page.getByTestId("apps-messages").allInnerTexts();
  const logs = await page.getByTestId("apps-logs").allInnerTexts();
  const serialized = JSON.stringify({ inspectorText, appText, messages, logs, requestLog });
  for (const canary of rawCanaries) {
    expect(serialized).not.toContain(canary);
  }
  expectNoExternalSandboxRequests(requestLog);
}

it("renders approval apps in Inspector and fails closed on decisions without confirmation", async () => {
  const activeBrowser = browser;
  if (activeBrowser === undefined) {
    throw new Error("Playwright browser was not initialized.");
  }
  const workDir = await mkdtemp(join(tmpdir(), "harness-inspector-apps-"));
  const home = join(workDir, "home");
  const dataDir = join(workDir, "data");
  const configPath = join(workDir, "harness.config.json");
  let harnessServer: Awaited<ReturnType<typeof startInspectorHttpServer>> | undefined;
  let inspectorServer: RunningInspectorWebClient | undefined;
  const contexts: Awaited<ReturnType<Browser["newContext"]>>[] = [];
  try {
    await Promise.all([mkdir(home), mkdir(dataDir)]);
    const controlPlane = ControlPlaneConfigSchema.parse({
      auth: {
        tokens: [
          {
            id: "token.inspector_apps",
            secret: "env:CONTROL_PLANE_INSPECTOR_TOKEN",
            scopes: ["approve"],
          },
        ],
      },
    });
    await writeFile(configPath, `${JSON.stringify({ controlPlane })}\n`, { mode: 0o600 });
    const fixtures = await seedApprovals(dataDir);
    const harnessEnv = minimalInspectorEnvironment(home, configPath, dataDir);
    harnessServer = await startInspectorHttpServer({ root, harness, env: harnessEnv });
    const activeHarnessServer = harnessServer;
    const inspectorEnv: NodeJS.ProcessEnv = {
      ...harnessEnv,
      HOST: "127.0.0.1",
      CLIENT_PORT: "6274",
      MCP_SANDBOX_PORT: "6275",
      MCP_INSPECTOR_API_TOKEN: inspectorApiToken,
      MCP_AUTO_OPEN_ENABLED: "false",
      MCP_INSPECTOR_SECRET_STORE: "memory",
      MCP_STORAGE_DIR: join(home, "storage"),
      MCP_CATALOG_PATH: join(home, "catalog.json"),
    };
    inspectorServer = await startInspectorWebClient({
      root,
      launcher: inspector,
      env: inspectorEnv,
    });
    const activeInspectorServer = inspectorServer;
    const requestLog: CapturedRequest[] = [];
    const responseLog: CapturedResponse[] = [];
    const testApproval = async (fixture: ApprovalFixture, decision: "approve" | "deny") => {
      const context = await activeBrowser.newContext();
      contexts.push(context);
      const page = await context.newPage();
      const diagnostics: BrowserDiagnostics = {
        console: [],
        jsonRpcMessages: [],
        pageErrors: [],
        networkFailures: [],
        failedResponses: [],
      };
      await captureInspectorServerResults(page, diagnostics);
      captureBrowserDiagnostics(page, diagnostics);
      await configureInspectorAuthorization(
        page,
        activeInspectorServer.url,
        activeHarnessServer.endpoint,
      );
      page.on("request", (request) => {
        requestLog.push({
          url: request.url(),
          body: request.postData() ?? undefined,
          frameUrl: request.frame().url(),
        });
      });
      captureInspectorResponses(page, responseLog);
      await openApproval(
        page,
        activeInspectorServer.url,
        activeHarnessServer.endpoint,
        fixture,
        requestLog,
        responseLog,
        diagnostics,
      );
      const app = approvalAppFrame(page);
      const button = app.getByRole("button", {
        name: decision === "approve" ? "Approve" : "Deny",
        exact: true,
      });
      await button.click();
      try {
        await app
          .getByRole("status")
          .filter({ hasText: "The approval could not be resolved." })
          .waitFor({ state: "visible" });
      } catch {
        const appText = await app
          .locator("body")
          .innerText()
          .catch(() => "");
        const toolCalls = requestLog
          .filter((request) => request.url.includes("/api/mcp/send"))
          .map((request) => {
            if (request.body === undefined) {
              return undefined;
            }
            try {
              const { message } = parseJson(inspectorSendRequestSchema, request.body);
              return {
                method: message.method,
                toolName: message.params?.name,
                argumentKeys:
                  message.params?.arguments === undefined
                    ? []
                    : Object.keys(message.params.arguments),
                decision:
                  message.params?.arguments?.decision === "approve" ||
                  message.params?.arguments?.decision === "deny"
                    ? message.params.arguments.decision
                    : undefined,
              };
            } catch {
              return undefined;
            }
          })
          .filter((request) => request !== undefined);
        throw new Error(
          `Inspector approval decision did not render: ${JSON.stringify({
            appText: redactDiagnostic(appText).slice(0, 1_000),
            toolCalls,
            jsonRpcMessages: diagnostics.jsonRpcMessages,
            pageErrors: diagnostics.pageErrors,
            networkFailures: diagnostics.networkFailures,
            failedResponses: diagnostics.failedResponses,
          })}`,
        );
      }
      expect(
        diagnostics.jsonRpcMessages.some((message) =>
          message.includes('"structuredCode":"human_confirmation_unavailable"'),
        ),
        JSON.stringify(diagnostics.jsonRpcMessages),
      ).toBe(true);
      const store = new SqliteEventStore(join(dataDir, "harness.db"));
      try {
        const events: HarnessEvent[] = [];
        for await (const event of store.read(fixture.runId)) {
          events.push(event);
        }
        const decisions = events.filter((event) => event.type === "approval_resolved");
        expect(decisions).toHaveLength(0);
      } finally {
        await store.close();
      }
      const panels = JSON.stringify({
        app: await app.locator("body").innerText(),
        inspector: await page.locator("body").innerText(),
        messages: await page.getByTestId("apps-messages").allInnerTexts(),
        logs: await page.getByTestId("apps-logs").allInnerTexts(),
        console: diagnostics.console,
        jsonRpcMessages: diagnostics.jsonRpcMessages,
        pageErrors: diagnostics.pageErrors,
        networkFailures: diagnostics.networkFailures,
        failedResponses: diagnostics.failedResponses,
        requests: requestLog,
      });
      expect(JSON.stringify(requestLog)).toContain("harness.approvals.resolve");
      expect(requestLog.some((request) => request.body?.includes(`"decision":"${decision}"`))).toBe(
        true,
      );
      expectNoExternalSandboxRequests(requestLog);
      for (const canary of rawCanaries) {
        expect(panels).not.toContain(canary);
      }
    };
    const approveFixture = fixtures[0];
    const denyFixture = fixtures[1];
    const resolvedFixture = fixtures[2];
    if (
      approveFixture === undefined ||
      denyFixture === undefined ||
      resolvedFixture === undefined
    ) {
      throw new Error("The approval fixtures were not created.");
    }
    await testApproval(approveFixture, "approve");
    await testApproval(denyFixture, "deny");

    const resolvedContext = await activeBrowser.newContext();
    contexts.push(resolvedContext);
    const resolvedPage = await resolvedContext.newPage();
    const resolvedRequests: CapturedRequest[] = [];
    const resolvedResponses: CapturedResponse[] = [];
    const resolvedDiagnostics: BrowserDiagnostics = {
      console: [],
      jsonRpcMessages: [],
      pageErrors: [],
      networkFailures: [],
      failedResponses: [],
    };
    await captureInspectorServerResults(resolvedPage, resolvedDiagnostics);
    captureBrowserDiagnostics(resolvedPage, resolvedDiagnostics);
    await configureInspectorAuthorization(
      resolvedPage,
      activeInspectorServer.url,
      activeHarnessServer.endpoint,
    );
    resolvedPage.on("request", (request) =>
      resolvedRequests.push({
        url: request.url(),
        body: request.postData() ?? undefined,
        frameUrl: request.frame().url(),
      }),
    );
    captureInspectorResponses(resolvedPage, resolvedResponses);
    await openApproval(
      resolvedPage,
      activeInspectorServer.url,
      activeHarnessServer.endpoint,
      resolvedFixture,
      resolvedRequests,
      resolvedResponses,
      resolvedDiagnostics,
    );
    const resolvedApp = approvalAppFrame(resolvedPage);
    const approve = resolvedApp.getByRole("button", { name: "Approve", exact: true });
    await approve.click();
    await resolvedApp
      .getByText("This approval has already been resolved.", { exact: true })
      .waitFor({ state: "visible" });
    expect(await approve.isDisabled()).toBe(true);
    const resolvedPanels = JSON.stringify({
      app: await resolvedApp.locator("body").innerText(),
      inspector: await resolvedPage.locator("body").innerText(),
      messages: await resolvedPage.getByTestId("apps-messages").allInnerTexts(),
      logs: await resolvedPage.getByTestId("apps-logs").allInnerTexts(),
      requests: resolvedRequests,
    });
    expectNoExternalSandboxRequests(resolvedRequests);
    for (const canary of rawCanaries) {
      expect(resolvedPanels).not.toContain(canary);
    }
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
    await inspectorServer?.close();
    await harnessServer?.close();
    await rm(workDir, { recursive: true, force: true });
  }
}, 240_000);
