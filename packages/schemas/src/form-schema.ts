// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { isRegexSafePattern } from "./regex-safety.js";

const FieldLabelSchema = {
  title: z.string().max(200).optional(),
  description: z.string().max(200).optional(),
};

const ChoiceSchema = z
  .object({
    const: z.string(),
    title: z.string().max(200),
  })
  .strict();

const StringFieldSchema = z
  .object({
    ...FieldLabelSchema,
    type: z.literal("string"),
    minLength: z.number().int().nonnegative().optional(),
    maxLength: z.number().int().nonnegative().optional(),
    format: z.enum(["email", "uri", "date", "date-time"]).optional(),
    default: z.string().optional(),
    enum: z.array(z.string()).min(1).optional(),
    oneOf: z.array(ChoiceSchema).min(1).optional(),
    pattern: z
      .string()
      .superRefine((pattern, context) => {
        if (!isRegexSafePattern(pattern) || !isValidRegex(pattern)) {
          context.addIssue({
            code: "custom",
            message: "The regular-expression pattern is invalid or unsafe.",
            params: { errorCode: "input_schema_unsupported" },
          });
        }
      })
      .optional(),
  })
  .strict()
  .superRefine((field, context) => {
    if (
      field.minLength !== undefined &&
      field.maxLength !== undefined &&
      field.minLength > field.maxLength
    ) {
      context.addIssue({
        code: "custom",
        path: ["maxLength"],
        message: "Maximum length must not be less than minimum length.",
        params: { errorCode: "input_schema_unsupported" },
      });
    }
    if (field.enum !== undefined && field.oneOf !== undefined) {
      context.addIssue({
        code: "custom",
        message: "A string field may define enum or oneOf, but not both.",
        params: { errorCode: "input_schema_unsupported" },
      });
    }
  });

const NumberFieldSchema = z
  .object({
    ...FieldLabelSchema,
    type: z.enum(["number", "integer"]),
    minimum: z.number().optional(),
    maximum: z.number().optional(),
    default: z.number().optional(),
  })
  .strict()
  .superRefine((field, context) => {
    if (
      field.minimum !== undefined &&
      field.maximum !== undefined &&
      field.minimum > field.maximum
    ) {
      context.addIssue({
        code: "custom",
        path: ["maximum"],
        message: "Maximum must not be less than minimum.",
        params: { errorCode: "input_schema_unsupported" },
      });
    }
    if (
      field.type === "integer" &&
      field.default !== undefined &&
      !Number.isInteger(field.default)
    ) {
      context.addIssue({
        code: "custom",
        path: ["default"],
        message: "Integer fields require an integer default.",
        params: { errorCode: "input_schema_unsupported" },
      });
    }
  });

const BooleanFieldSchema = z
  .object({
    ...FieldLabelSchema,
    type: z.literal("boolean"),
    default: z.boolean().optional(),
  })
  .strict();

const MultiSelectItemsSchema = z.union([
  z.object({ type: z.literal("string"), enum: z.array(z.string()).min(1) }).strict(),
  z.object({ type: z.literal("string"), anyOf: z.array(ChoiceSchema).min(1) }).strict(),
]);

const MultiSelectFieldSchema = z
  .object({
    ...FieldLabelSchema,
    type: z.literal("array"),
    items: MultiSelectItemsSchema,
    minItems: z.number().int().nonnegative().optional(),
    maxItems: z.number().int().nonnegative().optional(),
    default: z.array(z.string()).optional(),
  })
  .strict()
  .superRefine((field, context) => {
    if (
      field.minItems !== undefined &&
      field.maxItems !== undefined &&
      field.minItems > field.maxItems
    ) {
      context.addIssue({
        code: "custom",
        path: ["maxItems"],
        message: "Maximum item count must not be less than minimum item count.",
        params: { errorCode: "input_schema_unsupported" },
      });
    }
  });

const FormPropertySchema = z.union([
  StringFieldSchema,
  NumberFieldSchema,
  BooleanFieldSchema,
  MultiSelectFieldSchema,
]);

const formSchemaBase = z
  .object({
    type: z.literal("object"),
    title: z.string().max(200).optional(),
    description: z.string().max(200).optional(),
    properties: z.record(z.string().min(1), FormPropertySchema),
    required: z.array(z.string().min(1)).optional(),
  })
  .strict()
  .superRefine((schema, context) => {
    if (Object.keys(schema.properties).length > 20) {
      context.addIssue({
        code: "custom",
        path: ["properties"],
        message: "Form schemas may define at most 20 properties.",
        params: { errorCode: "input_schema_unsupported" },
      });
    }
    const required = new Set<string>();
    for (const [index, name] of (schema.required ?? []).entries()) {
      if (required.has(name) || !Object.hasOwn(schema.properties, name)) {
        context.addIssue({
          code: "custom",
          path: ["required", index],
          message: "Required fields must be unique property names.",
          params: { errorCode: "input_schema_unsupported" },
        });
      }
      required.add(name);
    }
  });

/** Strict schema for the supported, flat MCP elicitation form subset. */
export const FormSchema = z.preprocess((value, context) => {
  if (hasUnsupportedFormSchemaKeywords(value)) {
    context.addIssue({
      code: "custom",
      message: "The form schema contains unsupported keywords or nesting.",
      params: { errorCode: "input_schema_unsupported" },
    });
  }
  return value;
}, formSchemaBase);

