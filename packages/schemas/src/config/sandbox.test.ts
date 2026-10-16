// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { SandboxConfigSchema } from "./sandbox.js";

describe("SandboxConfigSchema", () => {
  it("defaults unsafe in-process execution to disabled", () => {
    expect(SandboxConfigSchema.parse({})).toEqual({});
  });

  it("accepts the explicit unsafe in-process opt-in", () => {
    expect(SandboxConfigSchema.parse({ allowUnsafeInProcess: true })).toEqual({
      allowUnsafeInProcess: true,
    });
  });

  it("accepts explicit workspace snapshot settings", () => {
    expect(SandboxConfigSchema.parse({ restoreOnResume: true, snapshotEncryption: true })).toEqual({
      restoreOnResume: true,
      snapshotEncryption: true,
    });
  });

  it("accepts a remote runner URL with a secret reference", () => {
    expect(
      SandboxConfigSchema.parse({
        runner: { url: "http://sandbox-runner:8080", token: "env:SANDBOX_RUNNER_TOKEN" },
      }),
    ).toEqual({
      runner: { url: "http://sandbox-runner:8080", token: "env:SANDBOX_RUNNER_TOKEN" },
    });
  });

  it("accepts a strict egress allowlist and rejects wildcard hosts or invalid ports", () => {
    expect(
      SandboxConfigSchema.parse({
        egress: { allow: [{ host: "api.example.test", ports: [443, 8443] }] },
      }),
    ).toEqual({
      egress: { allow: [{ host: "api.example.test", ports: [443, 8443] }] },
    });
    expect(
      SandboxConfigSchema.safeParse({
        egress: { allow: [{ host: "*.example.test", ports: [443] }] },
      }).success,
    ).toBe(false);
    expect(
      SandboxConfigSchema.safeParse({
        egress: { allow: [{ host: "api.example.test", ports: [0] }] },
      }).success,
    ).toBe(false);
  });

  it("rejects inline runner tokens and unknown runner settings", () => {
    expect(
      SandboxConfigSchema.safeParse({
        runner: { url: "http://sandbox-runner:8080", token: "plain-text-token" },
      }).success,
    ).toBe(false);
    expect(
      SandboxConfigSchema.safeParse({
        runner: {
          url: "http://sandbox-runner:8080",
          token: "env:SANDBOX_RUNNER_TOKEN",
          extra: true,
        },
      }).success,
    ).toBe(false);
  });

  it("rejects runner URLs that are not an HTTP origin", () => {
    expect(
      SandboxConfigSchema.safeParse({
        runner: { url: "file:///tmp/runner", token: "env:SANDBOX_RUNNER_TOKEN" },
      }).success,
    ).toBe(false);
    expect(
      SandboxConfigSchema.safeParse({
        runner: { url: "http://sandbox-runner:8080/path", token: "env:SANDBOX_RUNNER_TOKEN" },
      }).success,
    ).toBe(false);
  });

  it("rejects unknown sandbox settings", () => {
    expect(SandboxConfigSchema.safeParse({ allowUnsafe: true }).success).toBe(false);
  });
});
