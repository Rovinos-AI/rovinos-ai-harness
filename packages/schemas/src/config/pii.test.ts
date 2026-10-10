// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { JsonPointerSchema, PiiConfigSchema } from "./pii.js";

describe("JSON Pointer and PII detokenization config", () => {
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
});
