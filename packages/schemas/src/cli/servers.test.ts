// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { ServersCheckResultSchema } from "./servers.js";

const result = {
  servers: [
    {
      id: "primary",
      transportKind: "stdio",
      protocolEra: "legacy",
      protocolVersion: "2025-11-25",
      supportsApps: true,
      trust: "internal",
      connectLatencyMs: 3,
      reachable: true,
      toolCount: 2,
      registeredToolIds: ["primary.available"],
      rejectedTools: [{ reason: "tool_not_allowlisted" }],
      tracePropagation: "no",
      tracePropagationReason: "disabled",
      warnings: ["trace_propagation_disabled"],
    },
  ],
};

describe("ServersCheckResultSchema", () => {
  it("accepts only safe diagnostic metadata", () => {
    expect(ServersCheckResultSchema.parse(result)).toEqual(result);
    expect(
      ServersCheckResultSchema.safeParse({
        ...result,
        servers: [{ ...result.servers[0], protocolVersion: "server supplied text" }],
      }).success,
    ).toBe(false);
    expect(
      ServersCheckResultSchema.safeParse({
        ...result,
        servers: [{ ...result.servers[0], rejectedTools: [{ reason: "denied", name: "private" }] }],
      }).success,
    ).toBe(false);
  });
});
