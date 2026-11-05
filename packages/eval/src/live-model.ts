// SPDX-License-Identifier: Apache-2.0
// Credentials stay in these host-only adapters. Counting at fetch includes gateway retries/repairs.
import {
  createConfiguredModelPort,
  type ModelPort,
  type RuntimeModelOverrides,
} from "@rovinos/core";
import {
  AnthropicAdapter,
  AzureOpenAIAdapter,
  OpenAIAdapter,
  OpenAICompatibleAdapter,
  type ProviderAdapter,
  type RoutingModelGateway,
  type ModelGatewayContext,
  type ModelGatewayResponse,
  type TokenizedModelGatewayContext,
  type TokenizedModelGatewayResponse,
} from "@rovinos/models";
import {
  ModelsConfigSchema,
  ModelRoutingConfigSchema,
  SequentialIdGenerator,
  type ModelsConfig,
  type Capabilities,
  type ModelRequest,
} from "@rovinos/schemas";
import { z } from "zod";
import { LiveModelError, type LiveModelErrorCode } from "./live-model-contract.js";

/** Host-only dependencies for a run-wide, credential-isolated live model session. */
export interface LiveModelSessionOptions {
  readonly models: ModelsConfig;
  readonly secretResolver?: RuntimeModelOverrides["secretResolver"];
  readonly maxCalls: number;
  readonly clock?: { now(): number };
  readonly signal?: AbortSignal;
}

/** Run-scoped host model and its actual outgoing-request count. */
export interface LiveModelSession {
  readonly model: ModelPort;
  /** Host-only guarded adapters for grader gateways and cassette decoration; never send over RPC. */
  readonly providerAdapters: readonly ProviderAdapter[];
  /** Builds a trial-specific route using the same adapters, credentials, IDs, and egress cap. */
  modelFor(routing: ModelsConfig["routing"]): ModelPort;
  /** Host-only typed gateway for graders, including their vault-backed value transforms. */
  gatewayFor(routing: ModelsConfig["routing"]): Pick<RoutingModelGateway, "complete">;
  readonly calls: number;
  readonly failureCode: LiveModelErrorCode | undefined;
  close(): Promise<void>;
}

interface EgressState {
  calls: number;
  failureCode: LiveModelErrorCode | undefined;
  readonly maxCalls: number;
  readonly controller: AbortController;
}

function endpoint(value: string, local: boolean): URL {
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(local && loopback && url.protocol === "http:")) ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new LiveModelError("eval_live_egress_denied");
  }
  return url;
}

