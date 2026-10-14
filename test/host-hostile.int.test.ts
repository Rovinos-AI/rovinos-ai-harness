// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { metrics, type SpanContext } from "@opentelemetry/api";
import { Id, type VaultValueEntry } from "@harness/schemas";
import { type VaultRunReader } from "@harness/telemetry";
import { createTestMetricCollector } from "@harness/telemetry/testing";
import { createReferenceHost, type ReferenceHost } from "@harness/host";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { createCanaries, type CanarySet } from "./canary/canaries.js";
import { createCanaryTelemetry, type CanaryTelemetry } from "./canary/telemetry.js";

declare global {
  interface Window {
    refillHostBatchWindow?: () => Promise<void>;
  }
}

const runId = Id.parse("00000000000000000000000001");
const oldSessionId = Id.parse("00000000000000000000000002");
const parentContext: SpanContext = {
  traceId: "f".repeat(32),
  spanId: "e".repeat(16),
  traceFlags: 1,
};
const validSpanNames = new Set([
  "harness.ui_session",
  "harness.ui.render",
  "harness.ui.decision",
  "harness.ui.error",
  "harness.ui.interaction",
]);
const metricCollector = createTestMetricCollector();
const traceDirectory = join(process.cwd(), "reports", "playwright-traces");

let browser: Browser | undefined;
let telemetry: CanaryTelemetry | undefined;
let currentVaultVersion = 0;
let currentVaultEntries: readonly VaultValueEntry[] = [];

const vaultReader: VaultRunReader = {
  listRawValueEntries: (requestedRunId) =>
    Promise.resolve(requestedRunId === runId ? currentVaultEntries : []),
  version: (requestedRunId) => Promise.resolve(requestedRunId === runId ? currentVaultVersion : 0),
};

interface MetricSnapshot {
  readonly accepted: number;
  readonly rejected: ReadonlyMap<string, number>;
}

interface FixtureEvidence {
  readonly status: string;
  readonly spans: CanaryTelemetry["spans"];
  readonly rejected: ReadonlyMap<string, number>;
  readonly accepted: number;
  readonly canaries: CanarySet;
  readonly page: Page;
  readonly hostOrigin: string;
  readonly externalRequests: readonly string[];
  readonly routedExternalRequests: readonly string[];
  readonly externalResponses: readonly string[];
  readonly popups: readonly string[];
  readonly routedTools: readonly string[];
  readonly diagnostics: readonly string[];
  readonly browserConsole: readonly string[];
  readonly stdout: string;
}

type FixtureAssertion = (evidence: FixtureEvidence) => void | Promise<void>;

const bootstrap = `
  const status = document.createElement("pre");
  status.id = "hostile-status";
  document.body.append(status);
  const pending = new Map();
  let nextId = 1;
  let started = false;
  let initialized = false;
  let pendingInput;
  const responses = [];
  const finish = (result) => {
    status.textContent = JSON.stringify({ done: true, result: result ?? null, responses });
  };
  const startAttack = (input) => {
    pendingInput = input;
    if (!initialized || started) {
      return;
    }
    started = true;
    setTimeout(() => {
      Promise.resolve(window.hostileAttack({ input, call, emit }))
        .then(finish)
        .catch(() => finish({ failed: true }));
    }, 0);
  };
  const call = (name, args) => new Promise((resolve) => {
    const id = ++nextId;
    pending.set(id, resolve);
    window.parent.postMessage({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args }
    }, "*");
  });
  const emit = (spans, extra = {}) =>
    call("harness.telemetry.emit", { ...extra, spans });
  window.addEventListener("message", (event) => {
    const message = event.data;
    if (message?.id === 1 && message.result !== undefined) {
      initialized = true;
      window.parent.postMessage({
        jsonrpc: "2.0",
        method: "ui/notifications/initialized",
        params: {}
      }, "*");
      if (pendingInput !== undefined) {
        startAttack(pendingInput);
      }
      return;
    }
    if (typeof message?.id === "number" && pending.has(message.id)) {
      responses.push({
        id: message.id,
        error: message.error !== undefined,
        isError: message.result?.isError === true
      });
      pending.get(message.id)(message);
      pending.delete(message.id);
      return;
    }
    if (message?.method === "ui/notifications/tool-input") {
      startAttack(message.params.arguments);
    }
  });
  setTimeout(() => window.parent.postMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "ui/initialize",
      params: {
        protocolVersion: "2026-01-26",
        appInfo: { name: "hostile-app", version: "1" },
        appCapabilities: {}
      }
    }, "*"), 0);
`;

