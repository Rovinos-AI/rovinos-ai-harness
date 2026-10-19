// SPDX-License-Identifier: Apache-2.0
import { Code } from "@harness/schemas";
import type { Logger, LogRecord } from "@opentelemetry/api-logs";
import { describe, expect, it, vi } from "vitest";
import { emitControlPlaneAudit } from "./control-plane-audit.js";

describe("emitControlPlaneAudit", () => {
  it("emits only token, tool, and outcome codes", () => {
    const emit = vi.fn<(record: LogRecord) => void>();
    const logger = { emit, enabled: () => true } satisfies Logger;

    emitControlPlaneAudit(
      {
        tokenId: Code.parse("token.viewer"),
        tool: Code.parse("list_runs"),
        outcome: Code.parse("success"),
      },
      logger,
    );

    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        body: "control_plane_operation",
        eventName: "harness.control_plane.operation",
        attributes: {
          "harness.auth.token.id": "token.viewer",
          "harness.control_plane.tool": "list_runs",
          "harness.control_plane.outcome": "success",
        },
      }),
    );
    expect(JSON.stringify(emit.mock.calls)).not.toContain("PRIVATE_AUDIT_CANARY");
  });

  it("rejects audit values that are not codes", () => {
    const logger = { emit: vi.fn(), enabled: () => true } satisfies Logger;

    expect(() => {
      emitControlPlaneAudit(
        {
          tokenId: Code.parse("token.viewer"),
          tool: Code.parse("list_runs"),
          outcome: Code.parse("bad outcome"),
        },
        logger,
      );
    }).toThrow();
    expect(logger.emit).not.toHaveBeenCalled();
  });
});
