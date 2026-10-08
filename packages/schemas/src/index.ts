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
export { FakeClock, SequentialIdGenerator } from "./testing.js";

/** The current harness version. */
export const HARNESS_VERSION = "0.0.0";
