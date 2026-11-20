// SPDX-License-Identifier: Apache-2.0
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, type Browser, type FrameLocator, type Page } from "playwright";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { createReferenceHost } from "@rovinos/host";
import { ApprovalPayloadSchema, Code, Id, type ApprovalPayload } from "@rovinos/schemas";

const fixedTime = 1_800_000_000_000;
const runId = Id.parse("00000000000000000000000001");
const approvalId = Id.parse("00000000000000000000000002");
const sessionId = "00000000000000000000000004";
const appId = Code.parse("approval-app");
const resourceUri = "ui://harness/approval/v1";
const outputNames = [
  "approval-pending.png",
  "approval-edit.png",
  "approval-reveal-confirmation.png",
  "approval-expired.png",
  "approval-fallback.png",
] as const;

interface ApprovalPage {
  readonly page: Page;
  readonly frame: FrameLocator;
  readonly disconnectBridge: () => Promise<void>;
  close(): Promise<void>;
}

function createPayload(overrides: Partial<ApprovalPayload> = {}): ApprovalPayload {
  return ApprovalPayloadSchema.parse({
    payloadVersion: 1,
    kind: "tool_call",
    callId: "00000000000000000000000003",
    toolId: "mail.send",
    ruleId: "mail.review",
    reason: "approval_required",
    summary: "Review the synthetic message",
    args: { recipient: "<EMAIL_1>", subject: "Synthetic demo message" },
    editableFields: [],
    expiresAt: fixedTime + 15 * 60_000,
    ui: {
      resourceUri,
      fallbackText: "Review this action in the command line.",
    },
    ...overrides,
  });
}

function inlineAppContent(document: string): string {
  // The reference host supplies the document shell, so only the built app's inline assets belong here.
  const styleStart = document.indexOf("<style>");
  const styleEnd = document.indexOf("</style>", styleStart);
  const scriptStart = document.indexOf("<script>", styleEnd);
  const scriptEnd = document.indexOf("</script>", scriptStart);
  if (styleStart < 0 || styleEnd < 0 || scriptStart < 0 || scriptEnd < 0) {
    throw new Error("approval_screenshots_app_invalid");
  }
  return `${document.slice(styleStart, styleEnd + "</style>".length)}${document.slice(
    scriptStart,
    scriptEnd + "</script>".length,
  )}`;
}

