// SPDX-License-Identifier: Apache-2.0
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type FrameLocator,
  type Page,
} from "playwright";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { createReferenceHost, type AppCall } from "@harness/host";
import {
  Code,
  FakeClock,
  Id,
  JsonValue,
  PiiConfigSchema,
  RunConfigSchema,
  SequentialIdGenerator,
  type Event as HarnessEvent,
} from "@harness/schemas";
import {
  createRuntime,
  type ModelCompletion,
  type ModelPort,
  type Runtime,
  type ToolPort,
} from "@harness/core";
import { applyApprovalEdits } from "@harness/policy";
import { InMemoryEventStore } from "@harness/store";
import {
  ApprovalPayloadSchema,
  ResolveRequest,
  RevealRequest,
  type ApprovalPayload,
} from "@harness/schemas/browser";

const runId = Id.parse("00000000000000000000000001");
const approvalId = Id.parse("00000000000000000000000002");
const resolveTool = "harness.approvals.resolve";
const revealTool = "harness.approvals.reveal";
const traceDirectory = join(process.cwd(), "reports", "playwright-traces");

type ApprovalLogEntry =
  | { readonly type: "approval_resolved"; readonly decision: "approve" | "deny" | "edit" }
  | { readonly type: "run_status_changed"; readonly status: "completed" }
  | { readonly type: "pii_action"; readonly boundary: "ui" };

interface FixtureOptions {
  readonly resolveUnavailable?: boolean;
  readonly resolveFailure?: boolean;
  readonly invalidEditOnce?: boolean;
  readonly runtimeBacked?: boolean;
  readonly installClock?: boolean;
}

interface ApprovalFixture {
  readonly page: Page;
  readonly frame: FrameLocator;
  readonly eventLog: ApprovalLogEntry[];
  readonly telemetry: unknown[];
  readonly appCalls: string[];
  readonly approvalId: string;
  readonly runtimeStatuses: string[];
  readonly waitForTelemetryBatch: (predicate: (batch: unknown) => boolean) => Promise<unknown>;
  readonly dropBridge: () => Promise<void>;
}

const basePayload: ApprovalPayload = {
  payloadVersion: 1,
  kind: "tool_call",
  callId: "00000000000000000000000003",
  toolId: "mail.send",
  ruleId: "mail.review",
  reason: "approval_required",
  summary: "Review the pending action",
  args: { email: "<EMAIL_1>" },
  ui: {
    resourceUri: "ui://harness/approval/v1",
    fallbackText: "Review this action in the command line.",
  },
  editableFields: [],
};

let browser: Browser | undefined;
let approvalHtml = "";

function createPayload(overrides: Partial<ApprovalPayload> = {}): ApprovalPayload {
  return ApprovalPayloadSchema.parse({ ...basePayload, ...overrides });
}

function toolResult(value: Record<string, unknown>, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
    ...(isError ? { isError: true } : {}),
  };
}

function modelCompletion(
  parts: ModelCompletion["parts"],
  finishReason: ModelCompletion["finishReason"],
): ModelCompletion {
  return {
    provider: "synthetic",
    model: "synthetic",
    parts,
    providerBlobs: null,
    usage: { inputTokens: 1, outputTokens: 1 },
    finishReason,
    latencyMs: 0,
    schemaValid: true,
    repairAttempts: 0,
    fallbackDepth: 0,
  };
}

