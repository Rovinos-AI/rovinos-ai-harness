// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  FormSchema,
  InputRequestSchema,
  InputResponseSchema,
  formSchemaToZod,
} from "./human-input.js";

const validForm = {
  type: "object",
  properties: { answer: { type: "string" } },
};

function hasUnsupportedError(value: unknown): boolean {
  const result = FormSchema.safeParse(value);
  return (
    !result.success &&
    result.error.issues.some(
      (issue) => issue.code === "custom" && issue.params?.errorCode === "input_schema_unsupported",
    )
  );
}

describe("FormSchema", () => {
  it.each([
    ["root title and description", { ...validForm, title: "Title", description: "Description" }],
    [
      "string bounds and format",
      {
        type: "object",
        properties: { email: { type: "string", minLength: 1, maxLength: 50, format: "email" } },
      },
    ],
    [
      "string default",
      { type: "object", properties: { name: { type: "string", default: "Example" } } },
    ],
    [
      "string enum",
      { type: "object", properties: { choice: { type: "string", enum: ["a", "b"] } } },
    ],
    [
      "titled oneOf choices",
      {
        type: "object",
        properties: { choice: { type: "string", oneOf: [{ const: "a", title: "Choice A" }] } },
      },
    ],
    [
      "safe legacy pattern",
      { type: "object", properties: { code: { type: "string", pattern: "a{1,4}" } } },
    ],
    [
      "number bounds and default",
      {
        type: "object",
        properties: { count: { type: "number", minimum: 0, maximum: 10, default: 1 } },
      },
    ],
    ["integer default", { type: "object", properties: { count: { type: "integer", default: 1 } } }],
    [
      "boolean default",
      { type: "object", properties: { enabled: { type: "boolean", default: true } } },
    ],
    [
      "enum multi-select with bounds",
      {
        type: "object",
        properties: {
          choices: {
            type: "array",
            items: { type: "string", enum: ["a", "b"] },
            minItems: 1,
            maxItems: 2,
            default: ["a"],
          },
        },
      },
    ],
    [
      "titled anyOf multi-select",
      {
        type: "object",
        properties: {
          choices: {
            type: "array",
            items: { type: "string", anyOf: [{ const: "a", title: "Choice A" }] },
          },
        },
      },
    ],
    ["required field", { ...validForm, required: ["answer"] }],
  ])("accepts supported schema: %s", (_description, schema) => {
    expect(FormSchema.safeParse(schema).success).toBe(true);
  });

  it.each([
    ["unknown root keyword", { ...validForm, additionalProperties: false }],
    [
      "unknown field keyword",
      { type: "object", properties: { answer: { type: "string", minItems: 1 } } },
    ],
    [
      "nested property",
      { type: "object", properties: { answer: { type: "object", properties: {} } } },
    ],
    [
      "nested array item",
      { type: "object", properties: { answer: { type: "array", items: { type: "object" } } } },
    ],
    [
      "unknown option keyword",
      {
        type: "object",
        properties: {
          choice: { type: "string", oneOf: [{ const: "a", title: "A", description: "No" }] },
        },
      },
    ],
    [
      "too many properties",
      {
        type: "object",
        properties: Object.fromEntries(
          Array.from({ length: 21 }, (_, index) => [`p${index.toString()}`, { type: "boolean" }]),
        ),
      },
    ],
    [
      "unsafe pattern",
      { type: "object", properties: { code: { type: "string", pattern: "(a+)+$" } } },
    ],
    [
      "malformed pattern",
      { type: "object", properties: { code: { type: "string", pattern: "[" } } },
    ],
    ["invalid required property", { ...validForm, required: ["missing"] }],
    ["duplicate required property", { ...validForm, required: ["answer", "answer"] }],
    [
      "invalid range",
      { type: "object", properties: { answer: { type: "string", minLength: 2, maxLength: 1 } } },
    ],
  ])("rejects unsupported schema with stable code: %s", (_description, schema) => {
    const result = FormSchema.safeParse(schema);
    expect(result.success).toBe(false);
    expect(hasUnsupportedError(schema)).toBe(true);
  });

  it.each([
    ["long title", { ...validForm, title: "t".repeat(201) }],
    [
      "long description",
      { type: "object", properties: { answer: { type: "string", description: "d".repeat(201) } } },
    ],
    [
      "long choice title",
      {
        type: "object",
        properties: { choice: { type: "string", oneOf: [{ const: "a", title: "t".repeat(201) }] } },
      },
    ],
  ])("rejects overlong labels: %s", (_description, schema) => {
    expect(FormSchema.safeParse(schema).success).toBe(false);
  });

  it.each(["email", "uri", "date", "date-time"])("accepts string format %s", (format) => {
    expect(
      FormSchema.safeParse({
        type: "object",
        properties: { value: { type: "string", format } },
      }).success,
    ).toBe(true);
  });
});

