// SPDX-License-Identifier: Apache-2.0
export {
  ProviderError,
  ProviderErrorCodeSchema,
  ProviderNotRegisteredError,
  type ProviderErrorCode,
  type ProviderErrorOptions,
} from "./errors.js";
export { ModelGateway, type ModelGatewayDependencies } from "./gateway.js";
export { AdapterRegistry } from "./registry.js";
export {
  ProviderResultSchema,
  type ProviderAdapter,
  type ProviderContext,
  type ProviderResult,
} from "./types.js";
export {
  JsonSchemaError,
  lowerForProvider,
  schemaHash,
  toJsonSchema,
  type JsonSchema,
} from "./json-schema.js";
export {
  PROVIDER_SCHEMA_RULES,
  providerSchemaRules,
  type ProviderId,
  type ProviderSchemaRule,
} from "./provider-schema-rules.js";
