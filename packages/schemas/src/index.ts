// SPDX-License-Identifier: Apache-2.0
export {
  ContractError,
  parseJson,
  parseYaml,
  safeParseJson,
  type ContractIssue,
  type ParseOptions,
  type SafeParseJsonResult,
} from "./parse.js";
export {
  compileJsonSchema,
  type CompileJsonSchemaOptions,
  type JsonSchemaValidator,
} from "./json-schema.js";
export { JsonValue } from "./json.js";
export {
  Event,
  EventEnvelopeSchema,
  EventSchema,
  type EventType,
  type NewEvent,
  type PayloadKeys,
  RunStatus,
} from "./events.js";
export {
  EVENT_FIELD_CLASS,
  joinEvent,
  splitEvent,
  type EventFieldClass,
} from "./classification.js";
export { Code, Id, Sha256Hex, SpanId, TraceId, Traceparent, WorkspaceRef } from "./primitives.js";
export { FakeClock, SequentialIdGenerator } from "./testing.js";

/** The current harness version. */
export const HARNESS_VERSION = "0.0.0";
