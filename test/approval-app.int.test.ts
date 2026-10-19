// SPDX-License-Identifier: Apache-2.0
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type FrameLocator, type Page } from "playwright";
import { createReferenceHost, type AppCall } from "@harness/host";
import {
  ApprovalPayloadSchema,
  Id,
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
  readonly dropBridge?: boolean;
}

interface ApprovalFixture {
  readonly page: Page;
  readonly frame: FrameLocator;
  readonly eventLog: ApprovalLogEntry[];
  readonly telemetry: unknown[];
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

function toolResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
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
  let invalidEditReturned = false;
  const allowedTools = options.resolveUnavailable
    ? [revealTool]
    : [resolveTool, revealTool];
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
      runId,
      hasPendingApproval: () => !eventLog.some((event) => event.type === "approval_resolved"),
      isIdOwnedByRun: () => true,
      toolInput: { approvalId, payload },
      onAppCall: async (call: AppCall) => handleAppCall(call, eventLog, options, () => {
        if (invalidEditReturned) {
          return false;
        }
        invalidEditReturned = true;
        return true;
      }),
      onTelemetryEmit: async (_session, args) => {
        telemetry.push(args);
        return { content: [] };
      },
    },
  );
  const context: BrowserContext = await browser.newContext();
  const page = await context.newPage();
  if (options.dropBridge) {
    await page.route("**/api/events**", (route) => route.abort());
  }
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  try {
    await page.goto(host.url, { waitUntil: "domcontentloaded" });
    const frame = page.frameLocator("iframe");
    await frame.locator("body").waitFor({ state: "visible", timeout: 10_000 });
    await run({ page, frame, eventLog, telemetry });
    await context.tracing.stop();
  } catch (error) {
    await mkdir(traceDirectory, { recursive: true });
    await context.tracing.stop({
      path: join(traceDirectory, `approval-app-${String(Date.now())}.zip`),
    });
    throw error;
  } finally {
    await context.close();
    await host.close();
  }
}