describe("formSchemaToZod", () => {
  it("validates every supported answer type, required fields, and rejects extra keys", () => {
    const schema = FormSchema.parse({
      type: "object",
      properties: {
        email: { type: "string", format: "email", minLength: 5, maxLength: 40 },
        choice: {
          type: "string",
          oneOf: [
            { const: "yes", title: "Yes" },
            { const: "no", title: "No" },
          ],
        },
        count: { type: "number", minimum: 1, maximum: 10 },
        rank: { type: "integer", minimum: 1, maximum: 5 },
        enabled: { type: "boolean" },
        tags: {
          type: "array",
          items: { type: "string", enum: ["a", "b"] },
          minItems: 1,
          maxItems: 2,
        },
        optional: { type: "string", default: "default" },
      },
      required: ["email", "choice", "count", "rank", "enabled", "tags"],
    });
    const answerSchema = formSchemaToZod(schema);

    expect(
      answerSchema.safeParse({
        email: "person@example.test",
        choice: "yes",
        count: 2,
        rank: 3,
        enabled: false,
        tags: ["a", "b"],
      }),
    ).toMatchObject({ success: true, data: { optional: "default" } });
    expect(answerSchema.safeParse({ email: "invalid", extra: "no" }).success).toBe(false);
    expect(
      formSchemaToZod(
        FormSchema.parse({
          type: "object",
          properties: {
            pattern: { type: "string", pattern: "a{1,3}" },
            selected: {
              type: "array",
              items: { type: "string", anyOf: [{ const: "x", title: "X" }] },
            },
          },
          required: ["pattern", "selected"],
        }),
      ).safeParse({ pattern: "aaa", selected: ["x"] }).success,
    ).toBe(true);
    expect(
      answerSchema.safeParse({
        email: "person@example.test",
        choice: "maybe",
        count: 2,
        rank: 3.5,
        enabled: true,
        tags: ["c"],
      }).success,
    ).toBe(false);
  });

  it.each([
    ["string constraints", { type: "string", minLength: 2, default: "x" }],
    ["number bounds", { type: "number", minimum: 1, default: 0 }],
    ["enum membership", { type: "string", enum: ["a", "b"], default: "c" }],
    [
      "multi-select membership",
      { type: "array", items: { type: "string", enum: ["a", "b"] }, default: ["c"] },
    ],
    [
      "multi-select bounds",
      {
        type: "array",
        items: { type: "string", enum: ["a", "b"] },
        minItems: 2,
        default: ["a"],
      },
    ],
  ])("validates %s defaults against answer constraints", (_description, field) => {
    const schema = FormSchema.parse({
      type: "object",
      properties: { value: field },
    });

    expect(formSchemaToZod(schema).safeParse({}).success).toBe(false);
  });

  it("counts string bounds in Unicode code points", () => {
    const maxLengthSchema = formSchemaToZod(
      FormSchema.parse({
        type: "object",
        properties: { value: { type: "string", maxLength: 1 } },
      }),
    );
    const minLengthSchema = formSchemaToZod(
      FormSchema.parse({
        type: "object",
        properties: { value: { type: "string", minLength: 2 } },
      }),
    );

    expect(maxLengthSchema.safeParse({ value: "😀" }).success).toBe(true);
    expect(minLengthSchema.safeParse({ value: "😀" }).success).toBe(false);
    expect(minLengthSchema.safeParse({ value: "😀😃" }).success).toBe(true);
  });

  it("does not throw when building an answer schema from a malformed runtime pattern", () => {
    const schema = FormSchema.parse({
      type: "object",
      properties: { value: { type: "string" } },
    });
    const field = schema.properties.value;
    if (field === undefined) {
      throw new Error("Missing parsed form field.");
    }
    Reflect.set(field, "pattern", "[");

    expect(() => formSchemaToZod(schema).safeParse({ value: "x" })).not.toThrow();
    expect(formSchemaToZod(schema).safeParse({ value: "x" }).success).toBe(false);
  });

  it("validates URI, date, date-time, and enum-valued strings", () => {
    const answerSchema = formSchemaToZod(
      FormSchema.parse({
        type: "object",
        properties: {
          uri: { type: "string", format: "uri" },
          date: { type: "string", format: "date" },
          timestamp: { type: "string", format: "date-time" },
          enum: { type: "string", enum: ["one", "two"] },
          pattern: { type: "string", pattern: "[a-z]{2}" },
        },
        required: ["uri", "date", "timestamp", "enum", "pattern"],
      }),
    );
    expect(
      answerSchema.safeParse({
        uri: "https://example.test",
        date: "2026-10-20",
        timestamp: "2026-10-20T08:00:00Z",
        enum: "two",
        pattern: "ab",
      }).success,
    ).toBe(true);
    expect(
      answerSchema.safeParse({
        uri: "https://example.test",
        date: "2026-10-20",
        timestamp: "2026-10-20T10:00:00+02:00",
        enum: "two",
        pattern: "ab",
      }).success,
    ).toBe(true);
    expect(
      answerSchema.safeParse({
        uri: "not a url",
        date: "20-10-2026",
        timestamp: "not a date-time",
        enum: "three",
        pattern: "a1",
      }).success,
    ).toBe(false);
  });
});

