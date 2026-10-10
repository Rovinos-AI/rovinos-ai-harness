// SPDX-License-Identifier: Apache-2.0
import { Code, HarnessError } from "@harness/schemas";
import { env } from "node:process";
import { z } from "zod";
import { attr, isSafeAttr } from "./attr.js";

/** Shape of registered log-record attributes. */
export type LogRecordShape = Record<string, z.ZodType>;

/** A registered log-record definition and its validated attribute contract. */
export interface LogRecordDefinition<Shape extends LogRecordShape = LogRecordShape> {
  readonly name: Code;
  readonly shape: Shape;
  readonly schema: z.ZodObject<Shape>;
}

/** Error raised for an invalid or unsafe log-record definition. */
export class LogRegistryError extends HarnessError {
  readonly code:
    | "log_name_invalid"
    | "log_attr_name_invalid"
    | "log_attr_unconstrained"
    | "log_duplicate"
    | "log_registry_reset_forbidden";

  constructor(code: LogRegistryError["code"]) {
    super(code);
    this.code = code;
    Object.defineProperty(this, "code", { configurable: false, writable: false });
  }
}

const logNamePattern = /^harness\.[a-z0-9_.]{1,60}$/u;
const definitions = new Map<string, LogRecordDefinition>();

function isLogRecordShape(value: unknown): value is LogRecordShape {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Registers a log-record name and its allowlisted attribute shape.
 *
 * @param name - Harness log-record name matching `harness.<lowercase_name>`.
 * @param shape - Attribute schemas created only with `attr` helpers.
 * @returns The registered log-record definition.
 * @throws LogRegistryError when the name is invalid, duplicated, or has an unsafe attribute.
 */
export function defineLogRecord<const Shape extends LogRecordShape>(
  name: string,
  shape: Shape,
): LogRecordDefinition<Shape> {
  if (typeof name !== "string" || !logNamePattern.test(name) || !Code.safeParse(name).success) {
    throw new LogRegistryError("log_name_invalid");
  }
  if (definitions.has(name)) {
    throw new LogRegistryError("log_duplicate");
  }
  const shapeInput: unknown = shape;
  if (!isLogRecordShape(shapeInput)) {
    throw new LogRegistryError("log_attr_unconstrained");
  }

  let shapeSnapshot: Shape;
  try {
    shapeSnapshot = { ...shape };
  } catch {
    throw new LogRegistryError("log_attr_unconstrained");
  }
  if (Object.keys(shapeSnapshot).some((key) => !logNamePattern.test(key))) {
    throw new LogRegistryError("log_attr_name_invalid");
  }
  if (Object.values(shapeSnapshot).some((schema) => !isSafeAttr(schema))) {
    throw new LogRegistryError("log_attr_unconstrained");
  }

  const parsedName = Code.parse(name);
  Object.freeze(shapeSnapshot);
  const definition: LogRecordDefinition<Shape> = {
    name: parsedName,
    shape: shapeSnapshot,
    schema: z.object(shapeSnapshot).strict(),
  };
  Object.freeze(definition);
  definitions.set(parsedName, definition);
  return definition;
}

/** Returns registered log-record definitions in their registration order. */
export function listLogDefinitions(): readonly LogRecordDefinition[] {
  return [...definitions.values()];
}

/** Looks up a registered log-record definition by name. */
export function lookupLogDefinition(name: string): LogRecordDefinition | undefined {
  return definitions.get(name);
}

/** Clears the log-record registry for isolated unit tests. */
export function __resetLogRegistryForTests(): void {
  if (env.NODE_ENV !== "test") {
    throw new LogRegistryError("log_registry_reset_forbidden");
  }
  definitions.clear();
}

export { attr };
