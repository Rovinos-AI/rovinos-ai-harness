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
    readonly callServerTool = vi.fn(async ({ name }: { readonly name: string }) => ({
      structuredContent:
        name === "harness.runs.get"
          ? {
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
            }
          : {
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
            },
      content: [],
    }));
    readonly connect = vi.fn(async () => undefined);
    readonly getHostContext = vi.fn(() => ({ theme: "light", locale: "en" }));
    readonly openLink = vi.fn(async () => ({}));
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
  it("connects the app, loads metadata through the bridge, and opens the approval resource", async () => {
    await import("./index.js");
    await vi.waitFor(() => {
      expect(appMock.instance?.callServerTool).toHaveBeenCalledWith({
        name: "harness.runs.list",
        arguments: {},
      });
    });
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("Needs approval (1)");
    });
    const approvalButton = [...document.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Needs approval"),
    );
    approvalButton?.click();
    await vi.waitFor(() => {
      expect(appMock.instance?.openLink).toHaveBeenCalledWith({
        url: "ui://harness/approval/v1?approvalId=00000000000000000000000002",
      });
    });
    expect(appMock.instance?.getHostContext).toHaveBeenCalled();
    expect(document.title).toBe("Runs");
    const pageHide = new Event("pagehide");
    Object.defineProperty(pageHide, "persisted", { value: false });
    window.dispatchEvent(pageHide);
  });
});
