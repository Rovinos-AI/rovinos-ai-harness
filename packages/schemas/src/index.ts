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
export { HarnessError } from "./errors.js";
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
export { SnapshotSchema, type Snapshot } from "./snapshot.js";
export { RunConfigSchema, type RunConfig } from "./config/run.js";
export { RunResumePolicySchema } from "./config/run.js";
export { StoreConfigSchema } from "./config/store.js";
export { ModelsConfigSchema } from "./config/models.js";
export { ServerConfigSchema } from "./config/servers.js";
export { PolicyConfigSchema } from "./config/policy.js";
export { PiiConfigSchema } from "./config/pii.js";
export { TelemetryConfigSchema } from "./config/telemetry.js";
export { SandboxConfigSchema } from "./config/sandbox.js";
export { ServeResultSchema, type ServeResult } from "./cli/serve.js";
export {
  FakeModelCompletionSchema,
  FakeModelScriptSchema,
  RunInputSchema,
  RunResultSchema,
  type FakeModelCompletion,
} from "./cli/run.js";
export { InspectEventSchema, InspectResultSchema } from "./cli/inspect.js";
export { FakeClock, SequentialIdGenerator } from "./testing.js";

/** The current harness version. */
export const HARNESS_VERSION = "0.0.0";