async function createRuntimeApproval(
  payload: ApprovalPayload,
  options: FixtureOptions,
): Promise<{
  readonly runtime: Runtime;
  readonly runId: Id;
  readonly approvalId: Id;
  readonly payload: ApprovalPayload;
}> {
  const store = new InMemoryEventStore();
  const runtimeRunId = Id.parse("00000000000000000000000001");
  const toolId = Code.parse(payload.toolId);
  let modelCall = 0;
  const model: ModelPort = {
    complete: () => {
      modelCall += 1;
      return Promise.resolve(
        modelCall === 1
          ? modelCompletion(
              [
                {
                  type: "tool_call",
                  callId: Id.parse(payload.callId),
                  toolId,
                  args: JsonValue.parse(payload.args),
                },
              ],
              "tool_calls",
            )
          : modelCompletion([{ type: "text", text: "completed" }], "stop"),
      );
    },
  };
  let invalidEditReturned = false;
  const tool: ToolPort = {
    prepare: (call) => Promise.resolve(call),
    validateInputSchema: (_id, args) => {
      if (
        options.invalidEditOnce === true &&
        !invalidEditReturned &&
        typeof args === "object" &&
        args !== null &&
        !Array.isArray(args) &&
        args.count === 2
      ) {
        invalidEditReturned = true;
        return Promise.resolve(false);
      }
      return Promise.resolve(true);
    },
    describe: (id) =>
      id === toolId
        ? { idempotent: true, timeoutMs: 1_000, inputSchema: JsonValue.parse({ type: "object" }) }
        : undefined,
    execute: () => Promise.resolve({ outcome: "ok", result: { sent: true } }),
  };
  const runtime = await createRuntime(
    {
      run: RunConfigSchema.parse({ checkpointEveryEvents: 2 }),
      pii: PiiConfigSchema.parse({ enabled: false }),
    },
    {
      store,
      transientVault: true,
      clock: new FakeClock(1_000),
      ids: new SequentialIdGenerator(),
      model,
      tool,
      sandboxBackend: {
        exec: () => Promise.reject(new Error("Synthetic tool fixture does not execute commands.")),
      },
      policy: {
        version: Code.parse("approval_test"),
        decide: () => ({
          decision: "ask",
          ruleId: Code.parse(payload.ruleId),
          reason: Code.parse(payload.reason),
          editable: payload.editableFields,
        }),
      },
    },
  );
  const execution = runtime.start("Review the pending action", { runId: runtimeRunId });
  await execution.started;
  const suspended = await execution.completion;
  expect(suspended.status).toBe("suspended");
  const events: HarnessEvent[] = [];
  for await (const event of store.read(runtimeRunId)) {
    events.push(event);
  }
  const approval = events.find((event) => event.type === "approval_requested");
  if (approval?.type !== "approval_requested") {
    await runtime.close();
    throw new Error("The runtime did not persist an approval request.");
  }
  return {
    runtime,
    runId: runtimeRunId,
    approvalId: approval.approvalId,
    payload: ApprovalPayloadSchema.parse(approval.payload),
  };
}

