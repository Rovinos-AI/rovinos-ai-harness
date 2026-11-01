// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
import axe from "axe-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInputView, type InputViewOptions } from "./view.js";

const requestId = "00000000000000000000000001";
const malicious = '<img src=x onerror="alert(1)">';

function formRequest() {
  return {
    requestId,
    source: "mcp_mrtr",
    serverId: "mcp.mail",
    round: 0,
    mode: "form",
    message: `Confirm this value <EMAIL_1> ${malicious}`,
    schema: {
      type: "object",
      required: ["email"],
      properties: {
        email: { type: "string", title: malicious, format: "email", default: "one@example.test" },
        choice: { type: "string", enum: [malicious, "safe"] },
      },
    },
  };
}

function inputOptions(overrides: Partial<InputViewOptions> = {}): InputViewOptions {
  return {
    onAnswer: vi.fn(() => Promise.resolve(true)),
    onInputAction: vi.fn(),
    onOpenLink: vi.fn(() => Promise.resolve(true)),
    onSelect: vi.fn(),
    onError: vi.fn(),
    ...overrides,
  };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("input MCP App view", () => {
  it("renders a tokenized message and hostile field labels as inert text", () => {
    const options = inputOptions();
    const view = createInputView(document.body, options);
    expect(view.receive(formRequest())).toBe(true);

    expect(document.querySelector("h1")?.textContent).toBe("Input from mcp.mail");
    expect(document.querySelector('[aria-label="<EMAIL_1>"]')?.textContent).toBe("email 1");
    expect(document.body.textContent).toContain(malicious);
    expect(document.body.querySelectorAll("img")).toHaveLength(0);
    expect(document.querySelectorAll("a")).toHaveLength(0);
    expect(document.querySelector<HTMLInputElement>('input[name="email"]')?.value).toBe(
      "one@example.test",
    );
    expect(document.querySelector("label")?.textContent).toBe(malicious);
    expect(document.querySelectorAll("option")[0]?.textContent).toBe(malicious);
    expect(options.onError).not.toHaveBeenCalled();
  });

  it("submits distinct decline and cancel actions", async () => {
    const onAnswer = vi.fn(() => Promise.resolve(true));
    const view = createInputView(document.body, inputOptions({ onAnswer }));
    view.receive(formRequest());

    const decline = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Decline",
    );
    decline?.click();
    await vi.waitFor(() => {
      expect(onAnswer).toHaveBeenCalledWith({ requestId, action: "decline" });
    });

    view.receive(formRequest());
    const cancel = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Cancel",
    );
    cancel?.click();
    await vi.waitFor(() => {
      expect(onAnswer).toHaveBeenCalledWith({ requestId, action: "cancel" });
    });
  });

  it("keeps the URL non-clickable and requests the host only after confirmation", async () => {
    const onOpenLink = vi.fn(() => Promise.resolve(true));
    const onAnswer = vi.fn(() => Promise.resolve(true));
    const onInputAction = vi.fn();
    const view = createInputView(
      document.body,
      inputOptions({ onOpenLink, onAnswer, onInputAction }),
    );
    view.receive({
      requestId,
      source: "mcp_mrtr",
      serverId: "mcp.accounts",
      round: 0,
      mode: "url",
      message: `Continue at https://login.example.co.uk/connect ${malicious}`,
      url: "https://login.example.co.uk/connect",
    });

    expect(document.querySelector("a")).toBeNull();
    expect(document.body.textContent).toContain("https://login.example.co.uk/connect");
    expect(document.querySelector("strong")?.textContent).toBe("example.co.uk");
    expect(document.body.querySelectorAll("img")).toHaveLength(0);
    document.querySelector<HTMLButtonElement>("button")?.click();
    expect(onOpenLink).not.toHaveBeenCalled();

    const dialog = document.querySelector("dialog");
    if (dialog === null) {
      throw new Error("Expected an open-link confirmation dialog");
    }
    Object.defineProperty(dialog, "showModal", { value: vi.fn() });
    document.querySelector<HTMLButtonElement>("button")?.click();
    expect(onOpenLink).not.toHaveBeenCalled();
    dialog.querySelector<HTMLButtonElement>("button")?.click();
    await vi.waitFor(() => {
      expect(onOpenLink).toHaveBeenCalledExactlyOnceWith("https://login.example.co.uk/connect");
      expect(document.body.textContent).toContain("I'm done");
    });
    [...document.querySelectorAll("button")]
      .find((button) => button.textContent === "I'm done")
      ?.click();
    await vi.waitFor(() => {
      expect(onAnswer).toHaveBeenCalledWith({ requestId, action: "accept" });
    });
    expect(onInputAction).toHaveBeenLastCalledWith("done");
  });

  it("warns about suspicious URL hosts and never opens unsupported schemes", () => {
    const onOpenLink = vi.fn(() => Promise.resolve(true));
    const view = createInputView(document.body, inputOptions({ onOpenLink }));
    view.receive({
      requestId,
      source: "mcp_legacy",
      serverId: "mcp.accounts",
      round: 0,
      mode: "url",
      message: "Review the requested address.",
      url: "javascript:alert(1)",
    });

    expect(document.body.textContent).toContain("This host may be suspicious");
    expect(document.querySelector<HTMLButtonElement>("button")?.disabled).toBe(true);
    expect(document.querySelector("a")).toBeNull();
    expect(onOpenLink).not.toHaveBeenCalled();
  });

  it("renders pending input listings and routes selection to get_input", () => {
    const onSelect = vi.fn();
    const view = createInputView(document.body, inputOptions({ onSelect }));
    view.receive({
      inputs: [
        {
          requestId,
          runId: "00000000000000000000000002",
          source: "agent",
          mode: "form",
          round: 0,
          ageMs: 1,
          expiresAt: null,
        },
      ],
    });
    document.querySelector("button")?.click();
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(requestId);
  });

  it("passes axe checks for form and URL states", async () => {
    const view = createInputView(document.body, inputOptions());
    view.receive(formRequest());
    expect((await axe.run(document.body)).violations).toEqual([]);

    view.receive({
      requestId,
      source: "mcp_mrtr",
      serverId: "mcp.accounts",
      round: 0,
      mode: "url",
      message: "Review the requested address.",
      url: "https://accounts.example.test/connect",
    });
    expect((await axe.run(document.body)).violations).toEqual([]);
  });

  it("rejects malformed bridge data without rendering it", () => {
    const options = inputOptions();
    const view = createInputView(document.body, options);
    expect(view.receive({ message: malicious })).toBe(false);
    expect(options.onError).toHaveBeenCalledExactlyOnceWith("payload_invalid");
    expect(document.body.querySelector("img")).toBeNull();
    expect(document.body.textContent).not.toContain(malicious);
  });
});
