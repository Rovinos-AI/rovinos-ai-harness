// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { PolicyConfigSchema } from "./policy.js";

describe("PolicyConfigSchema", () => {
  it("defaults to an empty config and accepts a policy file", () => {
    expect(PolicyConfigSchema.parse({})).toEqual({});
    expect(PolicyConfigSchema.parse({ file: "examples/policy.yaml" })).toEqual({
      file: "examples/policy.yaml",
    });
  });

  it("accepts log and HTTPS webhook approval notifiers with secret references", () => {
    expect(PolicyConfigSchema.parse({ approvals: {} }).approvals?.notifier).toEqual({
      kind: "log",
    });
    expect(
      PolicyConfigSchema.parse({
        approvals: {
          notifier: {
            kind: "webhook",
            url: "https://hooks.example.test/approval",
            secretRef: "env:APPROVAL_WEBHOOK_TOKEN",
            timeoutMs: 2_000,
          },
        },
      }).approvals?.notifier,
    ).toEqual({
      kind: "webhook",
      url: "https://hooks.example.test/approval",
      secretRef: "env:APPROVAL_WEBHOOK_TOKEN",
      timeoutMs: 2_000,
    });
  });

  it("rejects literal secrets and insecure webhook URLs unless localhost is enabled", () => {
    const config = {
      approvals: {
        notifier: {
          kind: "webhook",
          url: "https://hooks.example.test/approval",
          secretRef: "a-literal-secret",
        },
      },
    };
    expect(PolicyConfigSchema.safeParse(config).success).toBe(false);
    expect(
      PolicyConfigSchema.safeParse({
        approvals: {
          notifier: {
            kind: "webhook",
            url: "http://localhost:8080/approval",
            secretRef: "env:APPROVAL_WEBHOOK_TOKEN",
          },
        },
      }).success,
    ).toBe(false);
    expect(
      PolicyConfigSchema.safeParse({
        approvals: {
          allowInsecureLocalhost: true,
          notifier: {
            kind: "webhook",
            url: "http://localhost:8080/approval",
            secretRef: "env:APPROVAL_WEBHOOK_TOKEN",
          },
        },
      }).success,
    ).toBe(true);
    expect(
      PolicyConfigSchema.safeParse({
        approvals: {
          allowInsecureLocalhost: true,
          notifier: {
            kind: "webhook",
            url: "http://example.test/approval",
            secretRef: "env:APPROVAL_WEBHOOK_TOKEN",
          },
        },
      }).success,
    ).toBe(false);
  });

  it("rejects empty paths and unknown config fields", () => {
    expect(PolicyConfigSchema.safeParse({ file: "" }).success).toBe(false);
    expect(PolicyConfigSchema.safeParse({ unknown: true }).success).toBe(false);
  });
});
