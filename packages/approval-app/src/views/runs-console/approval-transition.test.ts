// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
import { createAppTelemetry, type AppTelemetry } from "@rovinos/app-telemetry";
import { ApprovalAppInputSchema } from "@rovinos/schemas/browser";
import { App } from "@modelcontextprotocol/ext-apps";
import { afterEach, describe, expect, it, vi } from "vitest";
import { showApprovalTransition } from "./approval-transition.js";

type SpanNames = readonly ["ui.render", "ui.decision", "ui.error", "ui.interaction"];
type TransitionTelemetry = AppTelemetry<SpanNames>;
type ServerToolResult = Awaited<ReturnType<App["callServerTool"]>>;
type OutcomeCase = readonly [string, ServerToolResult | Error, string];

const approvalInput = ApprovalAppInputSchema.parse({
  approvalId: "00000000000000000000000002",
  payload: {
    payloadVersion: 1,
    kind: "tool_call",
    callId: "00000000000000000000000004",
    toolId: "tool.call",
    ruleId: "policy.review",
    reason: "approval_required",
    summary: "Review selected approval",
    args: { email: "<EMAIL_1>" },
    ui: {
      resourceUri: "ui://harness/approval/v1",
      fallbackText: "Review approval",
    },
    editableFields: [],
  },
});

const originalRequestAnimationFrame = Object.getOwnPropertyDescriptor(
  window,
  "requestAnimationFrame",
);
const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal");
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "close");
let disposeTransition: (() => void) | undefined;
let telemetryToDispose: TransitionTelemetry | undefined;

function toolResult(result: {
  readonly content: ServerToolResult["content"];
  readonly isError?: boolean;
  readonly structuredContent?: unknown;
}): ServerToolResult {
  return result;
}

function createTelemetry(): TransitionTelemetry {
  return createAppTelemetry({
    bridge: {
      callTool: () => Promise.resolve({ content: [] }),
    },
    hostReady: Promise.resolve(),
    manifest: { spans: ["ui.render", "ui.decision", "ui.error", "ui.interaction"] },
  });
}

function setup(
  result: ServerToolResult | Error = toolResult({
    content: [],
    structuredContent: { ok: true },
  }),
) {
  const app = new App({ name: "runs-console-test", version: "0.0.0" }, {});
  const callServerTool = vi.spyOn(app, "callServerTool");
  if (result instanceof Error) {
    callServerTool.mockRejectedValue(result);
  } else {
    callServerTool.mockResolvedValue(result);
  }
  const telemetry = createTelemetry();
  telemetryToDispose = telemetry;
  disposeTransition = showApprovalTransition(document.body, approvalInput, {
    app,
    telemetry,
    locale: () => "en",
  });
  return callServerTool;
}

function resolveFrameImmediately(): void {
  Object.defineProperty(window, "requestAnimationFrame", {
    configurable: true,
    value: (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    },
  });
}

afterEach(async () => {
  disposeTransition?.();
  disposeTransition = undefined;
  await telemetryToDispose?.dispose();
  telemetryToDispose = undefined;
  document.body.replaceChildren();
  if (originalRequestAnimationFrame === undefined) {
    Reflect.deleteProperty(window, "requestAnimationFrame");
  } else {
    Object.defineProperty(window, "requestAnimationFrame", originalRequestAnimationFrame);
  }
  if (originalShowModal === undefined) {
    Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
  } else {
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", originalShowModal);
  }
  if (originalClose === undefined) {
    Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
  } else {
    Object.defineProperty(HTMLDialogElement.prototype, "close", originalClose);
  }
});

describe("run-console approval transition", () => {
  it("validates the selected payload and renders the approval view", () => {
    resolveFrameImmediately();
    setup();

    expect(document.querySelector("h1")?.textContent).toBe("Review selected approval");
    expect(document.querySelector('nav[aria-label="Approval actions"] button')?.textContent).toBe(
      "Approve",
    );
  });

  it("rejects missing and invalid payloads before rendering", async () => {
    for (const invalidKind of ["missing", "invalid"]) {
      const invalidInput = { ...approvalInput };
      if (invalidKind === "missing") {
        Reflect.deleteProperty(invalidInput, "payload");
      } else {
        Reflect.set(invalidInput, "payload", null);
      }
      const telemetry = createTelemetry();
      telemetryToDispose = telemetry;
      disposeTransition = showApprovalTransition(document.body, invalidInput, {
        app: new App({ name: "runs-console-test", version: "0.0.0" }, {}),
        telemetry,
        locale: () => "en",
      });
      expect(document.querySelector("h1")?.textContent).not.toBe("Review selected approval");
      disposeTransition();
      disposeTransition = undefined;
      document.body.replaceChildren();
      await telemetry.dispose();
      telemetryToDispose = undefined;
    }
  });

  const resolveCases: readonly OutcomeCase[] = [
    [
      "structured resolve result",
      toolResult({ content: [], structuredContent: { ok: true } }),
      "Approval granted.",
    ],
    [
      "valid error text",
      toolResult({ isError: true, content: [{ type: "text", text: '{"ok":true}' }] }),
      "Approval granted.",
    ],
    [
      "valid plain text",
      toolResult({ content: [{ type: "text", text: '{"ok":true}' }] }),
      "Approval granted.",
    ],
    [
      "malformed error text",
      toolResult({ isError: true, content: [{ type: "text", text: "not-json" }] }),
      "The approval could not be resolved.",
    ],
    ["missing result text", toolResult({ content: [] }), "The approval could not be resolved."],
    [
      "malformed plain text",
      toolResult({ content: [{ type: "text", text: "not-json" }] }),
      "The approval could not be resolved.",
    ],
    [
      "lookup failure",
      new Error("SYNTHETIC_LOOKUP_FAILURE"),
      "The approval could not be resolved.",
    ],
  ];

  for (const [label, result, expectedStatus] of resolveCases) {
    it(`handles ${label}`, async () => {
      resolveFrameImmediately();
      const callServerTool = setup(result);
      document
        .querySelector<HTMLButtonElement>('nav[aria-label="Approval actions"] button')
        ?.click();

      await vi.waitFor(() => {
        expect(document.querySelectorAll('[role="status"]').item(1).textContent).toBe(
          expectedStatus,
        );
      });
      const call = callServerTool.mock.calls.at(-1);
      expect(call?.[0].name).toBe("harness.approvals.resolve");
      expect(call?.[0].arguments).toMatchObject({ decision: "approve" });
    });
  }

  it("parses the reveal response and disposes the embedded view", async () => {
    resolveFrameImmediately();
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.open = true;
      },
    });
    Object.defineProperty(HTMLDialogElement.prototype, "close", {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.open = false;
      },
    });
    const callServerTool = setup(
      toolResult({
        content: [
          {
            type: "text",
            text: '{"values":[{"pointer":"/email","value":"synthetic@example.test"}]}',
          },
        ],
      }),
    );
    document.querySelector<HTMLButtonElement>("nav button:last-of-type")?.click();
    document.querySelector<HTMLButtonElement>("dialog button")?.click();

    await vi.waitFor(() => {
      const call = callServerTool.mock.calls.at(-1);
      expect(call?.[0].name).toBe("harness.approvals.reveal");
      expect(call?.[0].arguments).toMatchObject({ pointers: ["/email"] });
    });
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("synthetic@example.test");
    });
    disposeTransition?.();
    disposeTransition = undefined;
    expect(document.body.textContent).not.toContain("synthetic@example.test");
  });
});
