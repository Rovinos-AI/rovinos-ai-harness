// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { JsonPointerSchema, PiiConfigSchema } from "./pii.js";

describe("JSON Pointer and PII detokenization config", () => {
  it("enables runtime PII boundaries by default and accepts an explicit disable", () => {
    expect(PiiConfigSchema.parse({}).enabled).toBe(true);
    expect(PiiConfigSchema.parse({ enabled: false }).enabled).toBe(false);
  });

  it.each(["", "/to", "/attachments/0/name", "/a~1b", "/a~0b", "/recipients/*"])(
    "accepts pointer %s",
    (pointer) => {
      expect(JsonPointerSchema.safeParse(pointer).success).toBe(true);
    },
  );

  it.each(["to", "a/b", "/bad~2escape", "/bad~"])("rejects invalid pointer %s", (pointer) => {
    expect(JsonPointerSchema.safeParse(pointer).success).toBe(false);
  });

  it("keeps the allowlist optional and defaults entries to fail-closed", () => {
    expect(PiiConfigSchema.parse({}).detokenize).toBeUndefined();
    expect(
      PiiConfigSchema.parse({
        detokenize: [{ toolId: "mail.send", args: ["/to"] }],
      }).detokenize,
    ).toEqual([{ toolId: "mail.send", args: ["/to"], onUnresolvable: "fail" }]);
  });

  it("rejects the root pointer in a detokenization allowlist", () => {
    expect(
      PiiConfigSchema.safeParse({
        detokenize: [{ toolId: "mail.send", args: [""] }],
      }).success,
    ).toBe(false);
  });

  it("rejects duplicate tool IDs with a value-free issue path", () => {
    const result = PiiConfigSchema.safeParse({
      detokenize: [
        { toolId: "mail.send", args: ["/to"] },
        { toolId: "mail.send", args: ["/body"] },
      ],
    });

    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("Expected duplicate tool IDs to fail validation");
    }
    expect(result.error.issues).toEqual([
      expect.objectContaining({
        path: ["detokenize", 1, "toolId"],
        code: "custom",
        message: "Duplicate toolId",
      }),
    ]);
    expect(JSON.stringify(result.error.issues)).not.toContain("mail.send");
  });
});
