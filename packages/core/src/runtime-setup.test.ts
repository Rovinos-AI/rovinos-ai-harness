// SPDX-License-Identifier: Apache-2.0
import { Code, PiiConfigSchema } from "@rovinos/schemas";
import { describe, expect, it } from "vitest";
import { assertDetokenizeToolsRegistered } from "./runtime-setup.js";

describe("detokenization tool registry validation", () => {
  const config = PiiConfigSchema.parse({
    detokenize: [{ toolId: "mail.send", args: ["/to"] }],
  });

  it("accepts allowlisted tools registered by the runtime", () => {
    expect(() => {
      assertDetokenizeToolsRegistered(config, {
        describe: (toolId) =>
          toolId === Code.parse("mail.send") ? { idempotent: true, timeoutMs: 1_000 } : undefined,
      });
    }).not.toThrow();
  });

  it("fails with the closed startup error when an allowlisted tool is unknown", () => {
    let caught: unknown;
    try {
      assertDetokenizeToolsRegistered(config, { describe: () => undefined });
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      code: "pii_detokenize_tool_unknown",
      toolId: "mail.send",
    });
  });

  it("checks every allowlisted tool against the runtime registry", () => {
    const configWithMultipleTools = PiiConfigSchema.parse({
      detokenize: [
        { toolId: "mail.send", args: ["/to"] },
        { toolId: "files.read", args: ["/path"] },
      ],
    });

    expect(() => {
      assertDetokenizeToolsRegistered(configWithMultipleTools, {
        describe: (toolId) =>
          toolId === Code.parse("mail.send") ? { idempotent: true, timeoutMs: 1_000 } : undefined,
      });
    }).toThrow(
      expect.objectContaining({
        code: "pii_detokenize_tool_unknown",
        toolId: "files.read",
      }),
    );
  });
});
