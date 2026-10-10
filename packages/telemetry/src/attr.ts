// SPDX-License-Identifier: Apache-2.0
import { Code, Id, Sha256Hex } from "@harness/schemas";
import { z } from "zod";

/** Safe telemetry attribute kinds used by the attribute catalog and processors. */
export interface AttrMeta {
  readonly kind: "id" | "code" | "hash" | "enum" | "int" | "num" | "bool";
  readonly values?: readonly string[];
  readonly optional?: true;
}

const attrMetadata = new WeakMap<z.ZodType, AttrMeta>();

function register<Schema extends z.ZodType>(schema: Schema, meta: AttrMeta): Schema {
  attrMetadata.set(
    schema,
    Object.freeze({
      ...meta,
      ...(meta.values === undefined ? {} : { values: Object.freeze([...meta.values]) }),
    }),
  );
  return schema;
}

/**
 * Returns metadata for a schema created with an `attr` helper.
 *
 * @param schema - The schema to inspect.
 * @returns Safe attribute metadata, or `undefined` when the schema is unregistered.
 */
export function getAttrMeta(schema: z.ZodType): AttrMeta | undefined {
  return attrMetadata.get(schema);
}

/**
 * Checks whether a schema was created by a safe attribute helper.
 *
 * @param schema - The schema to inspect.
 * @returns Whether the schema is registered as a safe attribute.
 */
export function isSafeAttr(schema: z.ZodType): boolean {
  return getAttrMeta(schema) !== undefined;
}

/** Helpers for constructing allowlisted telemetry attribute schemas. */
export const attr = {
  /** Validates a harness ULID. */
  id: (): typeof Id => register(Id, { kind: "id" }),
  /** Validates a bounded harness code. */
  code: (): typeof Code => register(Code, { kind: "code" }),
  /** Validates a lowercase SHA-256 hex digest. */
  hash: (): typeof Sha256Hex => register(Sha256Hex, { kind: "hash" }),
  /** Restricts an attribute to one of the supplied string values. */
  enum: <const Values extends readonly [string, ...string[]]>(
    values: Values,
  ): z.ZodEnum<{ [Value in Values[number]]: Value }> =>
    register(z.enum(values), { kind: "enum", values }),
  /** Restricts an attribute to integers. */
  int: (): z.ZodNumber => register(z.number().int(), { kind: "int" }),
  /** Restricts an attribute to nonnegative integers. */
  nonnegativeInt: (): z.ZodNumber => register(z.number().int().nonnegative(), { kind: "int" }),
  /** Restricts an attribute to finite numbers. */
  num: (): z.ZodNumber => register(z.number(), { kind: "num" }),
  /** Restricts an attribute to booleans. */
  bool: (): z.ZodBoolean => register(z.boolean(), { kind: "bool" }),
  /** Makes a safe attribute optional while retaining its safety metadata. */
  optional: <Schema extends z.ZodType>(schema: Schema): z.ZodOptional<Schema> => {
    const optionalSchema = schema.optional();
    const meta = getAttrMeta(schema);
    return meta === undefined
      ? optionalSchema
      : register(optionalSchema, { ...meta, optional: true });
  },
};
