// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
import axe from "axe-core";
import type { JsonValue } from "@rovinos/schemas/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendTokenText,
  createConfirmationDialog,
  createDataTable,
  createElicitationForm,
  createFormFromSchema,
  createEmptyState,
  createErrorState,
  createMeter,
  createStatusBadge,
  createTimeline,
  createTokenPill,
  createUrlDisplay,
} from "./components.js";
import { applyHostContext } from "./theme.js";

const malicious = '<img src=x onerror="alert(1)"> javascript:alert(1)';

afterEach(() => {
  document.body.replaceChildren();
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-display-mode");
  document.documentElement.removeAttribute("style");
});

describe("shared MCP App components", () => {
  it("renders recognized token pills and leaves hostile text inert", () => {
    const token = createTokenPill(document, "<EMAIL_3>");
    const hostile = createTokenPill(document, malicious);
    expect(token.textContent).toBe("email 3");
    expect(token.getAttribute("aria-label")).toBe("<EMAIL_3>");
    expect(hostile.textContent).toBe(malicious);
    expect(hostile.querySelector("img")).toBeNull();

    const text = document.createElement("p");
    appendTokenText(text, `${malicious} <PHONE_2> <email_1>`);
    expect(text.textContent).toContain(malicious);
    expect(text.querySelectorAll("img")).toHaveLength(0);
    expect(text.querySelector('[aria-label="<PHONE_2>"]')?.textContent).toBe("phone 2");
  });

  it("renders and submits supported elicitation field types safely", () => {
    const onSubmit = vi.fn<(values: Readonly<Record<string, string | number | boolean>>) => void>();
    const form = createElicitationForm(
      document,
      {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string", title: malicious, description: malicious },
          count: { type: "integer" },
          enabled: { type: "boolean" },
          choice: { type: "string", enum: ["a", "b"] },
          level: { type: "number", enum: [1, 2] },
        },
      },
      onSubmit,
    );
    document.body.append(form);
    expect(form.querySelector("label")?.textContent).toBe(malicious);
    expect(form.querySelectorAll("img")).toHaveLength(0);
    expect(form.querySelectorAll("input, select")).toHaveLength(5);
    const inputs = form.querySelectorAll<HTMLInputElement>("input");
    const nameInput = inputs.item(0);
    const countInput = inputs.item(1);
    const enabledInput = inputs.item(2);
    nameInput.value = "Rovinos";
    countInput.value = "7";
    enabledInput.checked = true;
    const choice = form.querySelector("select");
    if (choice === null) {
      throw new Error("Expected the enum selector");
    }
    choice.value = "1";
    const level = form.querySelectorAll("select").item(1);
    level.value = "1";
    const window = document.defaultView;
    if (window === null) {
      throw new Error("Expected a jsdom window");
    }
    form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    expect(onSubmit).toHaveBeenCalledWith({
      name: "Rovinos",
      count: 7,
      enabled: true,
      choice: "b",
      level: 2,
    });
  });

  it("uses unique control and description IDs for each form instance", () => {
    const schema = {
      type: "object",
      properties: { name: { type: "string", description: "Name description" } },
    };
    const first = createElicitationForm(document, schema, vi.fn());
    const second = createElicitationForm(document, schema, vi.fn());
    document.body.append(first, second);

    const controls = [...document.querySelectorAll<HTMLInputElement>("input")];
    const descriptions = [...document.querySelectorAll("span")];
    expect(new Set(controls.map(({ id }) => id)).size).toBe(2);
    expect(new Set(descriptions.map(({ id }) => id)).size).toBe(2);
    for (const form of [first, second]) {
      const label = form.querySelector("label");
      const control = form.querySelector("input");
      const description = form.querySelector("span");
      expect(label?.htmlFor).toBe(control?.id);
      expect(control?.getAttribute("aria-describedby")).toBe(description?.id);
      expect(document.getElementById(control?.id ?? "")).toBe(control);
      expect(document.getElementById(description?.id ?? "")).toBe(description);
    }
  });

  it("submits false for a required boolean without native checkbox validation", () => {
    const onSubmit = vi.fn();
    const form = createElicitationForm(
      document,
      { type: "object", required: ["accepted"], properties: { accepted: { type: "boolean" } } },
      onSubmit,
    );
    const checkbox = form.querySelector<HTMLInputElement>("input[type=checkbox]");
    expect(checkbox?.required).toBe(false);
    const window = document.defaultView;
    if (window === null) {
      throw new Error("Expected a jsdom window");
    }
    form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith({ accepted: false });
  });

  it("omits blank optional numbers and rejects blank required numbers", () => {
    const onSubmit = vi.fn();
    const form = createElicitationForm(
      document,
      {
        type: "object",
        required: ["requiredCount"],
        properties: {
          optionalCount: { type: "number" },
          requiredCount: { type: "number" },
        },
      },
      onSubmit,
    );
    const inputs = form.querySelectorAll<HTMLInputElement>("input[type=number]");
    inputs.item(1).value = "3";
    const window = document.defaultView;
    if (window === null) {
      throw new Error("Expected a jsdom window");
    }
    form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith({ requiredCount: 3 });

    onSubmit.mockClear();
    inputs.item(1).value = "";
    form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("renders an error state for unsupported elicitation schemas", () => {
    const form = createElicitationForm(document, malicious, vi.fn());
    expect(form.querySelector('[role="alert"]')?.textContent).toContain("Something went wrong");
    expect(form.textContent).not.toContain(malicious);
    expect(form.querySelector("img")).toBeNull();
    const nested = createElicitationForm(
      document,
      { type: "object", properties: { nested: { type: "object" } } },
      vi.fn(),
    );
    expect(nested.querySelector('[role="alert"]')).not.toBeNull();
    const constrained = createElicitationForm(
      document,
      { type: "object", properties: { age: { type: "integer", minimum: 18 } } },
      vi.fn(),
    );
    expect(constrained.querySelector('[role="alert"]')).not.toBeNull();
  });

  it("bounds untrusted form schemas and ignores prototype keys safely", () => {
    const tooManyProperties = Object.fromEntries(
      Array.from({ length: 101 }, (_, index) => [`field${String(index)}`, { type: "string" }]),
    );
    expect(
      createElicitationForm(document, { type: "object", properties: tooManyProperties }, vi.fn())
        .textContent,
    ).toContain("Something went wrong");
    expect(
      createElicitationForm(
        document,
        { type: "object", properties: {}, required: ["name", 1] },
        vi.fn(),
      ).textContent,
    ).toContain("Something went wrong");

    const onSubmit = vi.fn<(values: Readonly<Record<string, string | number | boolean>>) => void>();
    const form = createElicitationForm(
      document,
      {
        type: "object",
        properties: Object.fromEntries([
          ["__proto__", { type: "string" }],
          ["value", { type: "string" }],
          ["count", { type: "number" }],
        ]),
      },
      onSubmit,
    );
    const controls = form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
      "input, textarea",
    );
    const fallback = controls.item(0);
    const count = controls.item(1);
    fallback.value = "value";
    count.value = "";
    const window = document.defaultView;
    if (window === null) {
      throw new Error("Expected a jsdom window");
    }
    form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    expect(onSubmit).toHaveBeenCalledWith({ value: "value" });
    onSubmit.mockClear();
    count.value = "1.5";
    form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    const submittedCall = onSubmit.mock.calls.at(-1);
    if (submittedCall === undefined) {
      throw new TypeError("Expected a successful form submission");
    }
    const submitted = submittedCall[0];
    expect(submitted).toMatchObject({ value: "value", count: 1.5 });
    expect(Object.hasOwn(submitted, "__proto__")).toBe(false);
    expect(Object.getPrototypeOf(submitted)).toBe(Object.prototype);
  });

  it("rejects fractional values for integer fields", () => {
    const onSubmit = vi.fn();
    const form = createElicitationForm(
      document,
      { type: "object", properties: { count: { type: "integer" } } },
      onSubmit,
    );
    const count = form.querySelector<HTMLInputElement>("input");
    if (count === null) {
      throw new Error("Expected an integer control");
    }
    count.value = "1.5";
    const window = document.defaultView;
    if (window === null) {
      throw new Error("Expected a jsdom window");
    }
    form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("renders and validates every shared form schema field and constraint", () => {
    const onSubmit = vi.fn<(values: Readonly<Record<string, JsonValue>>) => void>();
    const form = createFormFromSchema(
      document,
      {
        type: "object",
        required: ["name", "email", "count", "choice", "tags"],
        properties: {
          name: {
            type: "string",
            title: malicious,
            description: malicious,
            minLength: 2,
            maxLength: 8,
            default: "Rovinos",
          },
          email: { type: "string", format: "email", default: "person@example.test" },
          count: { type: "integer", minimum: 1, maximum: 10, default: 3 },
          score: { type: "number", minimum: 0.5, maximum: 5.5, default: 2.5 },
          enabled: { type: "boolean", default: true },
          choice: {
            type: "string",
            oneOf: [
              { const: "safe", title: malicious },
              { const: "other", title: "Other" },
            ],
            default: "safe",
          },
          tags: {
            type: "array",
            items: {
              type: "string",
              anyOf: [
                { const: "one", title: malicious },
                { const: "two", title: "Two" },
              ],
            },
            minItems: 1,
            maxItems: 2,
            default: ["one"],
          },
        },
      },
      onSubmit,
    );
    document.body.append(form);
    expect(form.querySelectorAll("img")).toHaveLength(0);
    expect(form.querySelector("label")?.textContent).toBe(malicious);
    expect(form.querySelectorAll("option")[0]?.textContent).toBe(malicious);
    expect(form.querySelector<HTMLInputElement>('input[name="email"]')?.type).toBe("email");
    expect(form.querySelector<HTMLInputElement>('input[name="count"]')?.step).toBe("1");
    expect(form.querySelector<HTMLInputElement>('input[name="score"]')?.step).toBe("any");
    expect(form.querySelector<HTMLInputElement>('input[name="enabled"]')?.checked).toBe(true);
    expect(form.querySelector<HTMLSelectElement>('select[name="choice"]')?.value).toBe("0");
    expect(form.querySelector<HTMLSelectElement>('select[name="tags"]')?.value).toBe("0");
    expect(form.querySelector<HTMLInputElement>('input[name="name"]')?.value).toBe("Rovinos");
    expect(form.querySelector<HTMLInputElement>('input[name="name"]')?.minLength).toBe(2);
    expect(form.querySelector<HTMLInputElement>('input[name="name"]')?.maxLength).toBe(8);

    const window = document.defaultView;
    if (window === null) {
      throw new Error("Expected a jsdom window");
    }
    form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith({
      name: "Rovinos",
      email: "person@example.test",
      count: 3,
      score: 2.5,
      enabled: true,
      choice: "safe",
      tags: ["one"],
    });

    onSubmit.mockClear();
    const name = form.querySelector<HTMLInputElement>('input[name="name"]');
    if (name === null) {
      throw new Error("Expected the name control");
    }
    name.value = "x";
    form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(name.getAttribute("aria-invalid")).toBe("true");
    expect(form.querySelector('[role="alert"]')?.textContent).toContain("highlighted fields");

    name.value = "RovinosTooLong";
    form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(name.getAttribute("aria-invalid")).toBe("true");

    name.value = "Rovinos";
    const count = form.querySelector<HTMLInputElement>('input[name="count"]');
    const score = form.querySelector<HTMLInputElement>('input[name="score"]');
    if (count === null || score === null) {
      throw new Error("Expected numeric controls");
    }
    count.value = "0";
    form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(count.getAttribute("aria-invalid")).toBe("true");

    count.value = "3";
    score.value = "6";
    form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(score.getAttribute("aria-invalid")).toBe("true");
  });

  it("does not implicitly select an optional enum without a default", () => {
    const onSubmit = vi.fn();
    const form = createFormFromSchema(
      document,
      {
        type: "object",
        properties: { choice: { type: "string", enum: ["one", "two"] } },
      },
      onSubmit,
    );
    const choice = form.querySelector<HTMLSelectElement>("select");
    if (choice === null) {
      throw new Error("Expected an enum selector");
    }
    expect(choice.selectedIndex).toBe(-1);
    const window = document.defaultView;
    if (window === null) {
      throw new Error("Expected a jsdom window");
    }
    form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith({});
  });

  it("validates string formats, patterns, and multi-select bounds", () => {
    const onSubmit = vi.fn();
    const form = createFormFromSchema(
      document,
      {
        type: "object",
        required: ["code", "website", "date", "dateTime", "tags"],
        properties: {
          code: { type: "string", pattern: "^[A-Z]{3}$", default: "ABC" },
          website: { type: "string", format: "uri", default: "https://example.test" },
          date: { type: "string", format: "date", default: "2026-03-04" },
          dateTime: { type: "string", format: "date-time", default: "2026-03-04T12:30:00Z" },
          tags: {
            type: "array",
            items: { type: "string", enum: ["one", "two", "three"] },
            minItems: 1,
            maxItems: 2,
            default: ["one"],
          },
        },
      },
      onSubmit,
    );
    document.body.append(form);
    const window = document.defaultView;
    if (window === null) {
      throw new Error("Expected a jsdom window");
    }
    const submit = (): void => {
      form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    };

    submit();
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(form.querySelector<HTMLInputElement>('input[name="date"]')?.type).toBe("date");
    expect(form.querySelector<HTMLInputElement>('input[name="dateTime"]')?.type).toBe(
      "datetime-local",
    );

    onSubmit.mockClear();
    const code = form.querySelector<HTMLInputElement>('input[name="code"]');
    const website = form.querySelector<HTMLInputElement>('input[name="website"]');
    const date = form.querySelector<HTMLInputElement>('input[name="date"]');
    const dateTime = form.querySelector<HTMLInputElement>('input[name="dateTime"]');
    const tags = form.querySelector<HTMLSelectElement>('select[name="tags"]');
    if (code === null || website === null || date === null || dateTime === null || tags === null) {
      throw new Error("Expected all constrained form controls");
    }

    code.value = "abc";
    submit();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(code.getAttribute("aria-invalid")).toBe("true");

    code.value = "ABC";
    website.value = "not-a-url";
    submit();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(website.getAttribute("aria-invalid")).toBe("true");

    website.value = "https://example.test";
    date.value = "";
    submit();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(date.getAttribute("aria-invalid")).toBe("true");

    date.value = "2026-03-04";
    dateTime.value = "";
    submit();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(dateTime.getAttribute("aria-invalid")).toBe("true");

    dateTime.value = "2026-03-04T12:30";
    for (const option of Array.from(tags.options)) {
      option.selected = false;
    }
    submit();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(tags.getAttribute("aria-invalid")).toBe("true");

    for (const option of Array.from(tags.options)) {
      option.selected = true;
    }
    submit();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(tags.getAttribute("aria-invalid")).toBe("true");

    tags.options.item(2).selected = false;
    submit();
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({
      code: "ABC",
      website: "https://example.test",
      date: "2026-03-04",
      tags: ["one", "two"],
    });
  });

  it("renders data in a native keyboard-scrollable table without interpreting markup", () => {
    const table = createDataTable(
      document,
      malicious,
      [{ key: "name", label: "Name" }],
      [{ name: malicious }, {}],
    );
    expect(table.tabIndex).toBe(0);
    expect(table.querySelector("caption")?.textContent).toBe(malicious);
    expect(table.querySelector("td")?.textContent).toBe(malicious);
    expect([...table.querySelectorAll("tbody tr")][1]?.textContent).toBe("");
    expect(table.querySelectorAll("img")).toHaveLength(0);
    expect(table.querySelector("table")?.querySelector("thead th")?.textContent).toBe("Name");
  });

  it("renders localized timeline dates and safe descriptions", () => {
    const timeline = createTimeline(document, {
      label: "Run history",
      items: [{ title: malicious, description: malicious, at: Date.UTC(2026, 0, 2) }],
      locale: "en-US",
      timeZone: "UTC",
    });
    expect(timeline.getAttribute("aria-label")).toBe("Run history");
    expect(timeline.querySelector("time")?.textContent).toContain("Jan");
    expect(timeline.textContent).toContain(malicious);
    expect(timeline.querySelector("img")).toBeNull();
  });

  it("creates accessible status badges and clamps meters to their range", () => {
    const badge = createStatusBadge(document, "success", malicious);
    const meter = createMeter(document, "Progress", 120, 100);
    expect(badge.getAttribute("role")).toBe("status");
    expect(badge.textContent).toBe(malicious);
    expect(meter.querySelector("meter")?.value).toBe(100);
    expect(meter.querySelector("meter")?.getAttribute("aria-label")).toBe("Progress");
    expect(createMeter(document, "Empty", Number.NaN, 0).querySelector("meter")?.value).toBe(0);
  });

  it("highlights only the domain of safe web URLs and renders other input as text", () => {
    const url = createUrlDisplay(document, "https://example.test/a?x=1");
    const credentialUrl = createUrlDisplay(document, "https://example.test@example.test:8443/a");
    const javascript = createUrlDisplay(document, "javascript:alert(1)");
    const malformed = createUrlDisplay(document, malicious);
    expect(url.querySelector("strong")?.textContent).toBe("example.test");
    expect(url.textContent).toBe("https://example.test/a?x=1");
    expect(credentialUrl.querySelector("strong")?.textContent).toBe("example.test");
    expect(credentialUrl.textContent).toBe("https://example.test@example.test:8443/a");
    expect(url.querySelector("a")).toBeNull();
    expect(javascript.textContent).toBe("javascript:alert(1)");
    expect(malformed.querySelectorAll("img")).toHaveLength(0);
    expect(malformed.textContent).toBe(malicious);
  });

  it("runs confirmation dialog callbacks from keyboard-operable buttons", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const dialog = createConfirmationDialog(document, {
      title: "Confirm",
      message: malicious,
      confirmLabel: "Continue",
      cancelLabel: "Cancel",
      onConfirm,
      onCancel,
    });
    document.body.append(dialog);
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-labelledby")).toBe(dialog.querySelector("h2")?.id);
    expect(dialog.querySelector("p")?.textContent).toBe(malicious);
    dialog.querySelectorAll("button")[0]?.click();
    dialog.querySelectorAll("button")[1]?.click();
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("names multiple confirmation dialogs uniquely and handles Escape cancellation", () => {
    const onCancel = vi.fn();
    const first = createConfirmationDialog(document, {
      title: "First action",
      message: "Confirm the first action",
      confirmLabel: "Continue",
      cancelLabel: "Cancel",
      onConfirm: vi.fn(),
      onCancel,
    });
    const second = createConfirmationDialog(document, {
      title: "Second action",
      message: "Confirm the second action",
      confirmLabel: "Continue",
      cancelLabel: "Cancel",
      onConfirm: vi.fn(),
      onCancel,
    });
    document.body.append(first, second);
    const firstTitleId = first.querySelector("h2")?.id;
    const secondTitleId = second.querySelector("h2")?.id;
    expect(firstTitleId).not.toBe(secondTitleId);
    expect(first.getAttribute("aria-labelledby")).toBe(firstTitleId);
    expect(second.getAttribute("aria-labelledby")).toBe(secondTitleId);

    const window = document.defaultView;
    if (window === null) {
      throw new Error("Expected a jsdom window");
    }
    second.dispatchEvent(new window.Event("cancel", { cancelable: true }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("provides localized empty and error states", () => {
    const empty = createEmptyState(document);
    const error = createErrorState(document, malicious);
    expect(empty.getAttribute("role")).toBe("status");
    expect(empty.textContent).toContain("Nothing to show");
    expect(error.getAttribute("role")).toBe("alert");
    expect(error.textContent).toContain(malicious);
    expect(error.querySelector("img")).toBeNull();
  });

  it.each(["light", "dark"] as const)("passes axe in the %s theme", async (theme) => {
    const root = document.documentElement;
    applyHostContext(root, {
      theme,
      displayMode: "inline",
      locale: "en-US",
      timeZone: "UTC",
    });
    document.title = "Shared components";
    const main = document.createElement("main");
    main.append(
      createTokenPill(document, "<EMAIL_1>"),
      createElicitationForm(
        document,
        { type: "object", properties: { name: { type: "string" } } },
        vi.fn(),
      ),
      createDataTable(document, "Runs", [{ key: "id", label: "Run ID" }], [{ id: "run-1" }]),
      createTimeline(document, { label: "Run history", items: [{ title: "Created" }] }),
      createStatusBadge(document, "info", "Ready"),
      createMeter(document, "Progress", 3, 5),
      createConfirmationDialog(document, {
        title: "Confirm action",
        message: "Continue?",
        confirmLabel: "Confirm",
        cancelLabel: "Cancel",
        onConfirm: vi.fn(),
      }),
      createUrlDisplay(document, "https://example.test/path"),
      createEmptyState(document),
      createErrorState(document),
    );
    document.body.append(main);
    const result = await axe.run(document, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(result.violations).toEqual([]);
  });
});