/** Inferred MCP form schema. */
export type FormSchema = z.infer<typeof FormSchema>;

/**
 * Build the strict Zod object used to validate answers for a parsed MCP form schema.
 *
 * @param schema - Validated flat form schema.
 * @returns A strict object schema with required fields and constraints from the form.
 */
export function formSchemaToZod(schema: FormSchema): z.ZodType {
  const shape: Record<string, z.ZodType> = {};
  const required = new Set(schema.required ?? []);
  for (const [key, field] of Object.entries(schema.properties)) {
    let fieldSchema = propertyToZod(field);
    if ("default" in field && field.default !== undefined && !required.has(key)) {
      fieldSchema = fieldSchema.default(field.default);
    } else if (!required.has(key)) {
      fieldSchema = fieldSchema.optional();
    }
    shape[key] = fieldSchema;
  }
  return z.object(shape).strict();
}

function propertyToZod(field: FormSchema["properties"][string]): z.ZodType {
  switch (field.type) {
    case "string":
      return stringPropertyToZod(field);
    case "number":
    case "integer":
      return numberPropertyToZod(field);
    case "boolean":
      return z.boolean();
    case "array":
      return multiSelectPropertyToZod(field);
  }
  return z.never();
}

function stringPropertyToZod(
  field: Extract<FormSchema["properties"][string], { type: "string" }>,
): z.ZodType {
  let schema = z.string();
  if (field.minLength !== undefined) {
    schema = schema.min(field.minLength);
  }
  if (field.maxLength !== undefined) {
    schema = schema.max(field.maxLength);
  }
  switch (field.format) {
    case "email":
      schema = schema.refine((value) => z.email().safeParse(value).success);
      break;
    case "uri":
      schema = schema.refine((value) => z.url().safeParse(value).success);
      break;
    case "date":
      schema = schema.refine((value) => z.iso.date().safeParse(value).success);
      break;
    case "date-time":
      schema = schema.refine((value) => z.iso.datetime().safeParse(value).success);
      break;
    case undefined:
      break;
  }
  if (field.pattern !== undefined) {
    schema = schema.regex(new RegExp(field.pattern, "u"));
  }
  if (field.enum !== undefined) {
    const values = field.enum;
    return schema.refine((value) => values.includes(value));
  }
  if (field.oneOf !== undefined) {
    const choices = field.oneOf.map(({ const: value }) => value);
    return schema.refine((value) => choices.includes(value));
  }
  return schema;
}

function numberPropertyToZod(
  field: Extract<FormSchema["properties"][string], { type: "number" | "integer" }>,
): z.ZodType {
  let schema = field.type === "integer" ? z.number().int() : z.number();
  if (field.minimum !== undefined) {
    schema = schema.min(field.minimum);
  }
  if (field.maximum !== undefined) {
    schema = schema.max(field.maximum);
  }
  return schema;
}

function multiSelectPropertyToZod(
  field: Extract<FormSchema["properties"][string], { type: "array" }>,
): z.ZodType {
  let schema = z.array(
    z.string().refine((value) => {
      const options =
        "enum" in field.items ? field.items.enum : field.items.anyOf.map(({ const: item }) => item);
      return options.includes(value);
    }),
  );
  if (field.minItems !== undefined) {
    schema = schema.min(field.minItems);
  }
  if (field.maxItems !== undefined) {
    schema = schema.max(field.maxItems);
  }
  return schema;
}

function isValidRegex(pattern: string): boolean {
  try {
    new RegExp(pattern, "u");
    return true;
  } catch {
    return false;
  }
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).some((key) => !keys.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasUnsupportedFormSchemaKeywords(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  if (hasOnlyKeys(value, ["type", "title", "description", "properties", "required"])) {
    return true;
  }
  const properties = value.properties;
  return isRecord(properties) && Object.values(properties).some(hasUnsupportedPropertyKeywords);
}

function hasUnsupportedPropertyKeywords(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  if (hasOnlyKeys(value, propertyKeywords(value.type))) {
    return true;
  }
  if (value.type === "array") {
    return hasUnsupportedArrayItems(value.items);
  }
  return value.type === "string" && hasUnsupportedChoices(value.oneOf);
}

function propertyKeywords(type: unknown): readonly string[] {
  if (type === "string") {
    return [
      "type",
      "title",
      "description",
      "minLength",
      "maxLength",
      "format",
      "default",
      "enum",
      "oneOf",
      "pattern",
    ];
  }
  if (type === "number" || type === "integer") {
    return ["type", "title", "description", "minimum", "maximum", "default"];
  }
  if (type === "boolean") {
    return ["type", "title", "description", "default"];
  }
  if (type === "array") {
    return ["type", "title", "description", "items", "minItems", "maxItems", "default"];
  }
  return ["type"];
}

function hasUnsupportedArrayItems(value: unknown): boolean {
  if (!isRecord(value) || value.type !== "string") {
    return true;
  }
  if (hasOnlyKeys(value, ["type", "enum", "anyOf"])) {
    return true;
  }
  return hasUnsupportedChoices(value.anyOf);
}

function hasUnsupportedChoices(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.some((choice) => isRecord(choice) && hasOnlyKeys(choice, ["const", "title"]))
  );
}
