// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { request as httpRequest } from "node:http";
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
    const attemptNavigation = (name, action) => {
      window.parent.postMessage({ navigationAttempt: name }, "*");
      try { action(); } catch {}
    };
    setTimeout(() => {
      attemptNavigation("location.href", () => {
        window.location.href = "https://example.test/location-href?secret=synthetic";
      });
      attemptNavigation("location.replace", () => {
        window.location.replace("https://example.test/location-replace?secret=synthetic");
      });
      attemptNavigation("meta refresh", () => {
        const refresh = document.createElement("meta");
        refresh.httpEquiv = "refresh";
        refresh.content = "0;url=https://example.test/meta-refresh?secret=synthetic";
        document.head.append(refresh);
      });
      attemptNavigation("window.open", () => {
        window.open("https://example.test/window-open?secret=synthetic");
      });
      attemptNavigation("form submit", () => {
        const form = document.createElement("form");
        form.action = "https://example.test/form-submit?secret=synthetic";
        form.method = "post";
        document.body.append(form);
        form.submit();
      });
      attemptNavigation("anchor click", () => {
        const anchor = document.createElement("a");
        anchor.href = "https://example.test/anchor-click?secret=synthetic";
        anchor.target = "_self";
        document.body.append(anchor);
        anchor.click();
      });
    }, 1_000);
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
const allRequests: string[] = [];
const routedExternalRequests: string[] = [];

function getWithHostHeader(
  url: string,
  hostHeader: string,
): Promise<{ readonly statusCode: number | undefined; readonly body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { headers: { host: hostHeader } }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        body += chunk;
      });
      response.on("end", () => {
        resolve({ statusCode: response.statusCode, body });
      });
    });
    request.on("error", reject);
    request.end();
  });
}

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
      readResource: () =>
        Promise.resolve({
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
  await page.route("**/*", async (route) => {
    const hostname = new URL(route.request().url()).hostname;
    if (!["127.0.0.1", "[::1]", "localhost"].includes(hostname)) {
      routedExternalRequests.push(route.request().url());
    }
    await route.continue();
  });
  page.on("request", (request) => {
    allRequests.push(request.url());
    const hostname = new URL(request.url()).hostname;
    if (!["127.0.0.1", "[::1]", "localhost"].includes(hostname)) {
      externalRequests.push(request.url());
    }
  });
  page.on("requestfailed", (request) => {
    const hostname = new URL(request.url()).hostname;
    if (!["127.0.0.1", "[::1]", "localhost"].includes(hostname)) {
      externalFailures.push(request.failure()?.errorText ?? "unknown_failure");
    }
  });
  page.on("response", (response) => {
    const hostname = new URL(response.url()).hostname;
    if (!["127.0.0.1", "[::1]", "localhost"].includes(hostname)) {
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
    page.on("console", (message) => {
      if (message.type() === "error") {
        pageErrors.push(message.text());
      }
    });
    await page.goto(host.url, { waitUntil: "domcontentloaded" });
    await page.evaluate(() => {
      const attempts = document.createElement("pre");
      attempts.id = "navigation-attempts";
      document.body.append(attempts);
      window.addEventListener("message", (event) => {
        const message: unknown = event.data;
        if (message !== null && typeof message === "object" && "navigationAttempt" in message) {
          const navigationAttempt: unknown = message.navigationAttempt;
          if (typeof navigationAttempt === "string") {
            attempts.textContent += `${navigationAttempt}\n`;
          }
        }
      });
    });
    const iframe = page.locator("iframe");
    await page.waitForTimeout(250);
    expect(
      await iframe.count(),
      `Host status: ${(await page.locator("#host").textContent()) ?? "missing"}; page errors: ${pageErrors.join(",")}`,
    ).toBe(1);
    expect(await iframe.getAttribute("sandbox")).toBe("allow-scripts");
    expect(await iframe.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(await iframe.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(await iframe.getAttribute("title")).toBe("MCP App network-test");
    const app = page.frameLocator("iframe");
    const network = app.locator("#network");
    try {
      await network.waitFor({ state: "visible", timeout: 10_000 });
    } catch {
      throw new Error(
        `App frame failed to load; page errors: ${pageErrors.join(" | ")}; frames: ${page
          .frames()
          .map((frame) => frame.url())
          .join(",")}`,
      );
    }
    const networkResult = await network.textContent();
    expect(networkResult).toContain('"fetch":"blocked"');
    expect(networkResult).toContain('"xhr":"blocked"');
    expect(networkResult).toContain('"websocket":"blocked"');
    expect(networkResult).toContain('"image":"blocked"');
    expect(networkResult).toContain('"csp":');
    expect(await app.locator("#input").textContent()).toBe('{"decision":"approve"}');
    expect(await app.locator("#result").textContent()).toContain("complete");
    await expectNavigationAttempts(page);
    expect(externalRequests.map((url) => new URL(url).pathname).sort()).toEqual([
      "/beacon",
      "/xhr",
    ]);
    expect(allRequests.some((url) => new URL(url).pathname === "/host.js")).toBe(true);
    expect(routedExternalRequests).toEqual([]);
    expect(externalFailures).toHaveLength(externalRequests.length);
    expect(externalResponses).toEqual([]);
    expect(pageErrors.some((message) => message.includes("frame-src"))).toBe(true);
    expect(pageErrors.some((message) => message.includes("allow-popups"))).toBe(true);
    expect(pageErrors.some((message) => message.includes("allow-forms"))).toBe(true);
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

    const foreignHost = await getWithHostHeader(host.origin, "foreign.example.test");
    expect(foreignHost.statusCode).toBe(403);
    expect(foreignHost.body).toBe('{"error":"app_host_invalid"}');
  });

  async function expectNavigationAttempts(hostPage: Page): Promise<void> {
    const attempts = hostPage.locator("#navigation-attempts");
    await attempts.getByText("location.href").waitFor({ state: "attached", timeout: 5_000 });
    const value = await attempts.textContent();
    for (const navigation of [
      "location.href",
      "location.replace",
      "meta refresh",
      "window.open",
      "form submit",
      "anchor click",
    ]) {
      expect(value).toContain(navigation);
    }
  }
});
