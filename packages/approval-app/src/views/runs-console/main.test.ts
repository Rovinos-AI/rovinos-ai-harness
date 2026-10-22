// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

interface AppMock {
  readonly callServerTool: ReturnType<typeof vi.fn>;
  readonly connect: ReturnType<typeof vi.fn>;
  readonly getHostContext: ReturnType<typeof vi.fn>;
  readonly openLink: ReturnType<typeof vi.fn>;
  readonly addEventListener: ReturnType<typeof vi.fn>;
  readonly removeEventListener: ReturnType<typeof vi.fn>;
}

const appMock = vi.hoisted(() => {
  let instance: AppMock | undefined;
  return {
    get instance() {
      return instance;
    },
    setInstance(value: AppMock | undefined) {
      instance = value;
    },
  };
});

vi.mock("@modelcontextprotocol/ext-apps", () => ({
  App: class {
    readonly callServerTool = vi.fn(({ name }: { readonly name: string }) => {
      let structuredContent: unknown;
      if (name === "harness.approvals.get") {
        structuredContent = {
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
        };
      } else if (name === "harness.runs.get") {
        structuredContent = {
          runId: "00000000000000000000000001",
          status: "suspended",
          steps: 1,
          usage: { inputTokens: 2, outputTokens: 3, costMicros: 4 },
          pendingApprovals: [
            {
              approvalId: "00000000000000000000000002",
              toolId: "tool.call",
              ruleId: "policy.review",
            },
          ],
        };
      } else {
        structuredContent = {
          runs: [
            {
              runId: "00000000000000000000000001",
              status: "suspended",
              createdAt: 1,
              lastTs: 2,
              lastSeq: 3,
              steps: 1,
              pendingApprovals: 1,
            },
          ],
        };
      }
      return Promise.resolve({ structuredContent, content: [] });
    });
    readonly connect = vi.fn(() => Promise.resolve());
    readonly getHostContext = vi.fn(() => ({ theme: "light", locale: "en" }));
    readonly openLink = vi.fn(() => Promise.resolve({}));
    readonly addEventListener = vi.fn();
    readonly removeEventListener = vi.fn();

    constructor() {
      appMock.setInstance(this);
    }
  },
}));

afterEach(() => {
  document.body.replaceChildren();
  vi.resetModules();
  appMock.setInstance(undefined);
});

describe("runs console app bootstrap", () => {
  it("loads an approval payload and transitions to the approval view", async () => {
    await import("./index.js");
    await vi.waitFor(() => {
      expect(appMock.instance?.callServerTool).toHaveBeenCalledWith({
        name: "harness.runs.list",
        arguments: { limit: 20 },
      });
    });
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("Needs approval (1)");
    });
    const approvalButton = [...document.querySelectorAll("button")].find((button) =>
      button.textContent.includes("Needs approval"),
    );
    approvalButton?.click();
    await vi.waitFor(() => {
      expect(appMock.instance?.callServerTool).toHaveBeenCalledWith({
        name: "harness.approvals.get",
        arguments: { approvalId: "00000000000000000000000002" },
      });
    });
    await vi.waitFor(() => {
      expect(document.querySelector("h1")?.textContent).toBe("Review selected approval");
    });
    expect(document.querySelector('nav[aria-label="Approval actions"] button')?.textContent).toBe(
      "Approve",
    );
    expect(appMock.instance?.openLink).not.toHaveBeenCalled();
    expect(appMock.instance?.getHostContext).toHaveBeenCalled();
    expect(document.title).toBe("Pending approval");
    const pageHide = new Event("pagehide");
    Object.defineProperty(pageHide, "persisted", { value: false });
    window.dispatchEvent(pageHide);
  });
});
