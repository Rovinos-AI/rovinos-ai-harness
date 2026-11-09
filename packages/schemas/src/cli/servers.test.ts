// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { ServersCheckResultSchema } from "./servers.js";

const server = {
  id: "primary",
  transportKind: "stdio",
  protocolEra: "legacy",
  protocolVersion: "2025-11-25",
  supportsApps: true,
  capabilities: { apps: "yes", tools: "yes" },
  trust: "internal",
  connectLatencyMs: 3,
  reachable: true,
  toolCount: 2,
  acceptedToolCount: 1,
  excludedToolCount: 1,
  registeredToolIds: ["primary.available"],
  rejectedTools: [{ reason: "tool_not_allowlisted" }],
  phases: {
    connection: { status: "success" },
    authentication: { status: "not_applicable" },
    negotiation: { status: "success" },
    discovery: { status: "success" },
    schemaValidation: { status: "partial" },
    exposure: { status: "partial" },
    policyConfiguration: { status: "not_tested", allowlistConfigured: true },
  },
  aliasMappingAvailable: false,
  nextAction: "review_tool_allowlist",
  tracePropagation: "no",
  tracePropagationReason: "disabled",
  warnings: ["trace_propagation_disabled"],
};
const result = {
  reportVersion: 1,
  catalogFingerprint: "a".repeat(64),
  catalogFingerprintStatus: "complete",
  servers: [server],
};

describe("ServersCheckResultSchema", () => {
  it("accepts only safe diagnostic metadata", () => {
    expect(ServersCheckResultSchema.parse(result)).toEqual(result);
    expect(
      ServersCheckResultSchema.safeParse({
        ...result,
        servers: [{ ...server, protocolVersion: "server supplied text" }],
      }).success,
    ).toBe(false);
    expect(
      ServersCheckResultSchema.safeParse({
        ...result,
        servers: [{ ...server, protocolVersion: "2026-99-99" }],
      }).success,
    ).toBe(false);
    expect(
      ServersCheckResultSchema.safeParse({
        ...result,
        servers: [{ ...server, rejectedTools: [{ reason: "denied", name: "private" }] }],
      }).success,
    ).toBe(false);
  });

  it("requires a supported report version and closed phase/action states", () => {
    expect(ServersCheckResultSchema.safeParse({ ...result, reportVersion: 2 }).success).toBe(false);
    expect(
      ServersCheckResultSchema.safeParse({
        ...result,
        servers: [
          {
            ...server,
            phases: {
              ...server.phases,
              policyConfiguration: { status: "success", allowlistConfigured: true },
            },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      ServersCheckResultSchema.safeParse({
        ...result,
        servers: [{ ...server, nextAction: "contact https://private.test" }],
      }).success,
    ).toBe(false);
    expect(
      ServersCheckResultSchema.safeParse({
        ...result,
        catalogFingerprint: undefined,
      }).success,
    ).toBe(false);
    expect(
      ServersCheckResultSchema.safeParse({
        ...result,
        servers: [{ ...server, acceptedToolCount: 0 }],
      }).success,
    ).toBe(false);
  });

  it("accepts partial discovery without claiming a catalog fingerprint", () => {
    const partial = {
      ...result,
      catalogFingerprintStatus: "partial",
      catalogFingerprint: undefined,
      servers: [
        {
          ...server,
          reachable: false,
          phases: {
            ...server.phases,
            discovery: { status: "failed", errorCode: "mcp_list_tools_failed" },
            schemaValidation: { status: "not_tested" },
            exposure: { status: "not_tested" },
          },
        },
      ],
    };

    expect(ServersCheckResultSchema.parse(partial)).toEqual({
      reportVersion: 1,
      catalogFingerprintStatus: "partial",
      servers: partial.servers,
    });
  });
});
