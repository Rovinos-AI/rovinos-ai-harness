// SPDX-License-Identifier: Apache-2.0
import {
  Client,
  InMemoryTransport,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { createReferenceHost, type AppCall } from "@rovinos/host";
import {
  createControlPlaneServer,
  startControlPlaneHttp,
  type ControlPlaneServerOptions,
} from "@rovinos/control-plane";
import { createRuntime, type ToolPort } from "@rovinos/core";
import { FakeModelPort } from "@rovinos/core/testing";
import {
  Code,
  ControlPlaneConfigSchema,
  FakeClock,
  Id,
  JsonValue,
  PiiConfigSchema,
  Principal,
  RunConfigSchema,
  SequentialIdGenerator,
} from "@rovinos/schemas";
import { ApprovalPayloadSchema, type ApprovalPayload } from "@rovinos/schemas/browser";
import { InMemoryEventStore } from "@rovinos/store";
import { chromium, type Browser } from "playwright";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const MCP_APP_CAPABILITIES = {
  extensions: {
    "io.modelcontextprotocol/ui": {
      mimeTypes: ["text/html;profile=mcp-app"],
    },
  },
};

const clientClasses = [
  { name: "no-ui", capabilities: {}, appTools: false, elicitation: false },
  {
    name: "elicitation-only",
    capabilities: { elicitation: { form: {} } },
    appTools: false,
    elicitation: true,
  },
  {
    name: "reference-host",
    capabilities: MCP_APP_CAPABILITIES,
    appTools: true,
    elicitation: false,
  },
] as const;

const protocolEras = [
  { name: "2026-07-28", mode: { pin: "2026-07-28" } },
  { name: "2025-11-25", mode: "legacy" },
] as const;

const HTTP_TOKEN = "COMPATIBILITY_TEST_TOKEN_LONG_ENOUGH_FOR_AUTH";
const AUTHORIZATION = `${String.fromCharCode(66, 101, 97, 114, 101, 114)} ${HTTP_TOKEN}`;
const APPROVAL_HTML_PATH = join(process.cwd(), "packages", "approval-app", "dist", "approval.html");
let browser: Browser | undefined;
let approvalHtml = "";

async function createSuspendedApproval(store: InMemoryEventStore): Promise<{
  readonly runId: Id;
  readonly approvalId: Id;
  readonly payload: ApprovalPayload;
  readonly runtime: Awaited<ReturnType<typeof createRuntime>>;
}> {
  const toolId = Code.parse("tool.compatibility");
  const callId = Id.parse("00000000000000000000000002");
  const model = new FakeModelPort([
    {
      provider: "synthetic",
      model: "synthetic",
      parts: [
        {
          type: "tool_call",
          callId,
          toolId,
          args: JsonValue.parse({ synthetic: "COMPATIBILITY_PRIVATE_CANARY" }),
        },
      ],
      providerBlobs: null,
      usage: { inputTokens: 1, outputTokens: 1 },
      finishReason: "tool_calls",
      latencyMs: 0,
      schemaValid: true,
      repairAttempts: 0,
      fallbackDepth: 0,
    },
    {
      provider: "synthetic",
      model: "synthetic",
      parts: [{ type: "text", text: "Synthetic completion." }],
      providerBlobs: null,
      usage: { inputTokens: 1, outputTokens: 1 },
      finishReason: "stop",
      latencyMs: 0,
      schemaValid: true,
      repairAttempts: 0,
      fallbackDepth: 0,
    },
  ]);
  const tool: ToolPort = {
    describe: (id) => (id === toolId ? { idempotent: false, timeoutMs: 1_000 } : undefined),
    getToolSpecs: () => [
      { toolId, description: "Synthetic compatibility tool", inputSchema: { type: "object" } },
    ],
    execute: () => Promise.resolve({ outcome: "ok", result: { completed: true } }),
  };
  const runtime = await createRuntime(
    {
      run: RunConfigSchema.parse({}),
      pii: PiiConfigSchema.parse({ enabled: false }),
    },
    {
      store,
      transientVault: true,
      clock: new FakeClock(1_000),
      ids: new SequentialIdGenerator(),
      model,
      tool,
      policy: {
        version: Code.parse("compatibility.policy"),
        decide: () => ({
          decision: "ask",
          ruleId: Code.parse("compatibility.ask"),
          reason: Code.parse("policy.ask"),
          editable: [],
        }),
      },
    },
  );
  const execution = runtime.start("Run the synthetic compatibility tool.", {
    runId: Id.parse("00000000000000000000000001"),
  });
  await execution.started;
  expect((await execution.completion).status).toBe("suspended");
  let approvalId: Id | undefined;
  let payload: ApprovalPayload | undefined;
  for await (const event of store.read(execution.runId)) {
    if (event.type === "approval_requested") {
      approvalId = event.approvalId;
      payload = ApprovalPayloadSchema.parse(event.payload);
    }
  }
  if (approvalId === undefined || payload === undefined) {
    await runtime.close();
    throw new Error("The fake model run did not create an approval request.");
  }
  return { runId: execution.runId, approvalId, payload, runtime };
}

async function resolveInReferenceHost(
  client: Client,
  runId: Id,
  approvalId: Id,
  payload: ApprovalPayload,
): Promise<void> {
  if (browser === undefined) {
    throw new Error("Playwright browser was not initialized.");
  }
  const host = await createReferenceHost(
    {
      apps: [
        {
          id: "control-plane-compatibility",
          resourceUri: "ui://harness/approval/v1",
          telemetry: true,
          allowedTools: ["harness.approvals.resolve"],
        },
      ],
      listen: { host: "127.0.0.1", port: 0 },
    },
    {
      onCode: () => undefined,
      readResource: () =>
        Promise.resolve({
          contents: [{ mimeType: "text/html;profile=mcp-app", text: approvalHtml }],
        }),
      idGenerator: () => "00000000000000000000000004",
      runId,
      hasPendingApproval: () => true,
      isIdOwnedByRun: () => true,
      toolInput: { approvalId, payload },
      onAppCall: (call: AppCall) =>
        client.callTool({ name: call.toolName, arguments: call.arguments }),
      onTelemetryEmit: () => Promise.resolve({ content: [] }),
    },
  );
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(host.url, { waitUntil: "domcontentloaded" });
    const frame = page.frameLocator("iframe");
    const actionButtons = frame.locator('nav[aria-label="Approval actions"] button');
    await actionButtons.first().waitFor({ state: "visible", timeout: 10_000 });
    await frame.getByRole("button", { name: "Approve", exact: true }).click();
  } finally {
    await context.close();
    await host.close();
  }
}

