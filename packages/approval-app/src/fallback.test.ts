// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApprovalFallback } from "./fallback.js";

const originalClipboard = Object.getOwnPropertyDescriptor(Navigator.prototype, "clipboard");

afterEach(() => {
  if (originalClipboard === undefined) {
    Reflect.deleteProperty(Navigator.prototype, "clipboard");
  } else {
    Object.defineProperty(Navigator.prototype, "clipboard", originalClipboard);
  }
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("approval fallback", () => {
  it("renders plain-text instructions and approval-specific CLI commands", () => {
    const fallback = createApprovalFallback(document.body);
    fallback.show("<img src=x onerror=alert(1)>", "00000000000000000000000001");

    expect(document.querySelector("img")).toBeNull();
    expect(document.body.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(document.querySelector<HTMLInputElement>('[aria-label="Approve command"]')?.value).toBe(
      "harness approvals approve 00000000000000000000000001",
    );
    expect(document.querySelector<HTMLInputElement>('[aria-label="Deny command"]')?.value).toBe(
      "harness approvals deny 00000000000000000000000001",
    );

    fallback.hide();
    expect(document.querySelector("section[aria-labelledby]")?.hasAttribute("hidden")).toBe(true);
    fallback.dispose();
    expect(document.querySelector("section[aria-labelledby]")).toBeNull();
  });

  it("uses the id placeholder and selects the command when clipboard access is unavailable", async () => {
    const fallback = createApprovalFallback(document.body);
    fallback.show();
    const copy = document.querySelector<HTMLButtonElement>('[aria-label="Copy approve command"]');
    const command = document.querySelector<HTMLInputElement>('[aria-label="Approve command"]');

    copy?.click();
    await vi.waitFor(() => {
      expect(document.activeElement).toBe(command);
      expect(command?.selectionStart).toBe(0);
      expect(command?.selectionEnd).toBe(command?.value.length);
    });
    expect(command?.value).toBe("harness approvals approve <id>");
    expect(document.body.textContent).toContain("Copy unavailable.");
    fallback.dispose();
  });

  it("copies a command when the guarded clipboard API succeeds", async () => {
    const writeText = vi.fn<Clipboard["writeText"]>().mockResolvedValue(undefined);
    Object.defineProperty(Navigator.prototype, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const fallback = createApprovalFallback(document.body);
    fallback.show("Review the pending action.", "00000000000000000000000002");

    document.querySelector<HTMLButtonElement>('[aria-label="Copy deny command"]')?.click();
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("Command copied.");
    });
    expect(writeText).toHaveBeenCalledExactlyOnceWith("harness approvals deny 00000000000000000000000002");
    fallback.dispose();
  });

  it("selects the command after a clipboard rejection", async () => {
    const writeText = vi.fn<Clipboard["writeText"]>().mockRejectedValue(new Error("clipboard"));
    Object.defineProperty(Navigator.prototype, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const fallback = createApprovalFallback(document.body);
    fallback.show();
    const command = document.querySelector<HTMLInputElement>('[aria-label="Deny command"]');

    document.querySelector<HTMLButtonElement>('[aria-label="Copy deny command"]')?.click();
    await vi.waitFor(() => {
      expect(document.activeElement).toBe(command);
    });
    expect(document.body.textContent).toContain("selected for manual copying.");
    fallback.dispose();
  });
});
