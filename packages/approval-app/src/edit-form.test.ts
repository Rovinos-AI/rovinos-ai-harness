// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
import axe from "axe-core";
import { describe, expect, it, vi } from "vitest";
import type { ApprovalPayload } from "@harness/schemas/browser";
import { createEditForm } from "./edit-form.js";

const payload: ApprovalPayload = {
  payloadVersion: 1,
  kind: "tool_call",
  callId: "00000000000000000000000002",
  toolId: "settings.update",
  ruleId: "settings.review",
  reason: "approval_required",
  summary: "Review settings",
  args: {
    "profile/name": "<EMAIL_1>",
    count: 2,
    active: false,
    settings: { theme: "dark" },
    items: ["old"],
  },
  ui: { resourceUri: "ui://harness/approval/v1", fallbackText: "Review settings" },
  editableFields: ["/profile~1name", "/count", "/active", "/settings", "/items/0", "/missing"],
};

describe("approval edit form", () => {
  it("builds accessible typed controls and displays tokenized current values", () => {
    const form = createEditForm(document, payload, vi.fn());
    expect(form.querySelectorAll("label")).toHaveLength(payload.editableFields.length);
    expect(form.querySelector<HTMLInputElement>('input[type="text"]')?.value).toBe("<EMAIL_1>");
    expect(form.querySelector<HTMLInputElement>('input[type="number"]')?.value).toBe("2");
    expect(form.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(false);
    expect(form.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe('{"theme":"dark"}');
    expect(form.textContent).toContain('Current tokenized value: "<EMAIL_1>"');
    expect(form.textContent).toContain("Current tokenized value: (not set)");
    expect(
      form.querySelector<HTMLHeadingElement>('[aria-labelledby="approval-edit-heading"] h2')
        ?.textContent,
    ).toBe("Edit approval");
  });

  it("submits only changed values with their original JSON types", () => {
    const onSubmit = vi.fn();
    const form = createEditForm(document, payload, onSubmit);
    const text = form.querySelector<HTMLInputElement>("#approval-edit-0");
    const number = form.querySelector<HTMLInputElement>("#approval-edit-1");
    const checkbox = form.querySelector<HTMLInputElement>("#approval-edit-2");
    const object = form.querySelector<HTMLTextAreaElement>("#approval-edit-3");
    if (text === null || number === null || checkbox === null || object === null) {
      throw new Error("Expected an edit control for each field type");
    }
    text.value = "updated@example.test";
    number.value = "4.5";
    checkbox.checked = true;
    object.value = '{"theme":"light"}';
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith([
      { pointer: "/profile~1name", value: "updated@example.test" },
      { pointer: "/count", value: 4.5 },
      { pointer: "/active", value: true },
      { pointer: "/settings", value: { theme: "light" } },
    ]);
  });

  it("rejects invalid number and JSON input without submitting", () => {
    const onSubmit = vi.fn();
    const form = createEditForm(document, payload, onSubmit);
    const number = form.querySelector<HTMLInputElement>("#approval-edit-1");
    const object = form.querySelector<HTMLTextAreaElement>("#approval-edit-3");
    if (number === null || object === null) {
      throw new Error("Expected number and JSON controls");
    }
    number.value = "";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(form.querySelector('[role="alert"]')?.textContent).toBe("Enter a valid value.");
    expect(onSubmit).not.toHaveBeenCalled();
    number.value = "2";
    object.value = "{invalid";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(form.querySelector('[role="alert"]')?.textContent).toBe("Enter a valid value.");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("submits an explicitly added value and removes on cancel", () => {
    const onSubmit = vi.fn();
    const form = createEditForm(document, payload, onSubmit);
    const missing = form.querySelector<HTMLInputElement>("#approval-edit-5");
    if (missing === null) {
      throw new Error("Expected a control for a not-yet-set field");
    }
    missing.value = "new value";
    missing.dispatchEvent(new Event("input", { bubbles: true }));
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(onSubmit).toHaveBeenCalledWith([{ pointer: "/missing", value: "new value" }]);
    document.body.append(form);
    form.querySelector<HTMLButtonElement>("button:last-child")?.click();
    expect(document.body.contains(form)).toBe(false);
  });

  it("submits from a non-native button so the sandbox cannot trigger form navigation", () => {
    const onSubmit = vi.fn();
    const form = createEditForm(document, payload, onSubmit);
    const input = form.querySelector<HTMLInputElement>("#approval-edit-0");
    const submit = [...form.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Submit edits",
    );
    if (input === null || submit === undefined) {
      throw new Error("Expected edit input and submit control");
    }

    input.value = "updated@example.test";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(submit.textContent).toBe("Submit edits");
    submit.click();
    expect(onSubmit).toHaveBeenCalledWith([
      { pointer: "/profile~1name", value: "updated@example.test" },
    ]);
  });

  it("submits single-line inputs on Enter without intercepting IME or JSON newlines", () => {
    const onSubmit = vi.fn();
    const form = createEditForm(document, payload, onSubmit);
    const input = form.querySelector<HTMLInputElement>("#approval-edit-0");
    const textarea = form.querySelector<HTMLTextAreaElement>("#approval-edit-3");
    if (input === null || textarea === null) {
      throw new Error("Expected single-line and JSON edit controls");
    }
    input.value = "updated@example.test";
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    input.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(true);
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith([
      { pointer: "/profile~1name", value: "updated@example.test" },
    ]);

    onSubmit.mockClear();
    const composing = new KeyboardEvent("keydown", {
      key: "Enter",
      isComposing: true,
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(composing);
    expect(composing.defaultPrevented).toBe(false);
    expect(onSubmit).not.toHaveBeenCalled();

    const newline = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    });
    textarea.dispatchEvent(newline);
    expect(newline.defaultPrevented).toBe(false);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("labels the root pointer as all arguments and passes axe", async () => {
    const rootPayload: ApprovalPayload = {
      ...payload,
      args: { name: "before" },
      editableFields: [""],
    };
    const onSubmit = vi.fn();
    const form = createEditForm(document, rootPayload, onSubmit);
    const label = form.querySelector("label");
    const input = form.querySelector<HTMLTextAreaElement>("textarea");
    expect(label?.textContent).toBe("All arguments");
    expect(label?.htmlFor).toBe("approval-edit-0");
    expect(input?.id).toBe("approval-edit-0");
    if (input === null) {
      throw new Error("Expected a root JSON edit control");
    }
    input.value = '{"name":"after"}';
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith([{ pointer: "", value: { name: "after" } }]);

    document.documentElement.lang = "en";
    document.title = "Approval edit";
    document.body.replaceChildren(form);
    const result = await axe.run(form);
    expect(result.violations).toEqual([]);
  });
});
