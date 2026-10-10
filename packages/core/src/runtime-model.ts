// SPDX-License-Identifier: Apache-2.0
import {
  HarnessError,
  type Capabilities,
  type ModelsConfig,
  type SecretRef,
} from "@harness/schemas";
import {
  AnthropicAdapter,
  createRoutingModelGateway,
  OpenAIAdapter,
  type ProviderAdapter,
} from "@harness/models";
import type { ModelPort, IdGenerator } from "./ports.js";
import type { Clock } from "./recorder.js";
import { parseRuntimeModelsConfig } from "./runtime-config.js";

type RuntimeModelConfigErrorCode = "secret_resolver_unavailable" | "model_provider_key_missing";

class RuntimeModelConfigError extends HarnessError {
  readonly code: RuntimeModelConfigErrorCode;

  constructor(code: RuntimeModelConfigErrorCode) {
    super(code);
    this.code = code;
  }
}

/** Dependencies used to build the configured model gateway. */
export interface RuntimeModelOverrides {
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly providerAdapters?: readonly ProviderAdapter[];
  readonly secretResolver?: {
    resolve(ref: SecretRef): Promise<{ reveal(): string }>;
  };
}

function definedCapabilities(
  capabilities: ModelsConfig["providers"][number]["capabilities"],
): Partial<Capabilities> | undefined {
  if (capabilities === undefined) {
    return undefined;
  }
  return {
    ...(capabilities.structuredOutput === undefined
      ? {}
      : { structuredOutput: capabilities.structuredOutput }),
    ...(capabilities.forcedToolChoice === undefined
      ? {}
      : { forcedToolChoice: capabilities.forcedToolChoice }),
    ...(capabilities.parallelToolCalls === undefined
      ? {}
      : { parallelToolCalls: capabilities.parallelToolCalls }),
    ...(capabilities.maxContextTokens === undefined
      ? {}
      : { maxContextTokens: capabilities.maxContextTokens }),
    ...(capabilities.opaqueRoundTrip === undefined
      ? {}
      : { opaqueRoundTrip: capabilities.opaqueRoundTrip }),
  };
}

async function configuredAdapter(
  provider: ModelsConfig["providers"][number],
  secretResolver: RuntimeModelOverrides["secretResolver"],
): Promise<ProviderAdapter> {
  let apiKey: { reveal(): string } = { reveal: () => "not-needed" };
  if (provider.apiKey !== undefined) {
    if (secretResolver === undefined) {
      throw new RuntimeModelConfigError("secret_resolver_unavailable");
    }
    apiKey = await secretResolver.resolve(provider.apiKey);
  } else if (provider.trust !== "local") {
    throw new RuntimeModelConfigError("model_provider_key_missing");
  }

  const capabilities = definedCapabilities(provider.capabilities);
  const options = {
    apiKey,
    provider: provider.id,
    maxOutputTokens: provider.maxOutputTokens,
    ...(provider.baseUrl === undefined ? {} : { baseURL: provider.baseUrl }),
    ...(capabilities === undefined ? {} : { capabilities }),
  };
  return provider.kind === "anthropic" ? new AnthropicAdapter(options) : new OpenAIAdapter(options);
}

/**
 * Builds configured provider adapters and the routing gateway, if configured.
 *
 * @param config - Validated model configuration, or undefined for the defaults.
 * @param overrides - IDs, clock, adapters, and secret resolver supplied by the runtime.
 * @returns The configured gateway, or undefined when no provider route exists.
 */
export async function createConfiguredModelPort(
  config: ModelsConfig | undefined,
  overrides: RuntimeModelOverrides,
): Promise<ModelPort | undefined> {
  const models = parseRuntimeModelsConfig(config);
  const adapters =
    overrides.providerAdapters ??
    (await Promise.all(
      models.providers.map((provider) => configuredAdapter(provider, overrides.secretResolver)),
    ));
  if (
    adapters.length === 0 &&
    models.routing.default.length === 0 &&
    Object.keys(models.routing.roles).length === 0
  ) {
    return undefined;
  }
  const requestsPerMinute = Object.fromEntries(
    models.providers.flatMap((provider) =>
      provider.requestsPerMinute === undefined ? [] : [[provider.id, provider.requestsPerMinute]],
    ),
  );
  return createRoutingModelGateway(
    adapters,
    {
      ids: overrides.ids,
      clock: overrides.clock,
      retryPolicy: models.retry,
      enforcement: models.enforcement,
      maxConcurrent: models.maxConcurrent,
      requestsPerMinute,
    },
    models.routing,
  );
}
