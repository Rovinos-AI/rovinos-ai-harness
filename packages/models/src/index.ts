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
  OpenAIAdapter,
  type OpenAIAdapterOptions,
  type OpenAISecret,
} from "./providers/openai.js";
