// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as Apps from "@modelcontextprotocol/ext-apps";
import type * as AppTelemetry from "@harness/app-telemetry";
import type { AppSpanName, CreateAppTelemetryOptions } from "@harness/app-telemetry";
import type * as ApprovalActionsModule from "./actions.js";
import type * as ApprovalTelemetryModule from "./telemetry.js";

const bridge = vi.hoisted(() => ({
  apps: new Map<string, Apps.EventDispatcher<Apps.AppEventMap>>(),
  connect: vi.fn<() => Promise<void>>(),
  call: vi.fn<Apps.App["callServerTool"]>(),
}));
const telemetry = vi.hoisted(() => {
  const instances: {
    active: boolean;
    setHostMetadata(metadata: unknown): void;
    traceContext: { readonly traceId: string | undefined };
  }[] = [];
  const hooks: {
    reportErrors: string[][];
    decisionDurationCalls: number;
  }[] = [];
  return { instances, hooks };
});
const actionMounts: {
  options:
    | {
        reportError: (code: "resolve_failed" | "reveal_failed") => void;
        decisionDurationMs: () => number;
        flushInteractions: () => void;
      }
    | undefined;
} = vi.hoisted(() => ({ options: undefined }));

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

vi.mock("@harness/app-telemetry", async (importOriginal) => {
  const actual = await importOriginal<typeof AppTelemetry>();
  return {
    ...actual,
    createAppTelemetry: <const Names extends readonly AppSpanName[]>(
      options: CreateAppTelemetryOptions<Names>,
    ) => {
      const instance = actual.createAppTelemetry(options);
      telemetry.instances.push(instance);
      return instance;
    },
  };
});

vi.mock("./actions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof ApprovalActionsModule>();
  return {
    ...actual,
    mountApprovalActions: (
      actions: HTMLElement,
      editHost: HTMLElement,
      options: Parameters<typeof actual.mountApprovalActions>[2],
    ) => {
      actionMounts.options = options;
      return actual.mountApprovalActions(actions, editHost, options);
    },
  };
});

