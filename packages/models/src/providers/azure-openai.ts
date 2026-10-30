// SPDX-License-Identifier: Apache-2.0
import { DefaultAzureCredential } from "@azure/identity";
import { CapabilitiesSchema, Code, type Capabilities, type ModelRequest } from "@rovinos/schemas";
import { AzureOpenAI } from "openai";
import { z } from "zod";
import { ProviderError } from "../errors.js";
import { OpenAIAdapter, type OpenAISecret } from "./openai.js";
import type { Clock, ProviderContext, ProviderDelta, ProviderResult } from "../types.js";

const COGNITIVE_SERVICES_SCOPE = "https://cognitiveservices.azure.com/.default";
const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1_000;

function validAzureEndpoint(value: string): boolean {
  const endpoint = new URL(value);
  return (
    endpoint.protocol === "https:" &&
    endpoint.username.length === 0 &&
    endpoint.password.length === 0 &&
    endpoint.search.length === 0 &&
    endpoint.hash.length === 0
  );
}

const PartialCapabilitiesSchema = CapabilitiesSchema.partial().strict();
type ParsedCapabilities = z.infer<typeof PartialCapabilitiesSchema>;

function normalizeCapabilities(capabilities: ParsedCapabilities): Partial<Capabilities> {
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

function normalizeDeploymentCapabilities(
  capabilities: Readonly<Record<string, ParsedCapabilities>> | undefined,
): Readonly<Record<string, Partial<Capabilities>>> {
  return Object.fromEntries(
    Object.entries(capabilities ?? {}).map(([model, overrides]) => [
      model,
      normalizeCapabilities(overrides),
    ]),
  );
}

const AzureOpenAIAdapterConfigSchema = z
  .object({
    endpoint: z.url().refine(validAzureEndpoint),
    apiVersion: z.string().min(1),
    deployments: z.record(Code, z.string().min(1)).refine((value) => Object.keys(value).length > 0),
    capabilities: PartialCapabilitiesSchema.optional(),
    deploymentCapabilities: z.record(Code, PartialCapabilitiesSchema).optional(),
  })
  .strict();

/** Minimal credential surface used by Azure's DefaultAzureCredential and tests. */
export interface AzureOpenAICredential {
  /** Acquires an Entra access token for the requested resource scope. */
  getToken(scope: string): Promise<AzureOpenAIAccessToken | null>;
}

/** Entra access token value and expiry returned by a credential. */
export interface AzureOpenAIAccessToken {
  readonly token: string;
  readonly expiresOnTimestamp: number;
}

/** API-key or Entra authentication for an Azure OpenAI deployment. */
export type AzureOpenAIAuth =
  { readonly kind: "api_key"; readonly apiKey: OpenAISecret } | { readonly kind: "entra" };

/** Options for an Azure OpenAI Chat Completions adapter. */
export interface AzureOpenAIAdapterOptions {
  /** Azure OpenAI resource endpoint. */
  readonly endpoint: string;
  /** Azure OpenAI REST API version. */
  readonly apiVersion: string;
  /** Maps routed logical model codes to Azure deployment names. */
  readonly deployments: Readonly<Record<string, string>>;
  /** Authentication settings. */
  readonly auth: AzureOpenAIAuth;
  /** Provider code used to identify opaque response parts. */
  readonly provider?: string;
  /** Default maximum response-token count. */
  readonly maxOutputTokens?: number;
  /** Provider-wide capability overrides. */
  readonly capabilities?: Partial<Capabilities>;
  /** Capability overrides keyed by routed logical model code. */
  readonly deploymentCapabilities?: Readonly<Record<string, ParsedCapabilities>>;
  /** Optional injected Entra credential, primarily for deterministic tests. */
  readonly credential?: AzureOpenAICredential;
  /** Clock used to determine when cached Entra tokens should be refreshed. */
  readonly clock?: Clock;
  /** Optional injected fetch implementation. */
  readonly fetch?: typeof fetch;
}

function createTokenProvider(
  credential: AzureOpenAICredential,
  clock: Clock,
): () => Promise<string> {
  let cachedToken: AzureOpenAIAccessToken | undefined;
  let inFlight: Promise<string> | undefined;
  return async () => {
    if (
      cachedToken !== undefined &&
      cachedToken.expiresOnTimestamp > clock.now() + TOKEN_REFRESH_SKEW_MS
    ) {
      return cachedToken.token;
    }
    if (inFlight !== undefined) {
      return inFlight;
    }
    const acquisition = credential
      .getToken(COGNITIVE_SERVICES_SCOPE)
      .then((token) => {
        if (token === null || token.token.length === 0) {
          throw new ProviderError("provider_auth");
        }
        cachedToken = token;
        return token.token;
      })
      .catch(() => {
        cachedToken = undefined;
        throw new ProviderError("provider_auth");
      });
    inFlight = acquisition;
    try {
      return await acquisition;
    } finally {
      if (inFlight === acquisition) {
        inFlight = undefined;
      }
    }
  };
}

function systemClock(): Clock {
  return { now: () => Date.now() };
}

/** Azure OpenAI Chat Completions adapter with deployment and authentication mapping. */
export class AzureOpenAIAdapter extends OpenAIAdapter {
  override readonly kind = "azure_openai" as const;
  private readonly deployments: Readonly<Record<string, string>>;
  private readonly deploymentCapabilities: Readonly<Record<string, Partial<Capabilities>>>;

  /**
   * Creates an Azure OpenAI client with SDK retries disabled.
   *
   * @param options - Endpoint, API version, logical deployment mapping, and authentication.
   */
  constructor(options: AzureOpenAIAdapterOptions) {
    const config = AzureOpenAIAdapterConfigSchema.parse({
      endpoint: options.endpoint,
      apiVersion: options.apiVersion,
      deployments: options.deployments,
      ...(options.capabilities === undefined ? {} : { capabilities: options.capabilities }),
      ...(options.deploymentCapabilities === undefined
        ? {}
        : { deploymentCapabilities: options.deploymentCapabilities }),
    });
    const azureAuthentication =
      options.auth.kind === "api_key"
        ? { apiKey: options.auth.apiKey.reveal() }
        : {
            apiKey: "",
            azureADTokenProvider: createTokenProvider(
              options.credential ?? new DefaultAzureCredential(),
              options.clock ?? systemClock(),
            ),
          };
    const client = new AzureOpenAI({
      baseURL: `${config.endpoint.replace(/\/+$/u, "")}/openai`,
      apiVersion: config.apiVersion,
      maxRetries: 0,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...azureAuthentication,
    });
    super({
      client,
      provider: Code.parse(options.provider ?? "azure_openai"),
      kind: "azure_openai",
      ...(options.maxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: options.maxOutputTokens }),
      ...(config.capabilities === undefined
        ? {}
        : { capabilities: normalizeCapabilities(config.capabilities) }),
    });
    this.deployments = config.deployments;
    this.deploymentCapabilities = normalizeDeploymentCapabilities(config.deploymentCapabilities);
  }

  /** Uses capabilities configured for the logical model, without inferring from deployment names. */
  protected override capabilitiesFor(model: string): Partial<Capabilities> {
    return { ...this.capabilities, ...this.deploymentCapabilities[model] };
  }

  /** Maps the logical model code to the Azure deployment used in the request path. */
  protected override requestForProvider(request: ModelRequest): ModelRequest {
    const deployment = this.deployments[request.model.model];
    if (deployment === undefined) {
      throw new ProviderError("provider_bad_request");
    }
    return { ...request, model: { ...request.model, model: deployment } };
  }

  /** {@inheritDoc OpenAIAdapter.complete} */
  override async complete(
    request: ModelRequest,
    context: ProviderContext,
  ): Promise<ProviderResult> {
    const result = await super.complete(request, context);
    if (result.finishReason === "provider_content_filtered") {
      throw new ProviderError("provider_content_filtered");
    }
    return result;
  }

  /** {@inheritDoc OpenAIAdapter.stream} */
  override async *stream(
    request: ModelRequest,
    context: ProviderContext,
  ): AsyncIterable<ProviderDelta> {
    for await (const delta of super.stream(request, context)) {
      if (delta.type === "finish" && delta.finishReason === "provider_content_filtered") {
        throw new ProviderError("provider_content_filtered");
      }
      yield delta;
    }
  }
}