function targets(provider: ModelsConfig["providers"][number]): readonly string[] {
  if (provider.kind === "bedrock" || provider.auth?.kind === "entra") {
    throw new LiveModelError("eval_live_provider_unsupported");
  }
  if (provider.kind === "azure_openai") {
    const base = endpoint(provider.endpoint ?? "", false).href.replace(/\/+$/u, "");
    return Object.values(provider.deployments ?? {}).map(
      (deployment) =>
        `${base}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=${encodeURIComponent(provider.apiVersion ?? "")}`,
    );
  }
  const base = endpoint(
    provider.baseUrl ??
      (provider.kind === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com/v1"),
    provider.kind === "openai_compatible" && provider.trust === "local",
  ).href.replace(/\/+$/u, "");
  return [`${base}${provider.kind === "anthropic" ? "/v1/messages" : "/chat/completions"}`];
}

/** Internal fetch boundary; exported only from this file for deterministic, network-free tests. */
export function guardedLiveModelFetch(
  allowed: readonly string[],
  sharedState: EgressState,
  transport: typeof fetch,
): typeof fetch {
  const state = sharedState;
  return async (input, init) => {
    try {
      const request = new Request(input, init);
      if (state.failureCode !== undefined) {
        throw new LiveModelError(state.failureCode);
      }
      if (state.controller.signal.aborted || request.signal.aborted) {
        throw new LiveModelError("eval_live_cancelled");
      }
      if (request.method !== "POST" || !allowed.includes(request.url)) {
        state.failureCode = "eval_live_egress_denied";
        state.controller.abort();
        throw new LiveModelError(state.failureCode);
      }
      if (state.calls >= state.maxCalls) {
        state.failureCode = "eval_live_call_limit_exceeded";
        state.controller.abort();
        throw new LiveModelError(state.failureCode);
      }
      // No await between checking and incrementing: concurrent attempts share the same cap.
      state.calls += 1;
      const response = await transport(
        new Request(request, {
          redirect: "manual",
          signal: AbortSignal.any([request.signal, state.controller.signal]),
        }),
      );
      if (response.status >= 300 && response.status < 400) {
        state.failureCode = "eval_live_redirect_denied";
        state.controller.abort();
        void response.body?.cancel().catch(() => undefined);
        throw new LiveModelError(state.failureCode);
      }
      return response;
    } catch (error) {
      if (error instanceof LiveModelError) {
        throw error;
      }
      throw new LiveModelError(
        state.controller.signal.aborted ? "eval_live_cancelled" : "eval_live_provider_failed",
      );
    }
  };
}

function capabilities(
  value: ModelsConfig["providers"][number]["capabilities"],
): Partial<Capabilities> {
  return {
    ...(value?.structuredOutput === undefined ? {} : { structuredOutput: value.structuredOutput }),
    ...(value?.forcedToolChoice === undefined ? {} : { forcedToolChoice: value.forcedToolChoice }),
    ...(value?.parallelToolCalls === undefined
      ? {}
      : { parallelToolCalls: value.parallelToolCalls }),
    ...(value?.maxContextTokens === undefined ? {} : { maxContextTokens: value.maxContextTokens }),
    ...(value?.opaqueRoundTrip === undefined ? {} : { opaqueRoundTrip: value.opaqueRoundTrip }),
  };
}

async function adapterOptions(
  provider: ModelsConfig["providers"][number],
  options: LiveModelSessionOptions,
  guardedFetch: typeof fetch,
) {
  const ref = provider.auth?.kind === "api_key" ? provider.auth.apiKey : provider.apiKey;
  const apiKey = ref === undefined ? undefined : await options.secretResolver?.resolve(ref);
  if (
    (ref !== undefined && apiKey === undefined) ||
    (apiKey === undefined && provider.trust !== "local")
  ) {
    throw new LiveModelError("eval_live_config_invalid");
  }
  return {
    provider: provider.id,
    maxOutputTokens: provider.maxOutputTokens,
    fetch: guardedFetch,
    capabilities: capabilities(provider.capabilities),
    ...(provider.baseUrl === undefined ? {} : { baseURL: provider.baseUrl }),
    apiKey: apiKey ?? { reveal: () => "not-needed" },
  };
}

async function adapter(
  provider: ModelsConfig["providers"][number],
  options: LiveModelSessionOptions,
  guardedFetch: typeof fetch,
): Promise<ProviderAdapter> {
  const common = await adapterOptions(provider, options, guardedFetch);
  switch (provider.kind) {
    case "openai":
      return new OpenAIAdapter(common);
    case "anthropic":
      return new AnthropicAdapter(common);
    case "openai_compatible":
      return new OpenAICompatibleAdapter({
        ...common,
        baseURL: provider.baseUrl ?? "",
        trust: provider.trust,
        ...(provider.quirks === undefined ? {} : { quirks: provider.quirks }),
      });
    case "azure_openai":
      return new AzureOpenAIAdapter({
        ...common,
        endpoint: provider.endpoint ?? "",
        apiVersion: provider.apiVersion ?? "",
        deployments: provider.deployments ?? {},
        auth: { kind: "api_key", apiKey: common.apiKey },
        ...(provider.deploymentCapabilities === undefined
          ? {}
          : { deploymentCapabilities: provider.deploymentCapabilities }),
        ...(options.clock === undefined ? {} : { clock: options.clock }),
      });
    case "bedrock":
      throw new LiveModelError("eval_live_provider_unsupported");
  }
}

function ensureActive(state: EgressState): void {
  if (state.failureCode !== undefined) {
    throw new LiveModelError(state.failureCode);
  }
}

function sessionModel(model: ModelPort, state: EgressState): ModelPort {
  return {
    async complete(request, context) {
      try {
        ensureActive(state);
        if (state.controller.signal.aborted || context.signal.aborted) {
          throw new LiveModelError("eval_live_cancelled");
        }
        const result = await model.complete(request, {
          ...context,
          signal: AbortSignal.any([context.signal, state.controller.signal]),
        });
        ensureActive(state);
        return result;
      } catch {
        throw new LiveModelError(
          state.failureCode ??
            (state.controller.signal.aborted || context.signal.aborted
              ? "eval_live_cancelled"
              : "eval_live_provider_failed"),
        );
      }
    },
  };
}

class SessionGateway implements Pick<RoutingModelGateway, "complete"> {
  constructor(
    private readonly configured: Promise<RoutingModelGateway | undefined>,
    private readonly state: EgressState,
  ) {
    void configured.catch(() => undefined);
  }

  complete<Schema extends z.ZodType = z.ZodType>(
    request: ModelRequest,
    context: Omit<ModelGatewayContext<Schema>, "valueTransform"> & {
      readonly valueTransform?: undefined;
    },
  ): Promise<ModelGatewayResponse<Schema>>;
  complete<Schema extends z.ZodType = z.ZodType>(
    request: ModelRequest,
    context: TokenizedModelGatewayContext<Schema>,
  ): Promise<TokenizedModelGatewayResponse>;
  complete<Schema extends z.ZodType = z.ZodType>(
    request: ModelRequest,
    context: ModelGatewayContext<Schema>,
  ): Promise<ModelGatewayResponse<Schema> | TokenizedModelGatewayResponse>;
  async complete<Schema extends z.ZodType = z.ZodType>(
    request: ModelRequest,
    context: ModelGatewayContext<Schema>,
  ): Promise<ModelGatewayResponse<Schema> | TokenizedModelGatewayResponse> {
    try {
      ensureActive(this.state);
      if (this.state.controller.signal.aborted || context.signal.aborted) {
        throw new LiveModelError("eval_live_cancelled");
      }
      const model = await this.configured;
      if (model === undefined) {
        throw new LiveModelError("eval_live_config_invalid");
      }
      const result = await model.complete(request, {
        ...context,
        signal: AbortSignal.any([context.signal, this.state.controller.signal]),
      });
      ensureActive(this.state);
      return result;
    } catch (error) {
      const code = error instanceof LiveModelError ? error.code : "eval_live_provider_failed";
      throw new LiveModelError(
        this.state.failureCode ??
          (this.state.controller.signal.aborted || context.signal.aborted
            ? "eval_live_cancelled"
            : code),
      );
    }
  }
}

function gatewayFactory(
  models: ModelsConfig,
  overrides: RuntimeModelOverrides,
  state: EgressState,
) {
  return (routing: ModelsConfig["routing"]): Pick<RoutingModelGateway, "complete"> => {
    try {
      const validated = ModelRoutingConfigSchema.parse(routing);
      const configured = createConfiguredModelPort({ ...models, routing: validated }, overrides);
      return new SessionGateway(configured, state);
    } catch {
      throw new LiveModelError("eval_live_config_invalid");
    }
  };
}

/**
 * Creates a host-only model gateway with exact endpoint allowlisting and a sticky egress cap.
 * The returned model may be shared across trials; close aborts all outstanding requests.
 */
export async function createLiveModelSession(
  options: LiveModelSessionOptions,
): Promise<LiveModelSession> {
  const controller = new AbortController();
  const abort = () => {
    controller.abort();
  };
  const removeAbort = () => {
    options.signal?.removeEventListener("abort", abort);
  };
  try {
    const models = ModelsConfigSchema.parse(options.models);
    const maxCalls = z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER)
      .parse(options.maxCalls);
    // Validate every configured provider before resolving even one credential.
    const allowlists = models.providers.map(targets);
    if (options.signal?.aborted === true) {
      throw new LiveModelError("eval_live_cancelled");
    }
    options.signal?.addEventListener("abort", abort, { once: true });
    const state: EgressState = { calls: 0, failureCode: undefined, maxCalls, controller };
    const adapters = await Promise.all(
      models.providers.map((provider, index) =>
        adapter(
          provider,
          options,
          guardedLiveModelFetch(allowlists[index] ?? [], state, globalThis.fetch),
        ),
      ),
    );
    const overrides = {
      providerAdapters: adapters,
      ids: new SequentialIdGenerator(),
      clock: options.clock ?? { now: () => Date.now() },
    };
    const configured = await createConfiguredModelPort(models, overrides);
    if (configured === undefined) {
      throw new LiveModelError("eval_live_config_invalid");
    }
    const gatewayFor = gatewayFactory(models, overrides, state);
    return {
      model: sessionModel(configured, state),
      providerAdapters: Object.freeze(adapters),
      modelFor: gatewayFor,
      gatewayFor,
      get calls() {
        return state.calls;
      },
      get failureCode() {
        return state.failureCode;
      },
      close() {
        controller.abort();
        removeAbort();
        return Promise.resolve();
      },
    };
  } catch (error) {
    controller.abort();
    removeAbort();
    throw error instanceof LiveModelError ? error : new LiveModelError("eval_live_config_invalid");
  }
}
