// SPDX-License-Identifier: Apache-2.0
import { expect, it, vi } from "vitest";

it("does not load core, policy, or vault when the approvals command is imported", async () => {
  vi.resetModules();
  const loaded: string[] = [];
  vi.doMock("@rovinos/core", () => {
    loaded.push("core");
    return {};
  });
  vi.doMock("@rovinos/policy", () => {
    loaded.push("policy");
    return {};
  });
  vi.doMock("@rovinos/vault", () => {
    loaded.push("vault");
    return {};
  });

  try {
    await import("./approvals.js");
    expect(loaded).toEqual([]);
  } finally {
    vi.doUnmock("@rovinos/core");
    vi.doUnmock("@rovinos/policy");
    vi.doUnmock("@rovinos/vault");
    vi.resetModules();
  }
});
