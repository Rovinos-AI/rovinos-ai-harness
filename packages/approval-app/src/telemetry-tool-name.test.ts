// SPDX-License-Identifier: Apache-2.0
import { APP_TELEMETRY_TOOL_NAME } from "@rovinos/schemas";
import { APP_TELEMETRY_TOOL_NAME as SHIM_TELEMETRY_TOOL_NAME } from "@rovinos/app-telemetry";
import { describe, expect, it } from "vitest";

describe("app telemetry tool name", () => {
  it("keeps the dependency-free shim name in sync with schemas", () => {
    expect(SHIM_TELEMETRY_TOOL_NAME).toBe(APP_TELEMETRY_TOOL_NAME);
  });
});
