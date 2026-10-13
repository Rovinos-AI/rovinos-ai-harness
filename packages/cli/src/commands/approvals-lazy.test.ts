// SPDX-License-Identifier: Apache-2.0
import { expect, it, vi } from "vitest";

it("does not load core, policy, or vault when the approvals command is imported", async () => {
  vi.resetModules();
  const loaded: string[] = [];
  vi.doMock("@harness/core", () => {
    loaded.push("core");
    return {};
  });
  vi.doMock("@harness/policy", () => {
    loaded.push("policy");
    return {};
  });
  vi.doMock("@harness/vault", () => {
    loaded.push("vault");
    return {};
  });

  try {
    await import("./approvals.js");
    expect(loaded).toEqual([]);
  } finally {
    vi.doUnmock("@harness/core");
    vi.doUnmock("@harness/policy");
    vi.doUnmock("@harness/vault");
    vi.resetModules();
  }
});
