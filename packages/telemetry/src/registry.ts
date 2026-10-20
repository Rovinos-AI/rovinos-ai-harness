// SPDX-License-Identifier: Apache-2.0
import {
  type AttributeValue,
  type Attributes,
  createContextKey,
  isSpanContextValid,
  type Context,
  context as otelContext,
  type Link,
  type Span,
  SpanStatusCode,
  type SpanOptions,
  type TimeInput,
  ROOT_CONTEXT,
  trace,
} from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { Code, HarnessError } from "@harness/schemas";
import { z } from "zod";
import { attr, isSafeAttr } from "./attr.js";
import { SpanRegistryError, type SpanRegistryIssue } from "./errors.js";
import { getTracer } from "./tracer.js";
import { SEMCONV_ATTRIBUTE_NAMES, SEMCONV_SPAN_NAMES } from "./semconv.js";
import { env } from "node:process";

/** Attribute-schema shape accepted by registered span definitions. */
export type SpanShape = Record<string, z.ZodType>;

const errorCodeAttribute = attr.optional(attr.code());
interface ErrorCodeShape {
  "harness.error.code": typeof errorCodeAttribute;
}

/** Shape of any stored definition, including the automatically added error code. */
export type SpanDefinitionShape = SpanShape | ErrorCodeShape;

/** Task and package responsible for a registered span definition. */
export interface SpanOwnerTask {
  readonly taskId: string;
  readonly packageName: `@harness/${string}`;
}

/** A registered span definition and its validated attribute contract. */
export interface SpanDefinition<
  Shape extends SpanDefinitionShape,
  Schema extends z.ZodType = z.ZodType,
> {
  readonly name: Code;
  readonly shape: Shape;
  readonly schema: Schema;
  readonly ownerTask: SpanOwnerTask;
  /**
   * Validates attributes before creating a span.
   *
   * @param attrs - Attribute values matching this definition's schema.
   * @param opts - Optional parent context, span links, and start timestamp.
   * @returns The newly created span.
   * @throws SpanRegistryError when attributes fail validation.
   */
  start(
    attrs: z.infer<Schema>,
    opts?: {
      readonly parent?: Context;
      readonly links?: Link[];
      readonly startTime?: TimeInput;
    },
  ): Span;
}

const spanNamePattern = /^harness\.[a-z0-9_.]{1,56}$/u;
const semconvSpanNames = new Set<string>(SEMCONV_SPAN_NAMES);
const semconvAttributeNames = new Set<string>(SEMCONV_ATTRIBUTE_NAMES);
const definitions = new Map<string, SpanDefinition<SpanDefinitionShape>>();
const activeSpanDefinitions = new WeakMap<Span, SpanDefinition<SpanDefinitionShape>>();
const tracingProbeKey = createContextKey("harness.telemetry.context-probe");
let fallbackTracerInstalled = false;

function addErrorCodeAttribute<Shape extends SpanShape>(shape: Shape): Shape & ErrorCodeShape {
  return Object.assign({}, shape, { "harness.error.code": errorCodeAttribute });
}