describe("InputRequestSchema", () => {
  it("accepts safe patterns only for legacy sources and enforces request limits", () => {
    const request = {
      requestId: "00000000000000000000000001",
      source: "mcp_legacy",
      serverId: "mcp.server",
      callId: "00000000000000000000000002",
      inputKey: "server-key",
      round: 1,
      mode: "form",
      message: "Enter a value.",
      schema: { type: "object", properties: { value: { type: "string", pattern: "a{1,3}" } } },
      expiresAt: 1_800_000_000_000,
    };
    expect(InputRequestSchema.safeParse(request).success).toBe(true);
    expect(
      InputRequestSchema.safeParse({
        ...request,
        source: "mcp_mrtr",
      }).success,
    ).toBe(false);
    expect(InputRequestSchema.safeParse({ ...request, inputKey: "k".repeat(129) }).success).toBe(
      false,
    );
    expect(InputRequestSchema.safeParse({ ...request, message: "m".repeat(2_001) }).success).toBe(
      false,
    );
  });

  it("accepts form and URL requests without optional fields", () => {
    const request = {
      requestId: "00000000000000000000000001",
      source: "agent",
      round: 0,
      mode: "url",
      message: "Continue in a browser.",
      url: "https://example.test/continue",
    };
    expect(InputRequestSchema.parse(request)).toMatchObject(request);
    expect(InputRequestSchema.safeParse({ ...request, url: "not a URL" }).success).toBe(false);
  });

  it("accepts a schema-less form request from the agent", () => {
    expect(
      InputRequestSchema.safeParse({
        requestId: "00000000000000000000000001",
        source: "agent",
        callId: "00000000000000000000000002",
        inputKey: "answer",
        round: 1,
        mode: "form",
        message: "What should I do?",
      }).success,
    ).toBe(true);
    expect(
      InputRequestSchema.safeParse({
        requestId: "00000000000000000000000001",
        source: "mcp_mrtr",
        callId: "00000000000000000000000002",
        serverId: "mcp.server",
        round: 1,
        mode: "form",
        message: "Enter a value.",
      }).success,
    ).toBe(false);
  });

  it.each([
    [
      "form with URL",
      {
        requestId: "00000000000000000000000001",
        source: "agent",
        round: 0,
        mode: "form",
        message: "Enter a value.",
        schema: validForm,
        url: "https://example.test/continue",
      },
    ],
    [
      "URL without URL",
      {
        requestId: "00000000000000000000000001",
        source: "agent",
        round: 0,
        mode: "url",
        message: "Continue in a browser.",
      },
    ],
    [
      "URL with schema",
      {
        requestId: "00000000000000000000000001",
        source: "agent",
        round: 0,
        mode: "url",
        message: "Continue in a browser.",
        schema: validForm,
        url: "https://example.test/continue",
      },
    ],
  ])("rejects inconsistent mode/payload: %s", (_description, request) => {
    expect(InputRequestSchema.safeParse(request).success).toBe(false);
  });
});

describe("InputResponseSchema", () => {
  it.each([
    [{ action: "accept", answer: { name: "Example" } }, true],
    [{ action: "accept" }, true],
    [{ action: "decline" }, true],
    [{ action: "cancel" }, true],
    [{ action: "decline", answer: { name: "Example" } }, false],
    [{ action: "other" }, false],
  ])("validates normalized responses", (response, valid) => {
    expect(InputResponseSchema.safeParse(response).success).toBe(valid);
  });
});
