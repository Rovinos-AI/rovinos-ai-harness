// SPDX-License-Identifier: Apache-2.0
import { ServerConfigSchema } from "@rovinos/schemas";
import { describe, expect, it } from "vitest";
import { requestsSensitiveFormField } from "./sensitive.js";
import { McpInputRequestError, validateInputRequiredResult } from "./validate.js";

const server = ServerConfigSchema.parse({
  id: "mcp_test",
  transport: { kind: "stdio", command: "server" },
  elicitation: { enabled: true, modes: ["form", "url"], maxRequestStateBytes: 8 },
});

const form = {
  method: "elicitation/create",
  params: {
    mode: "form",
    message: "Provide a display name",
    requestedSchema: {
      type: "object",
      properties: { displayName: { type: "string", title: "Display name" } },
    },
  },
};

function captureError(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("validateInputRequiredResult", () => {
  it("validates form and URL requests and preserves request state", () => {
    expect(
      validateInputRequiredResult(
        {
          resultType: "input_required",
          inputRequests: {
            form_1: form,
            url_1: {
              method: "elicitation/create",
              params: { mode: "url", message: "Continue", url: "https://example.test/consent" },
            },
          },
          requestState: "opaque",
        },
        server,
      ),
    ).toEqual({
      inputRequests: [
        {
          inputKey: "form_1",
          mode: "form",
          message: "Provide a display name",
          requestedSchema: {
            type: "object",
            properties: { displayName: { type: "string", title: "Display name" } },
          },
        },
        {
          inputKey: "url_1",
          mode: "url",
          message: "Continue",
          url: "https://example.test/consent",
        },
      ],
      requestState: "opaque",
    });
  });

  it.each([
    { inputRequests: { bad: { method: "sampling/createMessage", params: {} } } },
    {
      inputRequests: {
        bad: { method: "elicitation/create", params: { ...form.params, url: "x" } },
      },
    },
    {
      inputRequests: {
        bad: {
          method: "elicitation/create",
          params: { ...form.params, message: "x".repeat(2_001) },
        },
      },
    },
    {
      inputRequests: {
        bad: {
          method: "elicitation/create",
          params: {
            ...form.params,
            requestedSchema: {
              type: "object",
              properties: { key: { type: "string", pattern: ".*" } },
            },
          },
        },
      },
    },
    {
      inputRequests: {
        bad: {
          method: "elicitation/create",
          params: { mode: "url", message: "x", url: "not a URL" },
        },
      },
    },
    { inputRequests: { ["k".repeat(129)]: form } },
    { inputRequests: {} },
    { inputRequests: { form }, requestState: "x".repeat(9) },
  ])("rejects malformed, undeclared, or oversized requests", (payload) => {
    expect(() =>
      validateInputRequiredResult({ resultType: "input_required", ...payload }, server),
    ).toThrow();
  });

  it("rejects a disabled server and an undeclared mode", () => {
    const disabled = ServerConfigSchema.parse({
      id: "mcp_test",
      transport: { kind: "stdio", command: "server" },
    });
    expect(() =>
      validateInputRequiredResult(
        { resultType: "input_required", inputRequests: { form } },
        disabled,
      ),
    ).toThrow();
    const formOnly = ServerConfigSchema.parse({
      id: "mcp_test",
      transport: { kind: "stdio", command: "server" },
      elicitation: { enabled: true, modes: ["form"] },
    });
    expect(() =>
      validateInputRequiredResult(
        {
          resultType: "input_required",
          inputRequests: {
            url: {
              method: "elicitation/create",
              params: { mode: "url", message: "Continue", url: "https://example.test" },
            },
          },
        },
        formOnly,
      ),
    ).toThrow();
  });

  it("does not expose malformed request contents in validation failures", () => {
    expect(() =>
      validateInputRequiredResult(
        {
          resultType: "input_required",
          inputRequests: {
            bad: {
              method: "elicitation/create",
              params: { mode: "form", message: "server-canary" },
            },
          },
        },
        server,
      ),
    ).toThrow();
  });

  it.each([
    { inputRequests: { bad: "not-an-object" } },
    { inputRequests: { bad: { method: "sampling/createMessage", params: {} } } },
    {
      inputRequests: {
        bad: {
          method: "elicitation/create",
          params: { mode: "form", message: "form/url mismatch", url: "https://example.test" },
        },
      },
    },
    { inputRequests: { form }, requestState: "x".repeat(9) },
  ])("maps malformed request data to a typed MCP error", (payload) => {
    const error = captureError(() =>
      validateInputRequiredResult({ resultType: "input_required", ...payload }, server),
    );
    expect(error).toBeInstanceOf(McpInputRequestError);
    expect(error).not.toHaveProperty("issues");
    expect(error).toMatchObject({ code: "mcp_input_request_invalid" });
  });
});

describe("requestsSensitiveFormField", () => {
  it.each(["password", "api_key", "credit_card", "cvv"])("refuses sensitive field %s", (name) => {
    expect(
      requestsSensitiveFormField({
        inputKey: "key",
        mode: "form",
        message: "Provide data",
        requestedSchema: {
          type: "object",
          properties: { [name]: { type: "string" } },
        },
      }),
    ).toBe(true);
  });

  it("checks titles and descriptions and permits non-sensitive and URL requests", () => {
    expect(
      requestsSensitiveFormField({
        inputKey: "key",
        mode: "form",
        message: "Provide data",
        requestedSchema: {
          type: "object",
          properties: { field: { type: "string", title: "Card security code" } },
        },
      }),
    ).toBe(true);
    expect(
      requestsSensitiveFormField({
        inputKey: "key",
        mode: "form",
        message: "Provide data",
        requestedSchema: {
          type: "object",
          properties: { name: { type: "string", description: "Your public display name" } },
        },
      }),
    ).toBe(false);
    expect(
      requestsSensitiveFormField({
        inputKey: "key",
        mode: "url",
        message: "Continue",
        url: "https://example.test",
      }),
    ).toBe(false);
  });

  it.each(["discard_reason", "cardinality", "scorecard"])(
    "does not decline harmless field name %s",
    (name) => {
      expect(
        requestsSensitiveFormField({
          inputKey: "key",
          mode: "form",
          message: "Provide data",
          requestedSchema: {
            type: "object",
            properties: { [name]: { type: "string" } },
          },
        }),
      ).toBe(false);
    },
  );

  it.each(["card_number", "Card number", "CVV", "api-key", "access_token"])(
    "declines sensitive field name %s",
    (name) => {
      expect(
        requestsSensitiveFormField({
          inputKey: "key",
          mode: "form",
          message: "Provide data",
          requestedSchema: {
            type: "object",
            properties: { [name]: { type: "string" } },
          },
        }),
      ).toBe(true);
    },
  );
});
