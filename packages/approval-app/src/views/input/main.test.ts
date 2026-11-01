// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

interface MockToolResult {
  readonly structuredContent?: unknown;
  readonly content: readonly { readonly type: "text"; readonly text: string }[];
  readonly isError?: boolean;
}

const appMock = vi.hoisted(() => {
  let instance:
    | {
        readonly callServerTool: ReturnType<typeof vi.fn>;
        readonly openLink: ReturnType<typeof vi.fn>;
        readonly getHostContext: ReturnType<typeof vi.fn>;
        readonly removeEventListener: ReturnType<typeof vi.fn>;
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
    readonly callServerTool = vi.fn((): Promise<MockToolResult> =>
      Promise.resolve({
        structuredContent: { resolved: true },
        content: [],
      }),
    );
    readonly openLink = vi.fn((): Promise<{ readonly isError?: boolean }> => Promise.resolve({}));
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

  it("accepts textual tool results, renders empty lists, and rejects malformed bridge payloads", async () => {
    await import("./index.js");
    const app = appMock.instance;
    if (app === undefined) {
      throw new Error("Expected an MCP App instance");
    }

    app.emit("toolresult", {
      content: [{ type: "text", text: '{"inputs":[]}' }],
      _meta: {},
    });
    expect(document.body.textContent).toContain("There are no pending inputs.");

    app.emit("toolresult", { content: [{ type: "text", text: "not-json" }] });
    expect(document.body.textContent).toContain("Invalid input request");

    app.emit("toolresult", { isError: true, content: [] });
    expect(document.body.textContent).toContain("Invalid input request");
  });

  it("loads a selected pending input and safely handles a failed lookup", async () => {
    await import("./index.js");
    const app = appMock.instance;
    if (app === undefined) {
      throw new Error("Expected an MCP App instance");
    }
    app.emit("toolresult", {
      structuredContent: {
        inputs: [
          {
            requestId: "00000000000000000000000003",
            runId: "00000000000000000000000004",
            source: "agent",
            mode: "form",
            round: 0,
            ageMs: 1,
            expiresAt: null,
          },
        ],
      },
      content: [],
    });

    document.querySelector("button")?.click();
    await vi.waitFor(() => {
      expect(app.callServerTool).toHaveBeenCalledWith({
        name: "get_input",
        arguments: { requestId: "00000000000000000000000003" },
      });
    });

    app.callServerTool.mockRejectedValueOnce(new Error("SYNTHETIC_LOOKUP_FAILURE"));
    app.emit("toolresult", {
      structuredContent: {
        inputs: [
          {
            requestId: "00000000000000000000000005",
            runId: "00000000000000000000000004",
            source: "mcp_legacy",
            serverId: "mcp.mail",
            mode: "form",
            round: 0,
            ageMs: 1,
            expiresAt: null,
          },
        ],
      },
      content: [],
    });
    document.querySelector("button")?.click();
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("Invalid input request");
    });
  });

  it("loads selected input details and follows host context and page lifecycle", async () => {
    await import("./index.js");
    const app = appMock.instance;
    if (app === undefined) {
      throw new Error("Expected an MCP App instance");
    }

    app.getHostContext.mockReturnValue({ theme: "dark", locale: "en" });
    app.emit("hostcontextchanged", {});
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");

    app.callServerTool.mockResolvedValueOnce({
      structuredContent: {
        requestId: "00000000000000000000000009",
        source: "agent",
        round: 0,
        mode: "form",
        message: "What is your name?",
      },
      content: [],
    });
    app.emit("toolresult", {
      structuredContent: {
        inputs: [
          {
            requestId: "00000000000000000000000009",
            runId: "00000000000000000000000004",
            source: "agent",
            mode: "form",
            round: 0,
            ageMs: 1,
            expiresAt: null,
          },
        ],
      },
      content: [],
    });
    document.querySelector("button")?.click();
    await vi.waitFor(() => {
      expect(document.querySelector("textarea")).not.toBeNull();
    });

    app.emit("toolresult", { content: [] });
    expect(document.body.textContent).toContain("Invalid input request");
    app.emit("toolresult", { structuredContent: {}, content: [] });
    expect(document.body.textContent).toContain("Invalid input request");

    const persistedPageHide = new Event("pagehide");
    Object.defineProperty(persistedPageHide, "persisted", { value: true });
    window.dispatchEvent(persistedPageHide);
    expect(document.body.firstElementChild).not.toBeNull();

    window.dispatchEvent(new Event("pagehide"));
    expect(document.body.firstElementChild).toBeNull();
    expect(app.removeEventListener).toHaveBeenCalledWith(
      "hostcontextchanged",
      expect.any(Function),
    );
  });

  it("handles answer and URL tool failures without exposing bridge errors", async () => {
    await import("./index.js");
    const app = appMock.instance;
    if (app === undefined) {
      throw new Error("Expected an MCP App instance");
    }

    app.emit("toolresult", {
      structuredContent: {
        requestId: "00000000000000000000000006",
        source: "agent",
        round: 0,
        mode: "form",
        message: "Provide a response.",
      },
      content: [],
    });
    app.callServerTool.mockResolvedValueOnce({
      content: [{ type: "text", text: '{"resolved":true}' }],
    });
    const firstResponse = document.querySelector<HTMLTextAreaElement>("textarea");
    const firstForm = document.querySelector("form");
    if (firstResponse === null || firstForm === null) {
      throw new Error("Expected the first response form");
    }
    firstResponse.value = "answer";
    firstForm.dispatchEvent(new Event("submit", { bubbles: true }));
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("Response submitted.");
    });

    app.emit("toolresult", {
      structuredContent: {
        requestId: "00000000000000000000000007",
        source: "mcp_mrtr",
        serverId: "mcp.accounts",
        round: 0,
        mode: "url",
        message: "Review this address.",
        url: "https://accounts.example.test/connect",
      },
      content: [],
    });
    app.openLink.mockResolvedValueOnce({ isError: true });
    const open = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Open URL",
    );
    const dialog = document.querySelector("dialog");
    if (open === undefined || dialog === null) {
      throw new Error("Expected URL confirmation controls");
    }
    Object.defineProperty(dialog, "showModal", { value: vi.fn() });
    open.click();
    dialog.querySelector<HTMLButtonElement>("button")?.click();
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("The host did not open the URL.");
    });

    app.openLink.mockRejectedValueOnce(new Error("SYNTHETIC_OPEN_FAILURE"));
    open.click();
    dialog.querySelector<HTMLButtonElement>("button")?.click();
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("The host did not open the URL.");
    });

    app.emit("toolresult", {
      structuredContent: {
        requestId: "00000000000000000000000008",
        source: "agent",
        round: 0,
        mode: "form",
        message: "Provide another response.",
      },
      content: [],
    });
    app.callServerTool.mockRejectedValueOnce(new Error("SYNTHETIC_ANSWER_FAILURE"));
    const secondResponse = document.querySelector<HTMLTextAreaElement>("textarea");
    const secondForm = document.querySelector("form");
    if (secondResponse === null || secondForm === null) {
      throw new Error("Expected the second response form");
    }
    secondResponse.value = "answer";
    secondForm.dispatchEvent(new Event("submit", { bubbles: true }));
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain(
        "The response could not be submitted. Try again.",
      );
    });
  });
});
