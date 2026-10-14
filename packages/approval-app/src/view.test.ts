// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
import axe from "axe-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApprovalView } from "./view.js";

const payload = {
  payloadVersion: 1,
  kind: "tool_call",
  callId: "00000000000000000000000001",
  toolId: "mail.send",
  ruleId: "mail.review",
  reason: "external_recipient",
  summary: "Review pending mail",
  args: { to: "<EMAIL_1>", nested: ["Contact <PHONE_2>", true, 42, null, {}] },
  ui: { resourceUri: "ui://harness/approval/v1", fallbackText: "Review pending mail" },
  editableFields: ["/to"],
  expiresAt: 5000,
};

function setup(input: unknown = payload) {
  let now = 1000;
  const onError = vi.fn();
  const view = createApprovalView(document.body, { clock: { now: () => now }, onError });
  view.receive(input);
  return {
    view,
    onError,
    advance: (time: number) => {
      now = time;
      view.tick();
    },
  };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("approval view", () => {
  it("renders metadata, nested arguments, accessible token pills, and real buttons", () => {
    setup();
    expect(document.querySelector("h1")?.textContent).toBe(payload.summary);
    expect(document.activeElement).toBe(document.querySelector("h1"));
    for (const text of [
      "mail.send",
      "mail.review",
      "external_recipient",
      "4 seconds remaining",
      "true",
      "42",
      "null",
    ]) {
      expect(document.body.textContent).toContain(text);
    }
    const emailToken = document.querySelector('[aria-label="<EMAIL_1>"]');
    expect(emailToken?.textContent).toBe("email 1");
    expect(emailToken?.previousElementSibling?.textContent).toBe('"');
    expect(emailToken?.nextElementSibling?.textContent).toBe('"');
    expect(document.querySelector('[aria-label="<PHONE_2>"]')?.textContent).toBe("phone 2");
    expect(document.querySelectorAll("details").length).toBeGreaterThan(1);
    const details = document.querySelector("details");
    expect(details?.open).toBe(true);
    details?.querySelector("summary")?.click();
    expect(details?.open).toBe(false);
    expect([...document.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
      "Approve",
      "Deny",
      "Edit",
    ]);
    expect(
      [...document.querySelectorAll("button")].every(
        (button) => button.type === "button" && !button.disabled,
      ),
    ).toBe(true);
  });

  it("hides edit when the policy did not permit it and supports payloads without expiry", () => {
    const withoutExpiry: Partial<typeof payload> = { ...payload };
    delete withoutExpiry.expiresAt;
    setup({ ...withoutExpiry, editableFields: [], args: "plain text" });
    expect([...document.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
      "Approve",
      "Deny",
    ]);
    expect(document.body.textContent).toContain("No expiry");
    expect(document.body.textContent).toContain("plain text");
  });

  it("distinguishes JSON strings, primitives, arrays, objects, and empty containers", () => {
    setup({
      ...payload,
      args: {
        stringFalse: "false",
        booleanFalse: false,
        emptyArray: [],
        emptyObject: {},
        oneArray: ["x"],
        numericObject: { "0": "x" },
        escapedString: 'quote " backslash \\ line\n',
      },
    });
    expect(document.body.textContent).toContain('stringFalse: "false"');
    expect(document.body.textContent).toContain("booleanFalse: false");
    expect(document.body.textContent).toContain(
      `escapedString: ${JSON.stringify('quote " backslash \\ line\n')}`,
    );
    expect([...document.querySelectorAll("summary")].map((summary) => summary.textContent)).toEqual(
      [
        "Arguments (object)",
        "emptyArray (array, 0 items, empty)",
        "emptyObject (object, empty)",
        "oneArray (array, 1 item)",
        "numericObject (object)",
      ],
    );
    expect(
      [...document.querySelectorAll("div")].filter((div) => div.textContent === '0: "x"'),
    ).toHaveLength(2);
  });

  it.each([4999, 5000, 7000])(
    "expires on the clock boundary at %i and disables every action",
    (time) => {
      const { advance } = setup();
      advance(time);
      expect([...document.querySelectorAll("button")].every((button) => button.disabled)).toBe(
        time >= 5000,
      );
      expect(document.querySelector('[role="status"]')?.textContent).toBe(
        time >= 5000 ? "Approval expired" : "Pending approval",
      );
    },
  );

  it("disables actions when a payload arrives already expired", () => {
    setup({ ...payload, expiresAt: 0 });
    expect(document.body.textContent).toContain("Approval expired");
    expect([...document.querySelectorAll("button")].every((button) => button.disabled)).toBe(true);
  });

  it("updates the live region only when status changes, not on every countdown tick", () => {
    const { advance } = setup();
    const status = document.querySelector('[role="status"]');
    const pendingText = status?.firstChild;
    advance(2000);
    expect(status?.firstChild).toBe(pendingText);
    advance(5000);
    expect(status?.textContent).toBe("Approval expired");
    const expiredText = status?.firstChild;
    advance(6000);
    expect(status?.firstChild).toBe(expiredText);
  });

  it("preserves the live-region text node for repeated invalid payloads", () => {
    const { view } = setup();
    view.receive({});
    const status = document.querySelector('[role="status"]');
    const invalidText = status?.firstChild;
    view.receive({});
    expect(status?.textContent).toBe("Invalid approval payload");
    expect(status?.firstChild).toBe(invalidText);
  });

  it("renders malicious strings and keys only as text, including tokens in the heading", () => {
    const hostile = "<img src=x onerror=alert(1)> javascript:alert(1)";
    setup({
      ...payload,
      summary: `${hostile} <EMAIL_1>`,
      args: { [hostile]: `${hostile} <CUSTOM_ID_123456> <email_1> <EMAIL_0>` },
    });
    expect(document.querySelector("h1")?.textContent).toContain(hostile);
    expect(document.body.textContent).toContain(hostile);
    expect(document.body.textContent).toContain("<email_1> <EMAIL_0>");
    expect(document.querySelector('[aria-label="<CUSTOM_ID_123456>"]')?.textContent).toBe(
      "custom id 123456",
    );
    expect(document.querySelectorAll("img, script, a, [src], [href], [onerror]").length).toBe(0);
  });

  it("refuses invalid payloads without exposing their values or validation details", () => {
    const { view, onError, advance } = setup();
    view.receive({
      ...payload,
      summary: "SYNTHETIC_PRIVATE_CANARY",
      toolId: "<script>bad</script>",
    });
    advance(10000);
    expect(document.body.textContent).toContain("Invalid approval payload");
    expect(document.body.textContent).not.toContain("SYNTHETIC_PRIVATE_CANARY");
    expect(document.querySelectorAll("button, details").length).toBe(0);
    expect(onError).toHaveBeenCalledExactlyOnceWith("payload_invalid");
    expect(JSON.stringify(onError.mock.calls)).not.toContain("SYNTHETIC_PRIVATE_CANARY");
    view.receive({ ...payload, expiresAt: 20000 });
    expect(document.body.textContent).toContain("Pending approval");
  });

  it("starts with a focused heading and a live waiting state", () => {
    const view = createApprovalView(document.body, { clock: { now: () => 0 }, onError: vi.fn() });
    view.tick();
    expect(document.activeElement).toBe(document.querySelector("h1"));
    expect(document.querySelector('[role="status"]')?.textContent).toBe("Waiting for host");
  });

  it.each(["pending", "expired", "invalid", "waiting", "readonly"])(
    "has no axe violations in the %s state",
    async (state) => {
      document.documentElement.lang = "en";
      document.title = "Approval";
      const view = createApprovalView(document.body, {
        clock: { now: () => 1000 },
        onError: vi.fn(),
      });
      if (state !== "waiting") {
        view.receive(
          state === "invalid"
            ? {}
            : {
                ...payload,
                expiresAt: state === "expired" ? 0 : 5000,
                editableFields: state === "readonly" ? [] : ["/to"],
              },
        );
      }
      // jsdom has no layout engine; contrast is checked against the stylesheet palette separately.
      const result = await axe.run(document, { rules: { "color-contrast": { enabled: false } } });
      expect(result.violations).toEqual([]);
    },
  );
});
