// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as Apps from "@modelcontextprotocol/ext-apps";

const bridge = vi.hoisted(() => ({
  apps: new Map<string, Apps.EventDispatcher<Apps.AppEventMap>>(),
  connect: vi.fn<() => Promise<void>>(),
  call: vi.fn<Apps.App["callServerTool"]>(),
}));

vi.mock("@modelcontextprotocol/ext-apps", async (importOriginal) => {
  const actual = await importOriginal<typeof Apps>();
  return {
    App: class extends actual.EventDispatcher<Apps.AppEventMap> {
      connect = bridge.connect;
      callServerTool = bridge.call;
      constructor() {
        super();
        bridge.apps.set("app", this);
      }
    },
  };
});

const payload = {
  payloadVersion: 1,
  kind: "tool_call",
  callId: "00000000000000000000000001",
  toolId: "mail.send",
  ruleId: "mail.review",
  reason: "approval_required",
  summary: "SYNTHETIC_PAYLOAD_CANARY",
  args: { to: "<EMAIL_1>" },
  ui: { resourceUri: "ui://harness/approval/v1", fallbackText: "Review" },
  editableFields: [],
};

afterEach(() => {
  window.dispatchEvent(new Event("pagehide"));
  vi.useRealTimers();
  vi.resetModules();
  vi.clearAllMocks();
  document.body.replaceChildren();
});

async function start() {
  bridge.connect.mockResolvedValue(undefined);
  bridge.call.mockResolvedValue({ content: [] });
  await import("./main.js");
  const app = bridge.apps.get("app");
  if (app === undefined) {
    throw new Error("App was not created");
  }
  return app;
}

describe("approval app SDK bootstrap", () => {
  it("receives input and structured/text results and sends only metadata errors through the host", async () => {
    vi.useFakeTimers();
    const app = await start();
    expect(bridge.connect).toHaveBeenCalledOnce();
    app.dispatch("toolinput", { arguments: payload });
    vi.advanceTimersByTime(1000);
    expect(document.querySelector("h1")?.textContent).toBe(payload.summary);
    app.dispatch("toolresult", {
      content: [],
      structuredContent: { ...payload, summary: "Structured result" },
    });
    expect(document.querySelector("h1")?.textContent).toBe("Structured result");
    app.dispatch("toolresult", { content: [{ type: "text", text: JSON.stringify(payload) }] });
    expect(document.querySelector("h1")?.textContent).toBe(payload.summary);
    for (const result of [
      { content: [], isError: true, structuredContent: payload },
      { content: [] },
      { content: [{ type: "text" as const, text: "SYNTHETIC_INVALID_CANARY" }] },
      { content: [], structuredContent: { private: "SYNTHETIC_INVALID_CANARY" } },
    ]) {
      app.dispatch("toolresult", result);
      expect(document.body.textContent).toContain("Invalid approval payload");
    }
    await vi.waitFor(() => {
      expect(bridge.call).toHaveBeenCalled();
    });
    expect(bridge.call.mock.invocationCallOrder[0]).toBeGreaterThan(
      bridge.connect.mock.invocationCallOrder[0] ?? 0,
    );
    const calls = JSON.stringify(bridge.call.mock.calls);
    expect(calls).toContain("harness.telemetry.emit");
    expect(calls).toContain("payload_invalid");
    expect(calls).not.toContain("SYNTHETIC");
    expect(calls).not.toContain("harness.approvals");
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    window.dispatchEvent(new Event("pagehide"));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resolves a wrapped approval with its approval id and emits only the decision metadata", async () => {
    const app = await start();
    bridge.call.mockImplementation((request) =>
      Promise.resolve(
        request.name === "harness.approvals.resolve"
          ? { content: [], structuredContent: { ok: true } }
          : { content: [] },
      ),
    );
    app.dispatch("toolinput", {
      arguments: {
        approvalId: "00000000000000000000000003",
        payload,
      },
    });
    document.querySelector<HTMLButtonElement>("button")?.click();
    await vi.waitFor(() => {
      const statuses = document.querySelectorAll('[role="status"]');
      expect(statuses[statuses.length - 1]?.textContent).toBe("Approval granted.");
    });
    expect(
      bridge.call.mock.calls.some(([request]) => request.name === "harness.approvals.resolve"),
    ).toBe(true);
    const calls = JSON.stringify(bridge.call.mock.calls);
    expect(calls).toContain('"approvalId":"00000000000000000000000003"');
    expect(calls).toContain('"decision":"approve"');
    expect(calls).not.toContain("SYNTHETIC");
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });

  it("handles a failed connection without exposing the exception", async () => {
    bridge.connect.mockRejectedValue(new Error("SYNTHETIC_BRIDGE_CANARY"));
    bridge.call.mockRejectedValue(new Error("SYNTHETIC_TRANSPORT_CANARY"));
    await import("./main.js");
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("Invalid approval payload");
    });
    expect(document.body.textContent).not.toContain("SYNTHETIC");
    expect(JSON.stringify(bridge.call.mock.calls)).not.toContain("SYNTHETIC");
    expect(bridge.call).not.toHaveBeenCalled();
  });
});