describe("control-plane client compatibility", () => {
  it.each(
    clientClasses.flatMap((clientClass) =>
      protocolEras.map((protocolEra) => ({ clientClass, protocolEra })),
    ),
  )("$clientClass.name client on $protocolEra.name", async ({ clientClass, protocolEra }) => {
    const store = new InMemoryEventStore();
    const { runId, approvalId, payload, runtime } = await createSuspendedApproval(store);
    let confirmationCount = 0;
    const serverOptions: ControlPlaneServerOptions = {
      approvalHtml: "<html>synthetic approval</html>",
      runsConsoleHtml: "<html>synthetic runs</html>",
      confirmation: { key: Buffer.alloc(32, 19) },
      isAppContext: () => clientClass.name === "reference-host",
      approvalApp: {
        authorize: () => ({
          allowed: true,
          tokenId: Code.parse("token.compatibility"),
          principal: Principal.parse("cli.reference_host"),
        }),
      },
      operations: {
        resolveApproval: async ({
          runId: resolvedRunId,
          approvalId: resolvedId,
          decision,
          approverId,
        }) =>
          runtime.resolveApproval(resolvedRunId, resolvedId, decision, {
            metadata: { decidedBy: "human", approverId },
          }),
        resumeRun: (resumedRunId) => runtime.resume(resumedRunId),
      },
    };
    let closeServer: () => Promise<void>;
    let clientTransport: InMemoryTransport | StreamableHTTPClientTransport;
    if (protocolEra.name === "2025-11-25") {
      const [clientMemoryTransport, serverMemoryTransport] = InMemoryTransport.createLinkedPair();
      const memoryServer = createControlPlaneServer(store, serverOptions);
      await memoryServer.connect(serverMemoryTransport);
      clientTransport = clientMemoryTransport;
      closeServer = async () => {
        await memoryServer.close();
        await serverMemoryTransport.close();
      };
    } else {
      const httpServer = await startControlPlaneHttp(store, 0, {
        ...serverOptions,
        controlPlane: ControlPlaneConfigSchema.parse({
          auth: {
            tokens: [
              {
                id: "token.compatibility",
                secret: "env:CONTROL_PLANE_COMPAT_TEST_TOKEN",
                scopes: ["admin"],
              },
            ],
          },
        }),
        secretResolver: { resolve: () => Promise.resolve({ reveal: () => HTTP_TOKEN }) },
      });
      clientTransport = new StreamableHTTPClientTransport(new URL(httpServer.endpoint), {
        requestInit: { headers: { authorization: AUTHORIZATION } },
      });
      closeServer = () => httpServer.close();
    }
    const client = new Client(
      { name: `control-plane-${clientClass.name}`, version: "1.0.0" },
      {
        versionNegotiation: { mode: protocolEra.mode },
        capabilities: clientClass.capabilities,
      },
    );
    if (clientClass.elicitation) {
      client.setRequestHandler("elicitation/create", (request) => {
        if (!("requestedSchema" in request.params)) {
          return { action: "cancel" };
        }
        const schema = request.params.requestedSchema;
        if ("confirm" in schema.properties) {
          confirmationCount += 1;
          return { action: "accept", content: { confirm: confirmationCount > 1 } };
        }
        return { action: "accept", content: { decision: "approve" } };
      });
    }

    let cliFallbackAvailable = false;
    let cliSelfApprovalFailedClosed = false;
    let cliSelfApprovalLeftApprovalPending = false;
    let elicitationSelfApprovalFailedClosed = false;
    let elicitationResolved = false;
    let appResolved = false;
    let resumeStarted = false;
    try {
      await client.connect(clientTransport);

      const { tools } = await client.listTools();
      const names = tools.map(({ name }) => name);
      expect(names).toContain("list_runs");
      expect(names).toContain("get_run");
      expect(names.some((name) => name.startsWith("harness.approvals."))).toBe(
        clientClass.appTools,
      );
      expect(names.includes("harness.runs.list")).toBe(clientClass.appTools);
      expect(names.includes("harness.runs.get")).toBe(clientClass.appTools);

      const listed = await client.callTool({ name: "list_runs", arguments: {} });
      const inspected = await client.callTool({ name: "get_run", arguments: { runId } });
      expect(listed.structuredContent).toMatchObject({ runs: [{ runId, status: "suspended" }] });
      expect(inspected.structuredContent).toMatchObject({ runId, status: "suspended" });
      expect(JSON.stringify([listed, inspected])).not.toContain("COMPATIBILITY_PRIVATE_CANARY");
      expect([...listed.content, ...inspected.content].every(({ type }) => type === "text")).toBe(
        true,
      );

      if (clientClass.name === "no-ui") {
        const fallback = await client.callTool({
          name: "review_approval",
          arguments: { approvalId },
        });
        cliFallbackAvailable = JSON.stringify(fallback).includes("harness approvals approve");
        const headBefore = await store.head(runId);
        const selfApproval = await client.callTool({
          name: "approve",
          arguments: { approvalId },
        });
        cliSelfApprovalFailedClosed = JSON.stringify(selfApproval).includes(
          "human_confirmation_unavailable",
        );
        cliSelfApprovalLeftApprovalPending = (await store.head(runId)) === headBefore;
        await runtime.resolveApproval(runId, approvalId, "approve", {
          metadata: { decidedBy: "human", approverId: "cli.compatibility" },
        });
        await runtime.resume(runId);
      } else if (clientClass.name === "elicitation-only") {
        const selfApproval = await client.callTool({
          name: "approve",
          arguments: { approvalId },
        });
        elicitationSelfApprovalFailedClosed = JSON.stringify(selfApproval).includes(
          "human_confirmation_declined",
        );
        const reviewed = await client.callTool({
          name: "review_approval",
          arguments: { approvalId },
        });
        elicitationResolved =
          typeof reviewed.structuredContent === "object" &&
          reviewed.structuredContent !== null &&
          "resolved" in reviewed.structuredContent &&
          reviewed.structuredContent.resolved === true;
      } else {
        const headBefore = await store.head(runId);
        await resolveInReferenceHost(client, runId, approvalId, payload);
        appResolved = (await store.head(runId)) > headBefore;
      }

      if (clientClass.name !== "no-ui") {
        const resumed = await client.callTool({ name: "resume_run", arguments: { runId } });
        resumeStarted =
          typeof resumed.structuredContent === "object" &&
          resumed.structuredContent !== null &&
          "started" in resumed.structuredContent &&
          resumed.structuredContent.started === true;
      }
      expect(cliFallbackAvailable).toBe(clientClass.name === "no-ui");
      expect(cliSelfApprovalFailedClosed).toBe(clientClass.name === "no-ui");
      expect(cliSelfApprovalLeftApprovalPending).toBe(clientClass.name === "no-ui");
      expect(elicitationSelfApprovalFailedClosed).toBe(clientClass.name === "elicitation-only");
      expect(elicitationResolved).toBe(clientClass.name === "elicitation-only");
      expect(appResolved).toBe(clientClass.name === "reference-host");
      expect(resumeStarted).toBe(clientClass.name !== "no-ui");
      await vi.waitFor(async () => {
        const status = await store.listRuns({ limit: 1 });
        expect(status.runs[0]?.status).toBe("completed");
      });
    } finally {
      await client.close();
      await closeServer();
      await runtime.close();
    }
  });
});

beforeAll(async () => {
  approvalHtml = await readFile(APPROVAL_HTML_PATH, "utf8");
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  await browser?.close();
});

afterEach(() => {
  vi.restoreAllMocks();
});