async function handleAppCall(
  call: AppCall,
  eventLog: ApprovalLogEntry[],
  options: FixtureOptions,
  takeInvalidEdit: () => boolean,
) {
  if (call.toolName === resolveTool) {
    const request = ResolveRequest.safeParse(call.arguments);
    if (!request.success) {
      return toolResult({ ok: false, code: "edit_invalid" });
    }
    if (options.resolveFailure) {
      return toolResult({ ok: false, code: "approval_already_resolved" });
    }
    if (request.data.decision === "edit" && options.invalidEditOnce && takeInvalidEdit()) {
      return toolResult({ ok: false, code: "edit_invalid" });
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

function expectRunResumed(fixture: ApprovalFixture, decision: "approve" | "deny" | "edit"): void {
  expect(fixture.eventLog).toContainEqual({ type: "approval_resolved", decision });
  expect(fixture.eventLog).toContainEqual({
    type: "run_status_changed",
    status: "completed",
  });
}

async function flushAppTelemetry(frame: FrameLocator): Promise<void> {
  await frame.locator("body").evaluate(() => {
    window.dispatchEvent(new Event("pagehide"));
  });
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
    await withFixture(createPayload(), {}, async (fixture) => {
      await fixture.frame.getByRole("button", { name: "Approve", exact: true }).click();
      await fixture.frame.getByText("Approval granted.", { exact: true }).waitFor();
      expectRunResumed(fixture, "approve");
    });
  }, 30_000);

  it("denies and resumes the run", async () => {
    await withFixture(createPayload(), {}, async (fixture) => {
      await fixture.frame.getByRole("button", { name: "Deny", exact: true }).click();
      await fixture.frame.getByText("Approval denied.", { exact: true }).waitFor();
      expectRunResumed(fixture, "deny");
    });
  }, 30_000);

  it("shows the server edit validation code and accepts a valid retry", async () => {
    const payload = createPayload({
      args: { count: 1 },
      editableFields: ["/count"],
    });
    await withFixture(payload, { invalidEditOnce: true }, async (fixture) => {
      await fixture.frame.getByRole("button", { name: "Edit", exact: true }).click();
      await fixture.frame.locator("#approval-edit-0").fill("2");
      await fixture.frame.getByRole("button", { name: "Submit edits" }).click();
      await fixture.frame.getByText("The edited values are invalid.", { exact: true }).waitFor();
      await fixture.frame.getByRole("button", { name: "Submit edits" }).click();
      await fixture.frame.getByText("Edits submitted.", { exact: true }).waitFor();
      expectRunResumed(fixture, "edit");
    });
  }, 30_000);

  it("reveals only after confirmation and records the UI audit event", async () => {
    await withFixture(createPayload(), {}, async (fixture) => {
      await fixture.frame.getByRole("button", { name: "Reveal values" }).click();
      await fixture.frame.getByRole("button", { name: "Show raw values" }).click();
      await fixture.frame
        .getByText("SYNTHETIC_REVEALED_CANARY@example.test", { exact: false })
        .waitFor();
      expect(fixture.eventLog).toContainEqual({ type: "pii_action", boundary: "ui" });
      await flushAppTelemetry(fixture.frame);
      expect(JSON.stringify(fixture.telemetry)).not.toContain("SYNTHETIC_REVEALED_CANARY");
    });
  }, 30_000);

  it("disables actions for an expired approval", async () => {
    await withFixture(createPayload({ expiresAt: 0 }), {}, async (fixture) => {
      for (const button of await fixture.frame.getByRole("button").all()) {
        expect(await button.isDisabled()).toBe(true);
      }
      expect(fixture.eventLog).toEqual([]);
    });
  }, 30_000);

  it("shows the server failure by code without recording a decision", async () => {
    await withFixture(createPayload(), { resolveFailure: true }, async (fixture) => {
      await fixture.frame.getByRole("button", { name: "Approve", exact: true }).click();
      await fixture.frame.getByText("This approval has already been resolved.", { exact: true }).waitFor();
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
        expect(await fixture.frame.locator("img").count()).toBe(0);
        expect(await fixture.frame.locator("body").textContent()).toContain(xss);
        expect(
          await fixture.frame.locator("body").evaluate(() => Reflect.get(window, "__approvalXss")),
        ).toBeUndefined();
        await flushAppTelemetry(fixture.frame);
        expect(JSON.stringify(fixture.telemetry)).not.toContain("SYNTHETIC_UI_TELEMETRY_CANARY");
        expect(JSON.stringify(fixture.telemetry)).not.toContain("<img");
      },
    );
  }, 30_000);

  it("shows CLI instructions and disables actions when resolve is unavailable", async () => {
    await withFixture(createPayload(), { resolveUnavailable: true }, async (fixture) => {
      await fixture.frame.getByRole("button", { name: "Approve", exact: true }).click();
      await fixture.frame
        .getByText("Review this action in the command line.", { exact: true })
        .waitFor();
      expect(
        await fixture.frame.locator('[aria-label="Approve command"]').inputValue(),
      ).toBe(`harness approvals approve ${approvalId}`);
      for (const button of await fixture.frame.getByRole("button").all()) {
        expect(await button.isDisabled()).toBe(true);
      }
      expect(fixture.eventLog).toEqual([]);
    });
  }, 30_000);

  it("shows fallback instructions after the host bridge drops", async () => {
    await withFixture(createPayload(), { dropBridge: true }, async (fixture) => {
      await fixture.frame.getByText("Waiting for host...", { exact: true }).waitFor();
      await fixture.frame
        .getByText("The host bridge is unavailable.", { exact: false })
        .waitFor({ timeout: 6_000 });
      expect(await fixture.frame.locator('[aria-label="Approve command"]').inputValue()).toBe(
        "harness approvals approve <id>",
      );
    });
  }, 30_000);
});
