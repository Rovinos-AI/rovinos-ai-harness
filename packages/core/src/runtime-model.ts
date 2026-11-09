// SPDX-License-Identifier: Apache-2.0
import {
  HarnessError,
  type Capabilities,
  type ModelsConfig,
  type RateLimitStore,
  type SecretRef,
} from "@rovinos/schemas";
import {
  AnthropicAdapter,
  AzureOpenAIAdapter,
  BedrockAdapter,
  createRoutingModelGateway,
  OpenAIAdapter,
  OpenAICompatibleAdapter,
  type AzureOpenAIAuth,
  type RequestSanitizer,
  type ProviderAdapter,
  type RoutingModelGateway,
} from "@rovinos/models";
import type { IdGenerator } from "./ports.js";
import type { Clock } from "./recorder.js";
import { parseRuntimeModelsConfig } from "./runtime-config.js";

type RuntimeModelConfigErrorCode =
  | "secret_resolver_unavailable"
  | "model_provider_azure_config_invalid"
  | "model_provider_bedrock_config_invalid"
  | "model_provider_unsupported"
  | "model_provider_base_url_missing"
  | "model_provider_key_missing";

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
  /** Internal adapter decoration, used for eval cassette recording. */
  readonly decorateAdapter?: (adapter: ProviderAdapter) => ProviderAdapter;
  readonly requestSanitizer?: RequestSanitizer;
  readonly rateLimitStore?: RateLimitStore;
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

async function configuredAzureAdapter(
  provider: ModelsConfig["providers"][number],
  secretResolver: RuntimeModelOverrides["secretResolver"],
  clock: Clock,
): Promise<AzureOpenAIAdapter> {
  if (
    provider.endpoint === undefined ||
    provider.apiVersion === undefined ||
    provider.deployments === undefined ||
    provider.auth === undefined
  ) {
    throw new RuntimeModelConfigError("model_provider_azure_config_invalid");
  }
  let auth: AzureOpenAIAuth;
  if (provider.auth.kind === "entra") {
    auth = { kind: "entra" };
  } else {
    if (secretResolver === undefined) {
      throw new RuntimeModelConfigError("secret_resolver_unavailable");
    }
    auth = {
      kind: "api_key",
      apiKey: await secretResolver.resolve(provider.auth.apiKey),
    };
  }
  const capabilities = definedCapabilities(provider.capabilities);
  return new AzureOpenAIAdapter({
    endpoint: provider.endpoint,
    apiVersion: provider.apiVersion,
    deployments: provider.deployments,
    auth,
    provider: provider.id,
    maxOutputTokens: provider.maxOutputTokens,
    clock,
    ...(capabilities === undefined ? {} : { capabilities }),
    ...(provider.deploymentCapabilities === undefined
      ? {}
      : { deploymentCapabilities: provider.deploymentCapabilities }),
  });
}

async function configuredApiOptions(
  provider: ModelsConfig["providers"][number],
  secretResolver: RuntimeModelOverrides["secretResolver"],
) {
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
  return {
    apiKey,
    provider: provider.id,
    maxOutputTokens: provider.maxOutputTokens,
    ...(provider.baseUrl === undefined ? {} : { baseURL: provider.baseUrl }),
    ...(capabilities === undefined ? {} : { capabilities }),
  };
}

async function configuredAdapter(
  provider: ModelsConfig["providers"][number],
  secretResolver: RuntimeModelOverrides["secretResolver"],
  clock: Clock,
): Promise<ProviderAdapter> {
  switch (provider.kind) {
    case "anthropic":
      return new AnthropicAdapter(await configuredApiOptions(provider, secretResolver));
    case "azure_openai":
      return configuredAzureAdapter(provider, secretResolver, clock);
    case "bedrock": {
      if (provider.region === undefined || provider.modelIds === undefined) {
        throw new RuntimeModelConfigError("model_provider_bedrock_config_invalid");
      }
      const capabilities = definedCapabilities(provider.capabilities);
      return new BedrockAdapter({
        region: provider.region,
        modelIds: provider.modelIds,
        provider: provider.id,
        maxOutputTokens: provider.maxOutputTokens,
        ...(capabilities === undefined ? {} : { capabilities }),
      });
    }
    case "openai":
      return new OpenAIAdapter(await configuredApiOptions(provider, secretResolver));
    case "openai_compatible": {
      if (provider.baseUrl === undefined) {
        throw new RuntimeModelConfigError("model_provider_base_url_missing");
      }
      return new OpenAICompatibleAdapter({
        ...(await configuredApiOptions(provider, secretResolver)),
        baseURL: provider.baseUrl,
        trust: provider.trust,
        ...(provider.quirks === undefined ? {} : { quirks: provider.quirks }),
      });
    }
    default:
      return unsupportedProvider(provider.kind);
  }
}

function unsupportedProvider(_kind: never): never {
  throw new RuntimeModelConfigError("model_provider_unsupported");
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
): Promise<RoutingModelGateway | undefined> {
  const models = parseRuntimeModelsConfig(config);
  const adapters =
    overrides.providerAdapters ??
    (await Promise.all(
      models.providers.map((provider) =>
        configuredAdapter(provider, overrides.secretResolver, overrides.clock),
      ),
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
  const providerTrust: Partial<
    Record<ModelsConfig["providers"][number]["id"], "hosted" | "local">
  > = {};
  const providerStreaming: Partial<Record<ModelsConfig["providers"][number]["id"], boolean>> = {};
  for (const provider of models.providers) {
    providerTrust[provider.id] = provider.trust;
    providerStreaming[provider.id] = provider.streaming;
  }
  return createRoutingModelGateway(
    overrides.decorateAdapter === undefined ? adapters : adapters.map(overrides.decorateAdapter),
    {
      ids: overrides.ids,
      clock: overrides.clock,
      retryPolicy: models.retry,
      enforcement: models.enforcement,
      maxConcurrent: models.maxConcurrent,
      requestsPerMinute,
      pricing: models.pricing,
      providerTrust,
      providerStreaming,
      ...(overrides.requestSanitizer === undefined
        ? {}
        : { requestSanitizer: overrides.requestSanitizer }),
    },
    models.routing,
  );
}