function isSpanShape(value: unknown): value is SpanShape {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSpanOwnerTask(value: unknown): value is SpanOwnerTask {
  return (
    typeof value === "object" &&
    value !== null &&
    "taskId" in value &&
    typeof value.taskId === "string" &&
    /^\d+(?:\.\d+)+$/u.test(value.taskId) &&
    "packageName" in value &&
    typeof value.packageName === "string" &&
    /^@harness\/[a-z0-9-]+$/u.test(value.packageName)
  );
}

function snapshotSpanShape<Shape extends SpanShape>(shape: Shape): Shape | undefined {
  try {
    return { ...shape };
  } catch {
    return undefined;
  }
}

function issuePaths(error: z.ZodError): SpanRegistryIssue[] {
  return error.issues.map(({ path, code }) => ({
    path: path.map((segment) => (typeof segment === "symbol" ? String(segment) : segment)),
    code,
  }));
}

function isAttributeValue(value: unknown): value is AttributeValue {
  return (
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function parseAttributes<Shape extends SpanShape>(
  schema: z.ZodObject<Shape>,
  attrs: unknown,
): z.infer<z.ZodObject<Shape>> {
  let result: ReturnType<typeof schema.safeParse> | undefined;
  try {
    result = schema.safeParse(attrs);
  } catch {
    result = undefined;
  }
  if (result === undefined) {
    throw new SpanRegistryError("span_attr_invalid", [{ path: [], code: "validation_failed" }]);
  }
  if (!result.success) {
    throw new SpanRegistryError("span_attr_invalid", issuePaths(result.error));
  }
  return result.data;
}

function harnessErrorCode(error: unknown): Code | undefined {
  if (!(error instanceof HarnessError)) {
    return undefined;
  }
  try {
    const result = Code.safeParse(error.code);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Records only the closed error code and error status on a registered span.
 *
 * @param span - Span created from a registered definition.
 * @param error - Error value used only to extract its stable code.
 */
export function safeRecordError(span: Span, error: unknown): void {
  span.setStatus({ code: SpanStatusCode.ERROR });
  const definition = activeSpanDefinitions.get(span);
  if (definition === undefined || !("harness.error.code" in definition.shape)) {
    return;
  }
  const code = harnessErrorCode(error) ?? Code.parse("unknown_error");
  span.setAttribute("harness.error.code", code);
}

/**
 * Registers a span name and its allowlisted attribute shape.
 *
 * @param name - Harness span name matching `harness.<lowercase_name>`.
 * @param shape - Attribute schemas created only with the `attr` helpers.
 * @param ownerTask - Task and package that owns this span definition.
 * @returns The registered span definition.
 * @throws SpanRegistryError when the name is invalid, duplicated, or has an unsafe attribute.
 */
export function defineSpan<const Shape extends SpanShape>(
  name: string,
  shape: Shape,
  ownerTask: SpanOwnerTask,
): SpanDefinition<Shape & ErrorCodeShape, z.ZodObject<Shape & ErrorCodeShape>> {
  return registerSpan(name, shape, ownerTask, false);
}

/**
 * Registers a semantic-convention span using only explicitly allowlisted names and attributes.
 *
 * @param name - Semantic-convention span name.
 * @param shape - Attribute schemas created only with the `attr` helpers.
 * @param ownerTask - Task and package that owns this span definition.
 * @returns The registered span definition.
 * @throws SpanRegistryError when the name is not allowlisted or the shape is unsafe.
 */
export function defineSemconvSpan<const Shape extends SpanShape>(
  name: (typeof SEMCONV_SPAN_NAMES)[number],
  shape: Shape,
  ownerTask: SpanOwnerTask,
): SpanDefinition<Shape & ErrorCodeShape, z.ZodObject<Shape & ErrorCodeShape>> {
  if (!semconvSpanNames.has(name)) {
    throw new SpanRegistryError("span_name_invalid");
  }
  return registerSpan(name, shape, ownerTask, true);
}

function registerSpan<const Shape extends SpanShape>(
  name: string,
  shape: Shape,
  ownerTask: SpanOwnerTask,
  semanticConvention: boolean,
): SpanDefinition<Shape & ErrorCodeShape, z.ZodObject<Shape & ErrorCodeShape>> {
  if (
    typeof name !== "string" ||
    (!spanNamePattern.test(name) && !(semanticConvention && semconvSpanNames.has(name))) ||
    !Code.safeParse(name).success
  ) {
    throw new SpanRegistryError("span_name_invalid");
  }
  if (!isSpanOwnerTask(ownerTask)) {
    throw new SpanRegistryError("span_owner_task_invalid");
  }
  if (definitions.has(name)) {
    throw new SpanRegistryError("span_duplicate");
  }
  const shapeInput: unknown = shape;
  if (!isSpanShape(shapeInput)) {
    throw new SpanRegistryError("span_attr_unconstrained");
  }
  const shapeSnapshot = snapshotSpanShape(shape);
  if (shapeSnapshot === undefined) {
    throw new SpanRegistryError("span_attr_unconstrained");
  }
  if (Object.hasOwn(shapeSnapshot, "harness.error.code")) {
    throw new SpanRegistryError("span_attr_reserved");
  }
  if (
    Object.keys(shapeSnapshot).some(
      (key) =>
        !spanNamePattern.test(key) && !(semanticConvention && semconvAttributeNames.has(key)),
    )
  ) {
    throw new SpanRegistryError("span_attr_name_invalid");
  }
  if (Object.values(shapeSnapshot).some((schema) => !isSafeAttr(schema))) {
    throw new SpanRegistryError("span_attr_unconstrained");
  }

  const parsedName = Code.parse(name);
  const fullShape = addErrorCodeAttribute(shapeSnapshot);
  Object.freeze(fullShape);
  const frozenOwnerTask = Object.freeze({ ...ownerTask });
  const schema = z.object(fullShape).strict();
  const definition: SpanDefinition<Shape & ErrorCodeShape, typeof schema> = {
    name: parsedName,
    shape: fullShape,
    schema,
    ownerTask: frozenOwnerTask,
    start(attrs, opts) {
      const parsedAttrs = parseAttributes(schema, attrs);

      const attributes: Attributes = {};
      for (const [key, value] of Object.entries(parsedAttrs)) {
        if (value !== undefined && isAttributeValue(value)) {
          attributes[key] = value;
        } else if (value !== undefined) {
          throw new SpanRegistryError("span_attr_invalid", [{ path: [key], code: "invalid_type" }]);
        }
      }

      const options: SpanOptions = { attributes };
      if (opts?.links !== undefined) {
        options.links = opts.links;
      }
      if (opts?.startTime !== undefined) {
        options.startTime = opts.startTime;
      }
      const span = getTracer().startSpan(parsedName, options, opts?.parent);
      activeSpanDefinitions.set(span, definition);
      return span;
    },
  };
  Object.freeze(definition);
  definitions.set(parsedName, definition);
  return definition;
}

/**
 * Preserves existing OpenTelemetry globals and installs a no-export fallback if needed.
 *
 * @param probe - A throwaway span created through a registered harness definition.
 */
export function ensureTracingFallback(probe: Span): void {
  const tracerIsValid = isSpanContextValid(probe.spanContext());
  probe.end();
  if (!tracerIsValid && !fallbackTracerInstalled) {
    trace.setGlobalTracerProvider(new BasicTracerProvider());
    fallbackTracerInstalled = true;
  }

  const marker = {};
  const contextPropagates = otelContext.with(
    ROOT_CONTEXT.setValue(tracingProbeKey, marker),
    () => otelContext.active().getValue(tracingProbeKey) === marker,
  );
  if (!contextPropagates) {
    otelContext.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  }
}

/**
 * Runs a callback in a registered span and always ends the span.
 *
 * @param definition - Registered span definition.
 * @param attrs - Attribute values matching the definition.
 * @param fn - Callback receiving the created span.
 * @returns The callback result.
 */
export async function withSpan<Shape extends SpanDefinitionShape, Schema extends z.ZodType, Result>(
  definition: SpanDefinition<Shape, Schema>,
  attrs: z.infer<Schema>,
  fn: (span: Span) => Result | Promise<Result>,
): Promise<Result> {
  const span = definition.start(attrs);
  try {
    return await fn(span);
  } catch (error) {
    safeRecordError(span, error);
    throw error;
  } finally {
    span.end();
  }
}

/** Returns registered span definitions in their registration order. */
export function listSpanDefinitions(): readonly SpanDefinition<SpanDefinitionShape>[] {
  return [...definitions.values()];
}

/** Looks up a registered span definition by name. */
export function lookupSpanDefinition(
  name: string,
): SpanDefinition<SpanDefinitionShape> | undefined {
  return definitions.get(name);
}

/**
 * Sets an attribute on the active span only when a registered span defines its schema.
 *
 * @param name - Registered span attribute name.
 * @param value - Attribute value validated against the registered schema.
 */
export function setActiveSpanAttribute(name: string, value: AttributeValue): void {
  const span = trace.getActiveSpan();
  if (span === undefined) {
    return;
  }
  const definition = activeSpanDefinitions.get(span);
  const shape: unknown = definition?.shape;
  const schema = isSpanShape(shape) ? shape[name] : undefined;
  if (schema === undefined) {
    return;
  }
  if (!schema.safeParse(value).success) {
    throw new SpanRegistryError("span_attr_invalid", [{ path: [name], code: "invalid_value" }]);
  }
  span.setAttribute(name, value);
}

/** Clears the span registry for isolated unit tests. */
export function __resetRegistryForTests(): void {
  if (env.NODE_ENV !== "test") {
    throw new SpanRegistryError("span_registry_reset_forbidden");
  }
  definitions.clear();
}

/** Registers an unsafe span definition to verify schema linting in tests. */
export function __registerUnsafeSpanForTests(name: string, shape: SpanShape): () => void {
  if (env.NODE_ENV !== "test") {
    throw new SpanRegistryError("span_unsafe_test_registration_forbidden");
  }
  const parsedName = Code.parse(name);
  const definition: SpanDefinition<SpanDefinitionShape> = {
    name: parsedName,
    shape,
    schema: z.object(shape).strict(),
    ownerTask: { taskId: "4.6", packageName: "@harness/telemetry" },
    start() {
      throw new SpanRegistryError("span_attr_unconstrained");
    },
  };
  definitions.set(parsedName, definition);
  return () => {
    if (definitions.get(parsedName) === definition) {
      definitions.delete(parsedName);
    }
  };
}