vi.mock("./telemetry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof ApprovalTelemetryModule>();
  return {
    ...actual,
    createApprovalTelemetry: (...args: Parameters<typeof actual.createApprovalTelemetry>) => {
      const lifecycle = actual.createApprovalTelemetry(...args);
      const reportError = lifecycle.reportError.bind(lifecycle);
      const decisionDurationMs = lifecycle.decisionDurationMs.bind(lifecycle);
      const reportErrors: string[][] = [];
      let decisionDurationCalls = 0;
      lifecycle.reportError = (code) => {
        reportErrors.push([code]);
        reportError(code);
      };
      lifecycle.decisionDurationMs = () => {
        decisionDurationCalls += 1;
        return decisionDurationMs();
      };
      telemetry.hooks.push({
        reportErrors,
        get decisionDurationCalls() {
          return decisionDurationCalls;
        },
      });
      return lifecycle;
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

const originalRequestAnimationFrame = Object.getOwnPropertyDescriptor(
  window,
  "requestAnimationFrame",
);

function installAnimationFrame(): void {
  Object.defineProperty(window, "requestAnimationFrame", {
    configurable: true,
    writable: true,
    value: (callback: FrameRequestCallback) => {
      callback(window.performance.now());
      return 1;
    },
  });
}

afterEach(async () => {
  window.dispatchEvent(new Event("pagehide"));
  if (originalRequestAnimationFrame === undefined) {
    Reflect.deleteProperty(window, "requestAnimationFrame");
  } else {
    Object.defineProperty(window, "requestAnimationFrame", originalRequestAnimationFrame);
  }
  vi.useRealTimers();
  await vi.waitFor(() => {
    if (!telemetry.instances.every((instance) => !instance.active)) {
      throw new Error("Telemetry disposal has not completed.");
    }
  });
  vi.resetModules();
  vi.clearAllMocks();
  telemetry.instances.length = 0;
  telemetry.hooks.length = 0;
  actionMounts.options = undefined;
  document.body.replaceChildren();
});

async function start() {
  installAnimationFrame();
  bridge.connect.mockResolvedValue(undefined);
  bridge.call.mockResolvedValue({ content: [] });
  await import("./main.js");
  const app = bridge.apps.get("app");
  if (app === undefined) {
    throw new Error("App was not created");
  }
  await vi.waitFor(() => {
    expect(telemetry.instances[0]?.active).toBe(true);
  });
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
    const instance = telemetry.instances[0];
    if (instance === undefined) {
      throw new Error("App telemetry was not created.");
    }
    const setHostMetadataSpy = vi.spyOn(instance, "setHostMetadata");
    app.dispatch("toolresult", {
      content: [],
      _meta: { traceparent: "00-1234567890abcdef1234567890abcdef-1234567890abcdef-01" },
    });
    expect(setHostMetadataSpy).toHaveBeenCalledWith({
      traceparent: "00-1234567890abcdef1234567890abcdef-1234567890abcdef-01",
    });
    expect(instance.traceContext.traceId).toBe("1234567890abcdef1234567890abcdef");
    await vi.waitFor(() => {
      expect(
        bridge.call.mock.calls.some(
          ([request]) =>
            request.name === "harness.telemetry.emit" &&
            request.arguments !== undefined &&
            "spans" in request.arguments &&
            Array.isArray(request.arguments.spans) &&
            request.arguments.spans.length > 0,
        ),
      ).toBe(true);
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

  it("preserves structured server failures returned with isError and allows an edit retry", async () => {
    const app = await start();
    let invalidEditReturned = false;
    bridge.call.mockImplementation((request) => {
      if (request.name !== "harness.approvals.resolve") {
        return Promise.resolve({ content: [] });
      }
      if (invalidEditReturned) {
        return Promise.resolve({ content: [], structuredContent: { ok: true } });
      }
      invalidEditReturned = true;
      return Promise.resolve({
        content: [{ type: "text", text: "edit_invalid" }],
        structuredContent: { ok: false, code: "edit_invalid" },
        isError: true,
      });
    });
    app.dispatch("toolinput", {
      arguments: {
        approvalId: "00000000000000000000000003",
        payload: { ...payload, args: { count: 1 }, editableFields: ["/count"] },
      },
    });
    document
      .querySelector<HTMLButtonElement>('nav[aria-label="Approval actions"] button:nth-child(3)')
      ?.click();
    const input = document.querySelector<HTMLInputElement>("#approval-edit-0");
    if (input === null) {
      throw new Error("Expected the edit input.");
    }
    input.value = "2";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const submit = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Submit edits",
    );
    if (submit === undefined) {
      throw new Error("Expected the edit submit button.");
    }
    submit.click();
    await vi.waitFor(() => {
      const alerts = document.querySelectorAll('[role="status"]');
      expect(alerts[alerts.length - 1]?.textContent).toBe("The edited values are invalid.");
    });
    expect(submit.disabled).toBe(false);
    submit.click();
    await vi.waitFor(() => {
      const statuses = document.querySelectorAll('[role="status"]');
      expect(statuses[statuses.length - 1]?.textContent).toBe("Edits submitted.");
    });
  });

  it("keeps unavailable-tool fallback sticky across rerenders and a late host connection", async () => {
    installAnimationFrame();
    let finishConnection: (() => void) | undefined;
    bridge.connect.mockReturnValue(
      new Promise<void>((resolve) => {
        finishConnection = resolve;
      }),
    );
    bridge.call.mockImplementation((request) =>
      request.name === "harness.approvals.resolve"
        ? Promise.reject(Object.assign(new Error("app_tool_not_allowed"), { code: -32600 }))
        : Promise.resolve({ content: [] }),
    );
    await import("./main.js");
    const app = bridge.apps.get("app");
    if (app === undefined) {
      throw new Error("App was not created");
    }
    app.dispatch("toolinput", {
      arguments: {
        approvalId: "00000000000000000000000003",
        payload,
      },
    });
    document.querySelector<HTMLButtonElement>('nav[aria-label="Approval actions"] button')?.click();
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("Review");
      expect(document.querySelector('[aria-label="Approve command"]')).not.toBeNull();
    });
    app.dispatch("toolinput", {
      arguments: {
        approvalId: "00000000000000000000000003",
        payload,
      },
    });
    expect(
      [
        ...document.querySelectorAll<HTMLButtonElement>(
          'nav[aria-label="Approval actions"] button',
        ),
      ].every((control) => control.disabled),
    ).toBe(true);
    finishConnection?.();
    await vi.waitFor(() => {
      expect(
        document
          .querySelector('section[aria-labelledby="approval-fallback-heading"]')
          ?.hasAttribute("hidden"),
      ).toBe(false);
    });
    expect(document.querySelector<HTMLInputElement>('[aria-label="Approve command"]')?.value).toBe(
      "harness approvals approve 00000000000000000000000003",
    );
  });

  it("treats JSON-RPC method-not-found as an unavailable resolve tool", async () => {
    const app = await start();
    bridge.call.mockImplementation((request) =>
      request.name === "harness.approvals.resolve"
        ? Promise.reject(Object.assign(new Error("method_not_found"), { code: -32601 }))
        : Promise.resolve({ content: [] }),
    );
    app.dispatch("toolinput", {
      arguments: {
        approvalId: "00000000000000000000000003",
        payload,
      },
    });
    document.querySelector<HTMLButtonElement>('nav[aria-label="Approval actions"] button')?.click();
    await vi.waitFor(() => {
      expect(document.querySelector('[aria-label="Approve command"]')).not.toBeNull();
    });
    expect(
      document.querySelector<HTMLButtonElement>('nav[aria-label="Approval actions"] button')
        ?.disabled,
    ).toBe(true);
  });

  it("treats other resolve transport errors as retryable failures", async () => {
    const app = await start();
    bridge.call.mockImplementation((request) =>
      request.name === "harness.approvals.resolve"
        ? Promise.reject(new Error("SYNTHETIC_TRANSPORT_CANARY"))
        : Promise.resolve({ content: [] }),
    );
    app.dispatch("toolinput", {
      arguments: {
        approvalId: "00000000000000000000000003",
        payload,
      },
    });
    document.querySelector<HTMLButtonElement>('nav[aria-label="Approval actions"] button')?.click();
    await vi.waitFor(() => {
      const statuses = document.querySelectorAll('[role="status"]');
      expect(statuses[statuses.length - 1]?.textContent).toBe(
        "The approval could not be resolved.",
      );
    });
    expect(
      document.querySelector<HTMLButtonElement>('nav[aria-label="Approval actions"] button')
        ?.disabled,
    ).toBe(false);
    expect(document.querySelector('[aria-label="Approve command"]')).toBeNull();
    expect(document.body.textContent).not.toContain("SYNTHETIC_TRANSPORT_CANARY");
  });

  it("handles a failed connection without exposing the exception", async () => {
    vi.useFakeTimers();
    installAnimationFrame();
    bridge.connect.mockRejectedValue(new Error("SYNTHETIC_BRIDGE_CANARY"));
    bridge.call.mockRejectedValue(new Error("SYNTHETIC_TRANSPORT_CANARY"));
    await import("./main.js");
    expect(document.body.textContent).toContain("Waiting for host...");
    await vi.advanceTimersByTimeAsync(3001);
    expect(document.body.textContent).toContain("The host bridge is unavailable.");
    expect(document.querySelector<HTMLInputElement>('[aria-label="Approve command"]')?.value).toBe(
      "harness approvals approve <id>",
    );
    expect(document.body.textContent).not.toContain("SYNTHETIC");
    expect(JSON.stringify(bridge.call.mock.calls)).not.toContain("SYNTHETIC");
    expect(telemetry.instances[0]?.active).toBe(false);
    expect(telemetry.hooks[0]?.reportErrors).toEqual([["bridge_unavailable"]]);
    expect(
      bridge.call.mock.calls.every(([request]) => request.name === "harness.telemetry.emit"),
    ).toBe(true);
  });

  it("wires error, decision-duration, and interaction-flush hooks into mounted actions", async () => {
    const app = await start();
    app.dispatch("toolinput", {
      arguments: {
        approvalId: "00000000000000000000000003",
        payload,
      },
    });
    const options = actionMounts.options;
    const lifecycle = telemetry.hooks[0];
    if (options === undefined || lifecycle === undefined) {
      throw new Error("Approval action telemetry hooks were not mounted.");
    }
    options.reportError("resolve_failed");
    options.decisionDurationMs();
    options.flushInteractions();
    expect(lifecycle.reportErrors).toEqual([["resolve_failed"]]);
    expect(lifecycle.decisionDurationCalls).toBe(1);
    window.dispatchEvent(new Event("pagehide"));
  });

  it("keeps the view and telemetry listeners alive across a persisted pagehide", async () => {
    vi.useFakeTimers();
    const app = await start();
    app.dispatch("toolinput", {
      arguments: {
        approvalId: "00000000000000000000000003",
        payload,
      },
    });
    bridge.call.mockResolvedValue({ content: [], structuredContent: { ok: true } });
    const timersBeforePageHide = vi.getTimerCount();
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
    expect(document.querySelector("h1")?.textContent).toBe(payload.summary);
    expect(vi.getTimerCount()).toBe(timersBeforePageHide);
    document.querySelector<HTMLButtonElement>("button")?.click();
    await vi.waitFor(() => {
      expect(
        bridge.call.mock.calls.some(([request]) => request.name === "harness.approvals.resolve"),
      ).toBe(true);
    });
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false }));
    document.querySelector<HTMLButtonElement>("button")?.click();
    expect(
      bridge.call.mock.calls.filter(([request]) => request.name === "harness.approvals.resolve"),
    ).toHaveLength(1);
  });

  it("waits for a delayed SDK connection before starting telemetry activation", async () => {
    installAnimationFrame();
    vi.useFakeTimers();
    let resolveConnection: (() => void) | undefined;
    bridge.connect.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveConnection = resolve;
      }),
    );
    bridge.call.mockResolvedValue({ content: [] });
    await import("./main.js");
    await vi.advanceTimersByTimeAsync(3_000);
    expect(bridge.call).not.toHaveBeenCalled();

    resolveConnection?.();
    await vi.waitFor(() => {
      expect(bridge.call).toHaveBeenCalledWith({
        name: "harness.telemetry.emit",
        arguments: { spans: [] },
      });
    });
    await vi.waitFor(() => {
      expect(telemetry.instances[0]?.active).toBe(true);
    });
    window.dispatchEvent(new Event("pagehide"));
  });
});