async function withFixture(
  payload: ApprovalPayload,
  options: FixtureOptions,
  run: (fixture: ApprovalFixture) => Promise<void>,
): Promise<void> {
  if (browser === undefined) {
    throw new Error("Playwright browser was not initialized.");
  }
  const eventLog: ApprovalLogEntry[] = [];
  const telemetry: unknown[] = [];
  const appCalls: string[] = [];
  const runtimeStatuses: string[] = [];
  const telemetryWaiters = new Set<{
    readonly predicate: (batch: unknown) => boolean;
    readonly resolve: (batch: unknown) => void;
  }>();
  const waitForTelemetryBatch = (predicate: (batch: unknown) => boolean): Promise<unknown> => {
    const existing = telemetry.find(predicate);
    if (existing !== undefined) {
      return Promise.resolve(existing);
    }
    return new Promise((resolve) => {
      telemetryWaiters.add({ predicate, resolve });
    });
  };
  const runtimeFixture =
    options.runtimeBacked === true ? await createRuntimeApproval(payload, options) : undefined;
  const fixturePayload = runtimeFixture?.payload ?? payload;
  const fixtureApprovalId = runtimeFixture?.approvalId ?? approvalId;
  const fixtureRunId = runtimeFixture?.runId ?? runId;
  let invalidEditReturned = false;
  const allowedTools =
    options.resolveUnavailable === true ? [revealTool] : [resolveTool, revealTool];
  const host = await createReferenceHost(
    {
      apps: [
        {
          id: "approval-app",
          resourceUri: "ui://harness/approval/v1",
          telemetry: true,
          allowedTools,
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
      runId: fixtureRunId,
      hasPendingApproval: () => !eventLog.some((event) => event.type === "approval_resolved"),
      isIdOwnedByRun: () => true,
      toolInput: { approvalId: fixtureApprovalId, payload: fixturePayload },
      onAppCall: async (call: AppCall) => {
        appCalls.push(call.toolName);
        if (runtimeFixture !== undefined && call.toolName === resolveTool) {
          const request = ResolveRequest.safeParse(call.arguments);
          if (!request.success) {
            return toolResult({ ok: false, code: "edit_invalid" }, true);
          }
          try {
            const edits =
              request.data.edits === undefined
                ? undefined
                : applyApprovalEdits(
                    JsonValue.parse(runtimeFixture.payload.args),
                    request.data.edits,
                  );
            if (edits !== undefined && !edits.success) {
              return toolResult({ ok: false, code: "edit_invalid" }, true);
            }
            await runtimeFixture.runtime.resolveApproval(
              fixtureRunId,
              request.data.approvalId,
              request.data.decision,
              edits === undefined ? undefined : { edits: edits.args },
            );
            const resumed = await runtimeFixture.runtime.resume(fixtureRunId);
            runtimeStatuses.push(resumed.status);
          } catch (error) {
            const errorCode =
              typeof error === "object" && error !== null && "code" in error
                ? Code.safeParse(error.code)
                : undefined;
            return toolResult(
              {
                ok: false,
                code: errorCode?.success === true ? errorCode.data : "resolve_failed",
              },
              true,
            );
          }
          const events: HarnessEvent[] = [];
          for await (const event of runtimeFixture.runtime.store.read(fixtureRunId)) {
            events.push(event);
          }
          eventLog.splice(
            0,
            eventLog.length,
            ...events.flatMap((event): ApprovalLogEntry[] => {
              if (event.type === "approval_resolved") {
                return [{ type: "approval_resolved", decision: event.decision }];
              }
              if (event.type === "run_status_changed" && event.to === "completed") {
                return [{ type: "run_status_changed", status: "completed" }];
              }
              if (event.type === "pii_action" && event.boundary === "ui") {
                return [{ type: "pii_action", boundary: "ui" }];
              }
              return [];
            }),
          );
          return toolResult({ ok: true });
        }
        return handleAppCall(call, eventLog, options, () => {
          if (invalidEditReturned) {
            return false;
          }
          invalidEditReturned = true;
          return true;
        });
      },
      onTelemetryEmit: (_session, args) => {
        telemetry.push(args);
        for (const waiter of telemetryWaiters) {
          if (waiter.predicate(args)) {
            telemetryWaiters.delete(waiter);
            waiter.resolve(args);
          }
        }
        return Promise.resolve({ content: [] });
      },
    },
  );
  const hostState = { closed: false };
  const context: BrowserContext = await browser.newContext();
  const page = await context.newPage();
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  try {
    if (options.installClock === true) {
      await page.clock.install({ time: new Date(1_000) });
    }
    await page.goto(host.url, { waitUntil: "domcontentloaded" });
    const frame = page.frameLocator("iframe");
    await frame.locator("body").waitFor({ state: "visible", timeout: 10_000 });
    const actionButtons = frame.locator('nav[aria-label="Approval actions"] button');
    await actionButtons.first().waitFor({ state: "visible", timeout: 10_000 });
    expect(await actionButtons.count()).toBeGreaterThan(0);
    await waitForTelemetryBatch((batch) => telemetrySpanCount(batch) === 0);
    await run({
      page,
      frame,
      eventLog,
      telemetry,
      appCalls,
      approvalId: fixtureApprovalId,
      runtimeStatuses,
      waitForTelemetryBatch,
      dropBridge: async () => {
        hostState.closed = true;
        await host.close();
      },
    });
    await context.tracing.stop();
  } catch (error) {
    await mkdir(traceDirectory, { recursive: true });
    await context.tracing.stop({
      path: join(traceDirectory, `approval-app-${String(Date.now())}.zip`),
    });
    throw error;
  } finally {
    await context.close();
    if (!hostState.closed) {
      await host.close();
    }
    await runtimeFixture?.runtime.close();
  }
}

function handleAppCall(
  call: AppCall,
  eventLog: ApprovalLogEntry[],
  options: FixtureOptions,
  takeInvalidEdit: () => boolean,
): CallToolResult {
  if (call.toolName === resolveTool) {
    const request = ResolveRequest.safeParse(call.arguments);
    if (!request.success) {
      return toolResult({ ok: false, code: "edit_invalid" }, true);
    }
    if (options.resolveFailure === true) {
      return toolResult({ ok: false, code: "approval_already_resolved" }, true);
    }
    if (request.data.decision === "edit" && options.invalidEditOnce === true && takeInvalidEdit()) {
      return toolResult({ ok: false, code: "edit_invalid" }, true);
    }
    eventLog.push({ type: "approval_resolved", decision: request.data.decision });
    eventLog.push({ type: "run_status_changed", status: "completed" });
    return toolResult({ ok: true });
  }
  if (call.toolName === revealTool) {
    const request = RevealRequest.safeParse(call.arguments);
    if (!request.success) {
      return { content: [], isError: true };
    }
    eventLog.push({ type: "pii_action", boundary: "ui" });
    return toolResult({
      values: request.data.pointers.map((pointer) => ({
        pointer,
        value: "SYNTHETIC_REVEALED_CANARY@example.test",
      })),
    });
  }
  return { content: [], isError: true };
}

async function flushAppTelemetry(frame: FrameLocator): Promise<void> {
  await frame.locator("body").evaluate(() => {
    window.dispatchEvent(new Event("pagehide"));
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function telemetrySpanNames(batch: unknown): string[] {
  if (!isRecord(batch) || !Array.isArray(batch.spans)) {
    return [];
  }
  return batch.spans.flatMap((span: unknown): string[] => {
    if (!isRecord(span) || typeof span.name !== "string") {
      return [];
    }
    return [span.name];
  });
}

function telemetrySpanCount(batch: unknown): number {
  return telemetrySpanNames(batch).length;
}

async function expectSafeTelemetry(
  fixture: ApprovalFixture,
  expectedNames: readonly string[],
  canaries: readonly string[],
): Promise<void> {
  await fixture.waitForTelemetryBatch((batch) => telemetrySpanNames(batch).includes("ui.render"));
  await flushAppTelemetry(fixture.frame);
  await fixture.waitForTelemetryBatch((batch) =>
    telemetrySpanNames(batch).includes("ui.interaction"),
  );
  const names = fixture.telemetry.flatMap(telemetrySpanNames);
  expect(names).toEqual(expect.arrayContaining([...expectedNames]));
  const serialized = JSON.stringify(fixture.telemetry);
  for (const canary of canaries) {
    expect(serialized).not.toContain(canary);
  }
}

async function expectStatus(frame: FrameLocator, expected: string): Promise<void> {
  const status = frame.locator('[role="status"]').filter({ hasText: expected }).last();
  await status.waitFor();
  expect(await status.textContent()).toBe(expected);
}

beforeAll(async () => {
  approvalHtml = await readFile(
    join(process.cwd(), "packages", "approval-app", "dist", "approval.html"),
    "utf8",
  );
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  await browser?.close();
});

describe("approval app in the reference host", () => {
  it("approves and resumes the run", async () => {
    await withFixture(createPayload(), { runtimeBacked: true }, async (fixture) => {
      await fixture.frame.getByRole("button", { name: "Approve", exact: true }).click();
      await expectStatus(fixture.frame, "Approval granted.");
      expect(fixture.eventLog).toContainEqual({ type: "approval_resolved", decision: "approve" });
      expect(fixture.eventLog).toContainEqual({ type: "run_status_changed", status: "completed" });
      expect(fixture.runtimeStatuses).toEqual(["completed"]);
    });
  }, 30_000);

  it("denies and resumes the run", async () => {
    await withFixture(createPayload(), { runtimeBacked: true }, async (fixture) => {
      await fixture.frame.getByRole("button", { name: "Deny", exact: true }).click();
      await expectStatus(fixture.frame, "Approval denied.");
      expect(fixture.eventLog).toContainEqual({ type: "approval_resolved", decision: "deny" });
      expect(fixture.eventLog).toContainEqual({ type: "run_status_changed", status: "completed" });
      expect(fixture.runtimeStatuses).toEqual(["completed"]);
    });
  }, 30_000);

  it("shows the server edit validation code and accepts a valid retry", async () => {
    const payload = createPayload({
      args: { count: 1 },
      editableFields: ["/count"],
    });
    await withFixture(payload, { invalidEditOnce: true, runtimeBacked: true }, async (fixture) => {
      await fixture.frame.getByRole("button", { name: "Edit", exact: true }).click();
      const count = fixture.frame.locator("#approval-edit-0");
      await count.fill("2");
      await count.press("Enter");
      await expectStatus(fixture.frame, "The edited values are invalid.");
      expect(await count.isDisabled()).toBe(false);
      await count.press("Enter");
      await expectStatus(fixture.frame, "Edits submitted.");
      expect(fixture.eventLog).toContainEqual({ type: "approval_resolved", decision: "edit" });
      expect(fixture.eventLog).toContainEqual({ type: "run_status_changed", status: "completed" });
      expect(fixture.runtimeStatuses).toEqual(["completed"]);
    });
  }, 30_000);

  it("reveals only after confirmation and records the UI audit event", async () => {
    await withFixture(createPayload(), { installClock: true }, async (fixture) => {
      await fixture.frame.getByRole("button", { name: "Reveal values" }).click();
      expect(fixture.appCalls).not.toContain(revealTool);
      expect(fixture.eventLog).not.toContainEqual({ type: "pii_action", boundary: "ui" });
      await fixture.frame.getByRole("button", { name: "Cancel", exact: true }).click();
      expect(fixture.appCalls).not.toContain(revealTool);
      expect(fixture.eventLog).not.toContainEqual({ type: "pii_action", boundary: "ui" });
      await fixture.frame.getByRole("button", { name: "Reveal values" }).click();
      await fixture.frame.getByRole("button", { name: "Show raw values" }).click();
      await fixture.frame
        .getByText("SYNTHETIC_REVEALED_CANARY@example.test", { exact: false })
        .waitFor();
      expect(fixture.eventLog).toContainEqual({ type: "pii_action", boundary: "ui" });
      expect(fixture.appCalls.filter((name) => name === revealTool)).toHaveLength(1);
      await fixture.page.clock.fastForward(30_000);
      await fixture.frame.getByText("<EMAIL_1>", { exact: true }).waitFor();
      await expectSafeTelemetry(
        fixture,
        ["ui.render", "ui.interaction"],
        ["SYNTHETIC_REVEALED_CANARY@example.test"],
      );
    });
  }, 30_000);

  it("disables actions for an expired approval", async () => {
    await withFixture(createPayload({ expiresAt: 0 }), {}, async (fixture) => {
      const buttons = fixture.frame.locator('nav[aria-label="Approval actions"] button');
      expect(await buttons.count()).toBeGreaterThan(0);
      for (const button of await buttons.all()) {
        expect(await button.isDisabled()).toBe(true);
      }
      expect(fixture.eventLog).toEqual([]);
    });
  }, 30_000);

  it("shows the server failure by code without recording a decision", async () => {
    await withFixture(createPayload(), { resolveFailure: true }, async (fixture) => {
      await fixture.frame.getByRole("button", { name: "Approve", exact: true }).click();
      await fixture.frame
        .getByText("This approval has already been resolved.", { exact: true })
        .waitFor();
      expect(fixture.eventLog).toEqual([]);
    });
  }, 30_000);

  it("renders hostile payloads as text and keeps canaries out of telemetry", async () => {
    const xss = '<img src=x onerror="window.__approvalXss=true">';
    await withFixture(
      createPayload({
        summary: xss,
        args: { hostile: xss, canary: "SYNTHETIC_UI_TELEMETRY_CANARY" },
      }),
      {},
      async (fixture) => {
        await fixture.frame.locator("h1").click();
        expect(await fixture.frame.locator("img").count()).toBe(0);
        expect(await fixture.frame.locator("body").textContent()).toContain(xss);
        expect(await fixture.frame.locator("body").evaluate(() => "__approvalXss" in window)).toBe(
          false,
        );
        await expectSafeTelemetry(
          fixture,
          ["ui.render", "ui.interaction"],
          ["SYNTHETIC_UI_TELEMETRY_CANARY", "<img"],
        );
      },
    );
  }, 30_000);

  it("shows CLI instructions and disables actions when resolve is unavailable", async () => {
    await withFixture(
      createPayload(),
      { resolveUnavailable: true, installClock: true },
      async (fixture) => {
        await fixture.frame
          .getByRole("button", { name: "Approve", exact: true })
          .click({ timeout: 5_000 });
        await fixture.frame
          .getByText("Review this action in the command line.", { exact: true })
          .waitFor({ timeout: 5_000 });
        expect(await fixture.frame.locator('[aria-label="Approve command"]').inputValue()).toBe(
          `harness approvals approve ${fixture.approvalId}`,
        );
        for (const button of await fixture.frame
          .locator('nav[aria-label="Approval actions"] button')
          .all()) {
          expect(await button.isDisabled()).toBe(true);
        }
        expect(fixture.eventLog).toEqual([]);
        await fixture.dropBridge();
        await fixture.page.clock.fastForward(6_000);
        await fixture.frame
          .getByText("Review this action in the command line.", { exact: true })
          .waitFor();
        expect(await fixture.frame.locator('[aria-label="Approve command"]').inputValue()).toBe(
          `harness approvals approve ${fixture.approvalId}`,
        );
        expect(
          await fixture.frame.getByRole("button", { name: "Approve", exact: true }).isDisabled(),
        ).toBe(true);
      },
    );
  }, 30_000);
});