async function openApprovalPage(browser: Browser, payload: ApprovalPayload): Promise<ApprovalPage> {
  const approvalDocument = await readFile(
    resolve(
      fileURLToPath(new URL("../../packages/approval-app/dist/approval.html", import.meta.url)),
    ),
    "utf8",
  );
  const approvalHtml = inlineAppContent(approvalDocument);
  const host = await createReferenceHost(
    {
      apps: [
        {
          id: appId,
          resourceUri,
          telemetry: true,
          allowedTools: [
            Code.parse("harness.approvals.resolve"),
            Code.parse("harness.approvals.reveal"),
          ],
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
      idGenerator: () => sessionId,
      now: () => fixedTime,
      runId,
      hasPendingApproval: () => true,
      isIdOwnedByRun: () => true,
      toolInput: { approvalId, payload },
      onAppCall: () =>
        Promise.resolve<CallToolResult>({
          content: [{ type: "text", text: '{"ok":true}' }],
          structuredContent: { ok: true },
        }),
    },
  );
  const context = await browser.newContext({
    colorScheme: "light",
    deviceScaleFactor: 1,
    locale: "en-US",
    reducedMotion: "reduce",
    timezoneId: "UTC",
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();
  await page.clock.install({ time: new Date(fixedTime) });
  await page.goto(host.url, { waitUntil: "domcontentloaded" });
  const frame = page.frameLocator("iframe");
  await frame.locator('nav[aria-label="Approval actions"] button').first().waitFor();

  let hostClosed = false;
  return {
    page,
    frame,
    disconnectBridge: async () => {
      if (!hostClosed) {
        await host.close();
        hostClosed = true;
      }
      await page.evaluate(() => {
        const appWindow = document.querySelector("iframe")?.contentWindow;
        if (appWindow === null || appWindow === undefined) {
          throw new Error("approval_demo_frame_missing");
        }
        appWindow.postMessage(
          { jsonrpc: "2.0", id: "bridge-drop", method: "ui/resource-teardown", params: {} },
          "*",
        );
      });
    },
    close: async () => {
      await context.close();
      if (!hostClosed) {
        await host.close();
        hostClosed = true;
      }
    },
  };
}

interface CaptureOptions {
  readonly browser: Browser;
  readonly outputDirectory: string;
  readonly filename: (typeof outputNames)[number];
  readonly payload: ApprovalPayload;
  readonly prepare?: (fixture: ApprovalPage) => Promise<void>;
}

async function capture({
  browser,
  outputDirectory,
  filename,
  payload,
  prepare,
}: CaptureOptions): Promise<void> {
  const fixture = await openApprovalPage(browser, payload);
  try {
    await prepare?.(fixture);
    await fixture.page.screenshot({
      path: join(outputDirectory, filename),
      fullPage: true,
    });
  } finally {
    await fixture.close();
  }
}

/** Generates reproducible approval-app screenshots using the built app and synthetic fixture data. */
export async function generateApprovalScreenshots(outputDirectory: string): Promise<void> {
  const directory = resolve(outputDirectory);
  const htmlPath = resolve(
    fileURLToPath(new URL("../../packages/approval-app/dist/approval.html", import.meta.url)),
  );
  await readFile(htmlPath, "utf8");
  await mkdir(directory, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    await capture({
      browser,
      outputDirectory: directory,
      filename: outputNames[0],
      payload: createPayload(),
    });
    await capture({
      browser,
      outputDirectory: directory,
      filename: outputNames[1],
      payload: createPayload({
        args: { count: 1 },
        editableFields: ["/count"],
      }),
      prepare: async ({ frame }) => {
        await frame.getByRole("button", { name: "Edit", exact: true }).click();
        await frame.getByRole("heading", { name: "Edit approval" }).waitFor();
      },
    });
    await capture({
      browser,
      outputDirectory: directory,
      filename: outputNames[2],
      payload: createPayload(),
      prepare: async ({ frame }) => {
        await frame.getByRole("button", { name: "Reveal values" }).click();
        await frame.getByRole("button", { name: "Show raw values" }).waitFor();
      },
    });
    await capture({
      browser,
      outputDirectory: directory,
      filename: outputNames[3],
      payload: createPayload({ expiresAt: 0 }),
    });
    await capture({
      browser,
      outputDirectory: directory,
      filename: outputNames[4],
      payload: createPayload(),
      prepare: async ({ disconnectBridge, frame, page }) => {
        await disconnectBridge();
        await page.clock.fastForward(6_000);
        await frame.locator('section[aria-labelledby="approval-fallback-heading"]').waitFor({
          state: "visible",
        });
      },
    });
  } finally {
    await browser.close();
  }
}

function outputDirectoryFromArgs(args: readonly string[]): string {
  const index = args.indexOf("--output-dir");
  if (index < 0) {
    return resolve(dirname(fileURLToPath(import.meta.url)), "../../docs/images");
  }
  const directory = args[index + 1];
  if (directory === undefined || directory.startsWith("--")) {
    throw new Error("approval_screenshots_output_invalid");
  }
  return resolve(directory);
}

async function main(): Promise<void> {
  try {
    const directory = outputDirectoryFromArgs(process.argv.slice(2));
    await generateApprovalScreenshots(directory);
    process.stdout.write(`Generated ${String(outputNames.length)} approval screenshots.\n`);
  } catch {
    process.stderr.write("approval_screenshots_failed\n");
    process.exitCode = 1;
  }
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  await main();
}