function getMetricSnapshot(): MetricSnapshot {
  const latest = metricCollector.getMetrics().at(-1);
  const rejected = new Map<string, number>();
  let accepted = 0;
  if (latest === undefined) {
    return { accepted, rejected };
  }
  for (const scope of latest.scopeMetrics) {
    for (const metric of scope.metrics) {
      for (const point of metric.dataPoints) {
        if (typeof point.value !== "number") {
          continue;
        }
        if (metric.descriptor.name === "harness.host.app_spans_accepted") {
          accepted += point.value;
        }
        if (metric.descriptor.name === "harness.host.app_rejected") {
          const reason = point.attributes["harness.host.app_rejected.reason"];
          if (typeof reason === "string") {
            rejected.set(reason, point.value);
          }
        }
      }
    }
  }
  return { accepted, rejected };
}

async function flushMetrics(): Promise<MetricSnapshot> {
  await metricCollector.forceFlush();
  return getMetricSnapshot();
}

function metricDelta(before: MetricSnapshot, after: MetricSnapshot): MetricSnapshot {
  const reasons = new Set([...before.rejected.keys(), ...after.rejected.keys()]);
  const rejected = new Map(
    [...reasons].map((reason) => [
      reason,
      (after.rejected.get(reason) ?? 0) - (before.rejected.get(reason) ?? 0),
    ]),
  );
  return {
    accepted: after.accepted - before.accepted,
    rejected,
  };
}

async function waitForFixture(page: Page): Promise<string> {
  const status = page.frameLocator("iframe").locator("#hostile-status");
  await status.waitFor({ state: "visible", timeout: 10_000 });
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const text = await status.textContent();
    if (text?.includes('"done":true') === true) {
      return text;
    }
    await page.waitForTimeout(50);
  }
  throw new Error("The hostile app fixture did not finish.");
}

