// SPDX-License-Identifier: Apache-2.0
import { Code as CodeSchema, Id as IdSchema } from "@rovinos/schemas";
import type { Code } from "@rovinos/schemas";
import pino, { type Logger as PinoLogger } from "pino";
import { z } from "zod";
import type { Writable } from "node:stream";

const SafeCodeSchema = CodeSchema.refine(
  (value) => !API_KEY_CODE_PATTERN.test(value) && !isLuhnCardNumber(value),
);
const LogValueSchema = z.union([IdSchema, SafeCodeSchema, z.number().int(), z.boolean()]);
const LogFieldsSchema = z.record(SafeCodeSchema, LogValueSchema);
const UnknownFieldsSchema = z.record(z.string(), z.unknown());
const API_KEY_CODE_PATTERN = /^[a-z][a-z0-9]{1,15}_(?:live|test)_[a-f0-9]{24,}$/u;

/** A safe scalar accepted as a structured log value. */
export type LogValue = Code | number | boolean;

/** Code-keyed fields accepted by the sanctioned logger. */
export type LogFields = Record<Code, LogValue>;

/** Pino severity levels accepted by the logger. */
export type LoggerLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal" | "silent";

/** Options for creating a structured logger. */
export interface CreateLoggerOptions {
  /** Minimum severity to write. Defaults to `info`. */
  readonly level?: LoggerLevel;
  /** Writable destination. Defaults to standard error. */
  readonly destination?: Writable;
}

/** Structured logger with code-only events and validated, metadata-only fields. */
export interface Logger {
  debug(event: Code, fields?: LogFields): void;
  info(event: Code, fields?: LogFields): void;
  warn(event: Code, fields?: LogFields): void;
  error(event: Code, fields?: LogFields): void;
  child(bindings: LogFields): Logger;
}

class LoggerState {
  #droppedFields = 0;

  get droppedFields(): number {
    return this.#droppedFields;
  }

  incrementDroppedFields(): void {
    this.#droppedFields += 1;
  }
}

const stateByLogger = new WeakMap<Logger, LoggerState>();

function isLuhnCardNumber(value: string): boolean {
  if (!/^\d{13,19}$/u.test(value)) {
    return false;
  }
  let sum = 0;
  let double = false;
  for (let index = value.length - 1; index >= 0; index -= 1) {
    let digit = Number(value.charAt(index));
    if (double) {
      digit *= 2;
      if (digit > 9) {
        digit -= 9;
      }
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * Returns how many unsafe values have been discarded by a logger, for tests.
 *
 * @param logger - Logger to inspect.
 * @returns Number of invalid fields or events discarded by the logger.
 */
export function __getLoggerDroppedFieldsForTests(logger: Logger): number {
  return stateByLogger.get(logger)?.droppedFields ?? 0;
}

function sanitizeFields(fields: unknown, state: LoggerState): Record<string, LogValue> {
  if (fields === undefined) {
    return {};
  }
  const rawFields = UnknownFieldsSchema.safeParse(fields);
  if (!rawFields.success) {
    state.incrementDroppedFields();
    return {};
  }
  const safeFields: Record<string, LogValue> = {};
  for (const [key, value] of Object.entries(rawFields.data)) {
    const parsedField = LogFieldsSchema.safeParse({ [key]: value });
    if (parsedField.success) {
      Object.assign(safeFields, parsedField.data);
    } else {
      state.incrementDroppedFields();
    }
  }
  return safeFields;
}

interface LoggerContext {
  readonly logger: PinoLogger;
  readonly bindings: Record<string, LogValue>;
  readonly state: LoggerState;
}

function writeLog(
  context: LoggerContext,
  level: "debug" | "info" | "warn" | "error",
  event: Code,
  fields: LogFields | undefined,
): void {
  const parsedEvent = SafeCodeSchema.safeParse(event);
  if (!parsedEvent.success) {
    context.state.incrementDroppedFields();
    return;
  }
  const safeFields = sanitizeFields(fields, context.state);
  const record = { event: parsedEvent.data, fields: { ...context.bindings, ...safeFields } };
  switch (level) {
    case "debug":
      context.logger.debug(record);
      return;
    case "info":
      context.logger.info(record);
      return;
    case "warn":
      context.logger.warn(record);
      return;
    case "error":
      context.logger.error(record);
  }
}

function wrapLogger(context: LoggerContext): Logger {
  const wrapped: Logger = {
    debug: (event, fields) => {
      writeLog(context, "debug", event, fields);
    },
    info: (event, fields) => {
      writeLog(context, "info", event, fields);
    },
    warn: (event, fields) => {
      writeLog(context, "warn", event, fields);
    },
    error: (event, fields) => {
      writeLog(context, "error", event, fields);
    },
    child: (childBindings) => {
      return wrapLogger({
        ...context,
        bindings: {
          ...context.bindings,
          ...sanitizeFields(childBindings, context.state),
        },
      });
    },
  };
  stateByLogger.set(wrapped, context.state);
  return wrapped;
}

/**
 * Creates a Pino-backed logger that writes JSON lines to stderr by default.
 *
 * @param options - Severity and optional writable destination.
 * @returns Logger that accepts only code events and validated scalar fields.
 */
export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const destination = options.destination ?? pino.destination(2);
  const logger = pino({ level: options.level ?? "info", base: null }, destination);
  return wrapLogger({ logger, bindings: {}, state: new LoggerState() });
}

/** Logger implementation that deliberately discards all events. */
export class NoopLogger implements Logger {
  /** Discards a debug event. */
  debug(_event: Code, _fields?: LogFields): void {
    return undefined;
  }

  /** Discards an info event. */
  info(_event: Code, _fields?: LogFields): void {
    return undefined;
  }

  /** Discards a warning event. */
  warn(_event: Code, _fields?: LogFields): void {
    return undefined;
  }

  /** Discards an error event. */
  error(_event: Code, _fields?: LogFields): void {
    return undefined;
  }

  /** Returns this no-op logger; bindings have no effect. */
  child(_bindings: LogFields): Logger {
    return this;
  }
}
