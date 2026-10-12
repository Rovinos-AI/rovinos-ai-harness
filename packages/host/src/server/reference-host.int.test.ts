// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { createReferenceHost, type ReferenceHost } from "./index.js";

const resourceUri = "ui://test/network.html";
const appHtml = `<!doctype html>
<html><body>
  <pre id="network">pending</pre>
  <pre id="input"></pre>
  <pre id="result"></pre>
  <script>
    const state = { fetch: "pending", xhr: "pending", websocket: "pending", image: "pending" };
    const update = () => {
      document.getElementById("network").textContent = JSON.stringify(state);
    };
    window.addEventListener("message", (event) => {
      const message = event.data;
      if (message?.method === "ui/notifications/tool-input") {
        document.getElementById("input").textContent = JSON.stringify(message.params.arguments);
      }
      if (message?.method === "ui/notifications/tool-result") {
        document.getElementById("result").textContent = JSON.stringify(message.params);
      }
      if (message?.id === 1 && message.result !== undefined) {
        window.parent.postMessage({
          jsonrpc: "2.0",
          method: "ui/notifications/initialized",
          params: {}
        }, "*");
      }
    });
    window.addEventListener("securitypolicyviolation", (event) => {
      state.csp = (state.csp || 0) + 1;
      update();
    });
    fetch("https://example.test/fetch")
      .then(() => { state.fetch = "allowed"; update(); })
      .catch(() => { state.fetch = "blocked"; update(); });
    const request = new XMLHttpRequest();
    request.onload = () => { state.xhr = "allowed"; update(); };
    request.onerror = () => { state.xhr = "blocked"; update(); };
    request.open("GET", "https://example.test/xhr");
    request.send();
    try {
      const socket = new WebSocket("wss://example.test/socket");
      socket.onopen = () => { state.websocket = "allowed"; update(); };
      socket.onerror = () => { state.websocket = "blocked"; update(); };
    } catch {
      state.websocket = "blocked";
    }
    const image = new Image();
    image.onload = () => { state.image = "allowed"; update(); };
    image.onerror = () => { state.image = "blocked"; update(); };
    image.src = "https://example.test/beacon";
    window.parent.postMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "ui/initialize",
      params: {
        protocolVersion: "2026-01-26",
        appInfo: { name: "network-test", version: "1" },
        appCapabilities: {}
      }
    }, "*");
    setTimeout(update, 500);
  </script>
</body></html>`;

let browser: Browser | undefined;
let host: ReferenceHost | undefined;
let page: Page | undefined;
const externalRequests: string[] = [];
const externalFailures: string[] = [];
const externalResponses: string[] = [];

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  host = await createReferenceHost(
    {
      apps: [
        {
          id: "network-test",
          resourceUri,
          telemetry: false,
          allowedTools: [],
        },
      ],
      listen: { host: "127.0.0.1", port: 0 },
    },
    {
      onCode: () => undefined,
      readResource: () => Promise.resolve({
        contents: [
          {
            mimeType: "text/html;profile=mcp-app",
            text: appHtml,
          },
        ],
      }),
      idGenerator: () => "00000000000000000000000000",
      toolInput: { decision: "approve" },
      toolResult: { content: [{ type: "text", text: "complete" }] },
    },
  );
  page = await browser.newPage();
  page.on("request", (request) => {
    if (new URL(request.url()).hostname === "example.test") {
      externalRequests.push(request.url());
    }
  });
  page.on("requestfailed", (request) => {
    if (new URL(request.url()).hostname === "example.test") {
      externalFailures.push(request.failure()?.errorText ?? "unknown_failure");
    }
  });
  page.on("response", (response) => {
    if (new URL(response.url()).hostname === "example.test") {
      externalResponses.push(response.url());
    }
  });
});

afterAll(async () => {
  await page?.close();
  await browser?.close();
  await host?.close();
});

describe("reference host browser security", () => {
  it("isolates the MCP App, blocks external requests, and delivers tool data", async () => {
    if (page === undefined || host === undefined) {
      throw new Error("Browser test setup failed.");
    }
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.name));
    await page.goto(host.url, { waitUntil: "domcontentloaded" });
    const iframe = page.locator("iframe");
    await page.waitForTimeout(250);
    expect(
      await iframe.count(),
      `Host status: ${(await page.locator("#host").textContent()) ?? "missing"}; page errors: ${pageErrors.join(",")}`,
    ).toBe(1);
    expect(await iframe.getAttribute("sandbox")).toBe("allow-scripts");
    expect(await iframe.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(await iframe.getAttribute("sandbox")).not.toContain("allow-same-origin");
    const app = page.frameLocator("iframe");
    const network = app.locator("#network");
    await network.waitFor({ state: "visible", timeout: 10_000 });
    const networkResult = await network.textContent();
    expect(networkResult).toContain('"fetch":"blocked"');
    expect(networkResult).toContain('"xhr":"blocked"');
    expect(networkResult).toContain('"websocket":"blocked"');
    expect(networkResult).toContain('"image":"blocked"');
    expect(networkResult).toContain('"csp":');
    expect(await app.locator("#input").textContent()).toBe('{"decision":"approve"}');
    expect(await app.locator("#result").textContent()).toContain("complete");
    expect(externalFailures).toHaveLength(externalRequests.length);
    expect(externalResponses).toEqual([]);
  }, 20_000);

  it("refuses unknown resources and rejects missing-token and foreign-origin requests", async () => {
    if (host === undefined) {
      throw new Error("Host test setup failed.");
    }
    const headers = {
      authorization: ["Bearer", host.token].join(" "),
      origin: host.origin,
    };
    const unknown = await fetch(
      `${host.origin}/api/app?resourceUri=${encodeURIComponent("ui://unknown/app")}`,
      { headers },
    );
    expect(unknown.status).toBe(404);
    expect(await unknown.text()).toBe('{"error":"app_unknown"}');

    const missingToken = await fetch(
      `${host.origin}/api/events?resourceUri=${encodeURIComponent(resourceUri)}`,
      {
        headers: { origin: host.origin },
      },
    );
    expect(missingToken.status).toBe(403);

    const foreignOrigin = await fetch(
      `${host.origin}/api/events?resourceUri=${encodeURIComponent(resourceUri)}`,
      {
        headers: { ...headers, origin: "http://foreign.example.test" },
      },
    );
    expect(foreignOrigin.status).toBe(403);
  });
});