async function runFixture(
  filename: string,
  assertion: FixtureAssertion,
  options: { readonly secondApp?: boolean } = {},
): Promise<void> {
  const currentTelemetry = telemetry;
  const currentBrowser = browser;
  if (currentTelemetry === undefined || currentBrowser === undefined) {
    throw new Error("Hostile app integration setup is unavailable.");
  }
  const canaries = createCanaries(randomUUID());
  currentVaultEntries = canaries.all.map(({ entityType, value }) => ({
    entityType,
    rawValue: value,
  }));
  currentVaultVersion += 1;
  const baseline = await flushMetrics();
  const firstSpanIndex = currentTelemetry.spans.length;
  const firstLogIndex = currentTelemetry.logs.length;
  const diagnostics: string[] = [];
  const routedTools: string[] = [];
  const externalRequests: string[] = [];
  const routedExternalRequests: string[] = [];
  const externalResponses: string[] = [];
  const popups: string[] = [];
  const browserConsole: string[] = [];
  const stdoutSpy = vi.spyOn(process.stdout, "write");
  const context: BrowserContext = await currentBrowser.newContext();
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  let host: ReferenceHost | undefined;
  const isFloodFixture = filename === "flood.html";
  let hostNow = Date.now();

  try {
    const fixturePath = new URL(`./fixtures/hostile-app/${filename}`, import.meta.url);
    const fixture = await readFile(fixturePath, "utf8");
    const html = fixture.replace("</body>", `<script>${bootstrap}</script></body>`);
    if (html === fixture) {
      throw new Error("The hostile app fixture has no closing body element.");
    }
    const resourceUri = `ui://hostile/${filename}`;
    let nextId = 0;
    host = await createReferenceHost(
      {
        apps: [
          {
            id: "hostile_app",
            resourceUri,
            telemetry: true,
            allowedTools: [],
          },
          ...(options.secondApp === true
            ? [
                {
                  id: "other_app",
                  resourceUri: "ui://other/fixture",
                  telemetry: true,
                  allowedTools: ["another.app_tool"],
                },
              ]
            : []),
        ],
        listen: { host: "127.0.0.1", port: 0 },
      },
      {
        onCode: (code) => diagnostics.push(code),
        onAppRejected: (reason) => diagnostics.push(reason),
        onAppCall: (call) => {
          routedTools.push(call.toolName);
          return Promise.resolve({ content: [] });
        },
        readResource: () =>
          Promise.resolve({
            contents: [{ mimeType: "text/html;profile=mcp-app", text: html }],
          }),
        idGenerator: () => String(++nextId).padStart(26, "0"),
        now: isFloodFixture ? () => hostNow : Date.now,
        uiSessionContext: {
          runId,
          toolCallSpanContext: parentContext,
        },
        toolInput: {
          runId,
          sessionId: runId,
          canary: canaries.email.value,
          oldSessionId,
        },
      },
    );
    const page = await context.newPage();
    page.on("request", (request) => {
      const hostname = new URL(request.url()).hostname;
      if (!["127.0.0.1", "[::1]", "localhost"].includes(hostname)) {
        externalRequests.push(request.url());
      }
    });
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (!["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)) {
        routedExternalRequests.push(url.href);
        await route.abort();
        return;
      }
      await route.continue();
    });
    page.on("response", (response) => {
      const hostname = new URL(response.url()).hostname;
      if (!["127.0.0.1", "[::1]", "localhost"].includes(hostname)) {
        externalResponses.push(response.url());
      }
    });
    page.on("popup", (popup) => popups.push(popup.url()));
    page.on("console", (message) => browserConsole.push(message.text()));
    if (isFloodFixture) {
      await page.exposeFunction("refillHostBatchWindow", () => {
        hostNow += 2_000;
      });
      await page.addInitScript(() => {
        if (window !== window.top) {
          return;
        }
        window.addEventListener("message", (event) => {
          const data: unknown = event.data;
          if (
            data === null ||
            typeof data !== "object" ||
            !("type" in data) ||
            data.type !== "hostile:flood-drained"
          ) {
            return;
          }
          const frame = document.querySelector("iframe");
          if (frame === null) {
            return;
          }
          const refillHostBatchWindow = window.refillHostBatchWindow;
          if (refillHostBatchWindow === undefined) {
            return;
          }
          void refillHostBatchWindow().then(() => {
            frame.contentWindow?.postMessage({ type: "hostile:rate-window-refilled" }, "*");
          });
        });
      });
    }
    await page.goto(host.url, { waitUntil: "domcontentloaded" });
    const status = await waitForFixture(page);

    const hostOrigin = host.origin;
    await host.close();
    host = undefined;
    await currentTelemetry.sdk.forceFlush();
    const currentMetrics = await flushMetrics();
    const spans = currentTelemetry.spans.slice(firstSpanIndex);
    expect(spans.every((span) => validSpanNames.has(span.name))).toBe(true);
    const stdout = stdoutSpy.mock.calls
      .map(([chunk]) => (typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")))
      .join("");
    const output = JSON.stringify({
      spans,
      logs: currentTelemetry.logs.slice(firstLogIndex),
      metrics: metricCollector.getMetrics(),
      diagnostics,
      stdout,
      browserConsole,
      status,
    });
    for (const canary of canaries.strings) {
      expect(output).not.toContain(canary);
    }
    await assertion({
      status,
      spans,
      accepted: currentMetrics.accepted - baseline.accepted,
      rejected: metricDelta(baseline, currentMetrics).rejected,
      canaries,
      page,
      hostOrigin,
      externalRequests,
      routedExternalRequests,
      externalResponses,
      popups,
      routedTools,
      diagnostics,
      browserConsole,
      stdout,
    });
    await context.tracing.stop();
  } catch (error) {
    await context.tracing
      .stop({
        path: join(traceDirectory, `${filename.replace(".html", "")}.zip`),
      })
      .catch(() => undefined);
    throw error;
  } finally {
    if (host !== undefined) {
      await host.close();
    }
    await currentTelemetry.sdk.forceFlush();
    await flushMetrics();
    await context.close();
    stdoutSpy.mockRestore();
  }
}

function expectErrorCode(spans: CanaryTelemetry["spans"], code: string): void {
  expect(
    spans.some(
      (span) => span.name === "harness.ui.error" && span.attributes["harness.error.code"] === code,
    ),
  ).toBe(true);
}

describe("hostile MCP App integration", () => {
  beforeAll(async () => {
    await mkdir(traceDirectory, { recursive: true });
    if (!metrics.setGlobalMeterProvider(metricCollector.provider)) {
      throw new Error("The hostile app test metrics provider could not be registered.");
    }
    telemetry = createCanaryTelemetry(vaultReader);
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await browser?.close();
    if (telemetry !== undefined) {
      telemetry.unsafeSpanCleanup();
      await telemetry.sdk.forceFlush();
      await Promise.all([
        telemetry.sdk.tracerProvider.shutdown(),
        telemetry.sdk.loggerProvider.shutdown(),
      ]);
    }
    await metricCollector.provider.shutdown();
  });

  it("rejects a 100 KiB telemetry request and counts the size limit", async () => {
    await runFixture("oversized-batch.html", ({ rejected, spans }) => {
      expect(rejected.get("size")).toBe(1);
      expectErrorCode(spans, "oversized_batch_blocked");
    });
  }, 60_000);

  it("rejects app-supplied identity attributes and counts the schema violation", async () => {
    await runFixture("spoofed-attributes.html", ({ rejected, spans }) => {
      expect(rejected.get("schema")).toBe(1);
      expect(spans.some((span) => span.name === "harness.ui.render")).toBe(false);
      expectErrorCode(spans, "spoofed_attributes_blocked");
    });
  }, 60_000);

  it("drops a 10 KiB canary field from every exported sink", async () => {
    await runFixture("canary-stuffed.html", ({ rejected, spans }) => {
      expect(rejected.get("schema")).toBe(1);
      expectErrorCode(spans, "canary_field_blocked");
    });
  }, 60_000);

  it("counts and drops unknown app span names", async () => {
    await runFixture("unknown-span.html", ({ rejected, spans }) => {
      expect(rejected.get("unknown_span")).toBe(1);
      expectErrorCode(spans, "unknown_span_blocked");
    });
  }, 60_000);

  it("contains a one-second flood and accepts legitimate traffic afterward", async () => {
    await runFixture("flood.html", ({ accepted, rejected, spans }) => {
      expect(rejected.get("rate")).toBeGreaterThan(0);
      expect(accepted).toBeGreaterThan(0);
      expectErrorCode(spans, "flood_complete");
    });
  }, 90_000);

  it("rejects filesystem and another app's tools", async () => {
    await runFixture(
      "forbidden-tools.html",
      ({ rejected, routedTools, spans }) => {
        expect(rejected.get("unknown_tool")).toBe(2);
        expect(routedTools).toEqual([]);
        expectErrorCode(spans, "forbidden_tools_blocked");
      },
      { secondApp: true },
    );
  }, 60_000);

  it("blocks fetch, XHR, WebSocket, image, and beacon exfiltration", async () => {
    await runFixture(
      "network-exfiltration.html",
      ({ status, spans, externalRequests, routedExternalRequests, externalResponses }) => {
        expect(status).toContain('"fetchBlocked":true');
        expect(status).toContain('"xhrBlocked":true');
        expect(status).toContain('"socketBlocked":true');
        expect(status).toContain('"imageBlocked":true');
        expect(status).toContain('"beaconAttempted":true');
        expect(routedExternalRequests).toEqual([]);
        expect(externalResponses).toEqual([]);
        expect(externalRequests).not.toContain("https://example.test/send-beacon");
        expectErrorCode(spans, "csp_blocked");
      },
    );
  }, 60_000);

  it("blocks top navigation and popups", async () => {
    await runFixture("navigation-popup.html", ({ page, hostOrigin, popups, spans }) => {
      expect(page.url().startsWith(hostOrigin)).toBe(true);
      expect(popups).toEqual([]);
      expectErrorCode(spans, "navigation_blocked");
    });
  }, 60_000);

  it("ignores malformed JSON-RPC messages while accepting an error span", async () => {
    await runFixture("malformed-jsonrpc.html", ({ rejected, spans }) => {
      expect(rejected.get("schema") ?? 0).toBe(0);
      expectErrorCode(spans, "malformed_jsonrpc_blocked");
    });
  }, 60_000);

  it("prevents reading the parent DOM", async () => {
    await runFixture("parent-dom.html", ({ status, spans }) => {
      expect(status).toContain('"parentDomBlocked":true');
      expectErrorCode(spans, "parent_dom_blocked");
    });
  }, 60_000);

  it("rejects telemetry carrying a replayed session id", async () => {
    await runFixture("session-replay.html", ({ rejected, spans }) => {
      expect(rejected.get("schema")).toBe(1);
      expectErrorCode(spans, "session_replay_blocked");
    });
  }, 60_000);
});
