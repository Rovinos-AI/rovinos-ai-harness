// SPDX-License-Identifier: Apache-2.0
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import {
  ApprovalAppInputSchema,
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
import { startInspectorWebClient, type RunningInspectorWebClient } from "../scripts/ci/inspector-web.js";

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
const inspectorConnectRequestSchema = z
  .looseObject({
    config: z.looseObject({
        type: z.enum(["streamable-http", "sse"]),
        url: z.url(),
      }),
    settings: z
      .looseObject({
        headers: z.array(z.object({ key: z.string(), value: z.string() })).optional(),
      })
      .optional(),
  })

interface ApprovalFixture {
  readonly runId: Id;
  readonly approvalId: Id;
  readonly payload: ReturnType<typeof ApprovalPayloadSchema.parse>;
}

interface CapturedRequest {
  readonly url: string;
  readonly body: string | undefined;
}

interface CapturedResponse {
  readonly url: string;
  readonly status: number;
}

function expectLoopbackRequests(requests: readonly CapturedRequest[]): void {
  const hosts = requests.map((request) => new URL(request.url).hostname);
  expect(hosts).toContain("127.0.0.1");
  expect(hosts.every((host) => ["127.0.0.1", "localhost", "::1"].includes(host))).toBe(true);
}

async function configureInspectorAuthorization(
  page: Page,
  inspectorUrl: string,
  serverUrl: string,
): Promise<void> {
  const inspectorOrigin = new URL(inspectorUrl).origin;
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

function deepLink(
  inspectorUrl: string,
  serverUrl: string,
  fixture: ApprovalFixture,
): string {
  const appArgs = ApprovalAppInputSchema.parse({
    approvalId: fixture.approvalId,
    payload: fixture.payload,
  });
  const query = new URLSearchParams({
    serverUrl,
    transport: "http",
    autoConnect: inspectorApiToken,
    openApp: "harness.approvals.resolve",
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
  await page
    .locator('[data-testid="apps-form"][data-app-status="ready"]')
    .waitFor({ state: "visible", timeout: 30_000 });
  expect(await page.getByTestId("apps-form").locator("iframe").count()).toBe(1);
  const app = page.frameLocator('[data-testid="apps-form"] iframe');
  await app.getByRole("heading", { name: fixture.payload.summary }).waitFor({ state: "visible" });
  await app.getByText(fixture.payload.ruleId, { exact: true }).waitFor({ state: "visible" });
  await app.getByText("<EMAIL_1>", { exact: true }).waitFor({ state: "visible" });
  await app.getByText("<SECRET_1>", { exact: true }).waitFor({ state: "visible" });
  const inspectorText = await page.locator("body").innerText();
  const appText = await app.locator("body").innerText();
  const messages = await page.getByTestId("apps-messages").allInnerTexts();
  const logs = await page.getByTestId("apps-logs").allInnerTexts();
  const serialized = JSON.stringify({ inspectorText, appText, messages, logs, requestLog });
  for (const canary of rawCanaries) {
    expect(serialized).not.toContain(canary);
  }
  expectLoopbackRequests(requestLog);
  expect(
    requestLog.filter(
      (entry) => !["127.0.0.1", "localhost", "::1"].includes(new URL(entry.url).hostname),
    ),
  ).toEqual([]);
}

it(
  "renders approval apps in Inspector and records human decisions",
  async () => {
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
      const consoleLog: string[] = [];
      const testApproval = async (fixture: ApprovalFixture, decision: "approve" | "deny") => {
        const context = await activeBrowser.newContext();
        contexts.push(context);
        const page = await context.newPage();
        await configureInspectorAuthorization(
          page,
          activeInspectorServer.url,
          activeHarnessServer.endpoint,
        );
        page.on("request", (request) => {
          requestLog.push({ url: request.url(), body: request.postData() ?? undefined });
        });
        page.on("response", (response) => {
          responseLog.push({ url: response.url(), status: response.status() });
        });
        page.on("console", (message) => {
          consoleLog.push(message.text());
        });
        await openApproval(
          page,
          activeInspectorServer.url,
          activeHarnessServer.endpoint,
          fixture,
          requestLog,
          responseLog,
        );
        const app = page.frameLocator('[data-testid="apps-form"] iframe');
        const button = app.getByRole("button", {
          name: decision === "approve" ? "Approve" : "Deny",
          exact: true,
        });
        if (decision === "approve") {
          await button.evaluate((element: HTMLButtonElement) => {
            element.click();
            element.click();
          });
        } else {
          await button.click();
        }
        await app
          .getByRole("status")
          .filter({ hasText: decision === "approve" ? "Approval granted." : "Approval denied." })
          .waitFor({ state: "visible" });
        expect(await button.isDisabled()).toBe(true);
        const store = new SqliteEventStore(join(dataDir, "harness.db"));
        try {
          const events: HarnessEvent[] = [];
          for await (const event of store.read(fixture.runId)) {
            events.push(event);
          }
          const decisions = events.filter((event) => event.type === "approval_resolved");
          expect(decisions).toHaveLength(1);
          expect(decisions[0]).toMatchObject({ decision, decidedBy: "human" });
        } finally {
          await store.close();
        }
        const panels = JSON.stringify({
          app: await app.locator("body").innerText(),
          inspector: await page.locator("body").innerText(),
          messages: await page.getByTestId("apps-messages").allInnerTexts(),
          logs: await page.getByTestId("apps-logs").allInnerTexts(),
          consoleLog,
          requests: requestLog,
        });
        expect(JSON.stringify(requestLog)).toContain("harness.approvals.resolve");
        expectLoopbackRequests(requestLog);
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
      await configureInspectorAuthorization(
        resolvedPage,
        activeInspectorServer.url,
        activeHarnessServer.endpoint,
      );
      resolvedPage.on("request", (request) =>
        resolvedRequests.push({ url: request.url(), body: request.postData() ?? undefined }),
      );
      resolvedPage.on("response", (response) =>
        resolvedResponses.push({ url: response.url(), status: response.status() }),
      );
      await openApproval(
        resolvedPage,
        activeInspectorServer.url,
        activeHarnessServer.endpoint,
        resolvedFixture,
        resolvedRequests,
        resolvedResponses,
      );
      const resolvedApp = resolvedPage.frameLocator('[data-testid="apps-form"] iframe');
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
      expectLoopbackRequests(resolvedRequests);
      for (const canary of rawCanaries) {
        expect(resolvedPanels).not.toContain(canary);
      }
    } finally {
      await Promise.all(contexts.map((context) => context.close()));
      await inspectorServer?.close();
      await harnessServer?.close();
      await rm(workDir, { recursive: true, force: true });
    }
  },
  240_000,
);
