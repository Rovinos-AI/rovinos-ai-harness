// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

const appMock = vi.hoisted(() => {
  let instance:
    | {
        readonly callServerTool: ReturnType<typeof vi.fn>;
        readonly openLink: ReturnType<typeof vi.fn>;
        emit(name: string, params: unknown): void;
      }
    | undefined;
  return {
    get instance() {
      return instance;
    },
    setInstance(value: typeof instance) {
      instance = value;
    },
  };
});

vi.mock("@modelcontextprotocol/ext-apps", () => ({
  App: class {
    private readonly handlers = new Map<string, (params: unknown) => void>();
    readonly callServerTool = vi.fn(() =>
      Promise.resolve({ structuredContent: { resolved: true }, content: [] }),
    );
    readonly openLink = vi.fn(() => Promise.resolve({}));
    readonly connect = vi.fn(() => Promise.resolve());
    readonly getHostContext = vi.fn(() => ({ theme: "light", locale: "en" }));
    readonly addEventListener = vi.fn((name: string, handler: (params: unknown) => void) => {
      this.handlers.set(name, handler);
    });
    readonly removeEventListener = vi.fn((name: string) => {
      this.handlers.delete(name);
    });

    emit(name: string, params: unknown): void {
      this.handlers.get(name)?.(params);
    }

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

describe("input app bootstrap", () => {
  it("uses the app-only answer tool and host-gated open-link request", async () => {
    await import("./index.js");
    const app = appMock.instance;
    if (app === undefined) {
      throw new Error("Expected an MCP App instance");
    }
    app.emit("toolresult", {
      structuredContent: {
        requestId: "00000000000000000000000001",
        source: "agent",
        round: 0,
        mode: "form",
        message: "What should be saved?",
        schema: {
          type: "object",
          required: ["answer"],
          properties: { answer: { type: "string", default: "approved" } },
        },
      },
      content: [],
    });
    const form = document.querySelector("form");
    if (form === null) {
      throw new Error("Expected a form");
    }
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => {
      expect(app.callServerTool).toHaveBeenCalledWith({
        name: "harness.inputs.answer",
        arguments: {
          requestId: "00000000000000000000000001",
          action: "accept",
          answer: { answer: "approved" },
        },
      });
    });

    app.emit("toolresult", {
      structuredContent: {
        requestId: "00000000000000000000000002",
        source: "mcp_mrtr",
        serverId: "mcp.accounts",
        round: 0,
        mode: "url",
        message: "Continue to the account page.",
        url: "https://accounts.example.test/connect",
      },
      content: [],
    });
    const open = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Open URL",
    );
    open?.click();
    expect(app.openLink).not.toHaveBeenCalled();

    const dialog = document.querySelector("dialog");
    if (dialog === null) {
      throw new Error("Expected an open-link confirmation dialog");
    }
    Object.defineProperty(dialog, "showModal", { value: vi.fn() });
    open?.click();
    dialog.querySelector<HTMLButtonElement>("button")?.click();
    await vi.waitFor(() => {
      expect(app.openLink).toHaveBeenCalledExactlyOnceWith({
        url: "https://accounts.example.test/connect",
      });
    });
  });
});
