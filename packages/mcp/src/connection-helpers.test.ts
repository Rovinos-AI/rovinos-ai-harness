// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { discoveryConnectionError } from "./connection-helpers.js";
import { McpConnectionError } from "./errors.js";
import { McpAuthRequiredError } from "./oauth/provider.js";

describe("discoveryConnectionError", () => {
  it("invalidates the connection only when authorization is required", () => {
    const markUnavailable = vi.fn<() => void>();
    expect(discoveryConnectionError(new McpAuthRequiredError(), markUnavailable)).toMatchObject({
      code: "mcp_auth_required",
      message: "mcp_auth_required",
    });
    expect(markUnavailable).toHaveBeenCalledOnce();
  });

  it("preserves existing connection failures, including unsupported Apps", () => {
    const markUnavailable = vi.fn<() => void>();
    const error = new McpConnectionError("mcp_apps_unsupported");
    expect(discoveryConnectionError(error, markUnavailable)).toBe(error);
    expect(markUnavailable).not.toHaveBeenCalled();
  });

  it("replaces unexpected failures with a code-only error", () => {
    const markUnavailable = vi.fn<() => void>();
    expect(
      discoveryConnectionError(new Error("synthetic-server-content"), markUnavailable),
    ).toMatchObject({
      code: "mcp_list_tools_failed",
      message: "mcp_list_tools_failed",
    });
    expect(markUnavailable).not.toHaveBeenCalled();
  });
});
