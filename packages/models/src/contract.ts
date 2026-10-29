// SPDX-License-Identifier: Apache-2.0
import {
  Code,
  JsonValue,
  ModelRequestSchema,
  ModelUsageSchema,
  PartSchema,
} from "@rovinos/schemas";
import { MockAgent, fetch as undiciFetch } from "undici";
import type { Dispatcher } from "undici";
import { describe, expect, it } from "vitest";
import { ProviderError } from "./errors.js";
import { ProviderResultSchema } from "./types.js";
import type { ProviderAdapter, ProviderContext } from "./types.js";
import { z } from "zod";

/** Scenarios that every provider adapter contract suite exercises. */
export const ProviderContractScenarioSchema = z.enum([
  "text_only",
  "tool_call",
  "usage_mapping",
  "error_429",
  "error_500",
  "error_401",
  "abort_signal",
]);

/** Inferred provider contract scenario. */
export type ProviderContractScenario = z.infer<typeof ProviderContractScenarioSchema>;

/** HTTP response delivered to a provider adapter during a contract scenario. */
export const ProviderContractHttpResponseSchema = z
  .object({
    status: z.number().int().min(100).max(599),
    headers: z.record(z.string(), z.string()).optional(),
    body: JsonValue,
  })
  .strict();

const ProviderContractExpectedSchema = z
  .object({
    parts: z.array(PartSchema).optional(),
    usage: ModelUsageSchema.optional(),
    finishReason: Code.optional(),
    retryAfterMs: z.number().nonnegative().optional(),
    status: z.number().int().min(100).max(599).optional(),
  })
  .strict();

/** Fixture pairing a normalized request and scenario with a provider HTTP response. */
export const ProviderContractFixtureSchema = z
  .object({
    scenario: ProviderContractScenarioSchema,
    request: ModelRequestSchema,
    httpResponse: ProviderContractHttpResponseSchema,
    expected: ProviderContractExpectedSchema.optional(),
  })
  .strict();

/** Inferred provider contract fixture. */
export type ProviderContractFixture = z.infer<typeof ProviderContractFixtureSchema>;

/** HTTP dependencies supplied when constructing an adapter for a contract scenario. */
export interface ProviderContractAdapterOptions {
  readonly fetch: typeof undiciFetch;
  readonly dispatcher: Dispatcher;
  readonly baseUrl: string;
}

/** Factory used by {@link runProviderContract} to create a fresh adapter per scenario. */
export type ProviderContractAdapterFactory = (
  options: ProviderContractAdapterOptions,
  fixture: ProviderContractFixture,
) => ProviderAdapter;

/** Options for adapting the provider contract suite to non-HTTP adapters. */
export interface ProviderContractOptions {
  /** Whether scenarios are driven by HTTP fixtures and expected to issue a fetch. */
  readonly httpBacked?: boolean;
  /** Scenarios required and registered by this contract suite. */
  readonly scenarios?: readonly ProviderContractScenario[];
}

const ERROR_EXPECTATIONS: Partial<
  Record<ProviderContractScenario, { readonly code: string; readonly retryable: boolean }>
> = {
  error_429: { code: "provider_rate_limited", retryable: true },
  error_500: { code: "provider_unavailable", retryable: true },
  error_401: { code: "provider_auth", retryable: false },
};

interface ContractHttpContext {
  readonly dispatcher: MockAgent;
  readonly baseUrl: string;
}

function parseContractFixtures(
  fixtures: readonly ProviderContractFixture[],
  requiredScenarios: readonly ProviderContractScenario[],
) {
  const parsedFixtures = z.array(ProviderContractFixtureSchema).parse(fixtures);
  const scenarios = new Set(parsedFixtures.map((fixture) => fixture.scenario));
  if (scenarios.size !== parsedFixtures.length) {
    throw new Error("Provider contract fixtures must not contain duplicate scenarios.");
  }
  const missingScenarios = requiredScenarios.filter((scenario) => !scenarios.has(scenario));
  if (missingScenarios.length > 0) {
    throw new Error(`Provider contract fixtures are missing: ${missingScenarios.join(", ")}.`);
  }
  const unexpectedScenarios = parsedFixtures
    .map((fixture) => fixture.scenario)
    .filter((scenario) => !requiredScenarios.includes(scenario));
  if (unexpectedScenarios.length > 0) {
    throw new Error(
      `Provider contract fixtures contain unexpected scenarios: ${unexpectedScenarios.join(", ")}.`,
    );
  }
  return parsedFixtures;
}

function createContractAdapter(
  makeAdapter: ProviderContractAdapterFactory,
  fixture: ProviderContractFixture,
  http: ContractHttpContext,
  onFetch: () => void,
): ProviderAdapter {
  return makeAdapter(
    {
      fetch: (input, init) => {
        onFetch();
        return undiciFetch(input, { ...init, dispatcher: http.dispatcher });
      },
      dispatcher: http.dispatcher,
      baseUrl: http.baseUrl,
    },
    fixture,
  );
}

/**
 * Yields one event-loop turn before aborting to exercise cancellation during
 * asynchronous adapter work.
 */
export async function assertAbortCompletion(
  completion: Promise<unknown>,
  controller: AbortController,
  didFetch?: () => boolean,
): Promise<void> {
  // SDK-backed adapters may dispatch fetch in a microtask after complete() is called.
  await new Promise<void>((resolve) => setImmediate(resolve));
  const abortedAt = performance.now();
  controller.abort();
  const error = await completion.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  if (didFetch !== undefined) {
    expect(didFetch()).toBe(true);
  }
  expect(
    (error instanceof Error && error.name === "AbortError") ||
      (error instanceof ProviderError && error.code === "provider_timeout"),
  ).toBe(true);
  expect(performance.now() - abortedAt).toBeLessThan(100);
}

async function assertProviderFailure(
  completion: Promise<unknown>,
  fixture: ProviderContractFixture,
): Promise<void> {
  const expectedError = ERROR_EXPECTATIONS[fixture.scenario];
  if (expectedError === undefined) {
    return;
  }
  const error = await completion.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(ProviderError);
  if (!(error instanceof ProviderError)) {
    return;
  }
  expect(error.code).toBe(expectedError.code);
  expect(error.retryable).toBe(expectedError.retryable);
  if (fixture.expected?.retryAfterMs !== undefined) {
    expect(error.retryAfterMs).toBe(fixture.expected.retryAfterMs);
  }
  if (fixture.expected?.status !== undefined) {
    expect(error.status).toBe(fixture.expected.status);
  }
}

async function assertProviderCompletion(
  completion: Promise<unknown>,
  fixture: ProviderContractFixture,
): Promise<void> {
  const result = ProviderResultSchema.parse(await completion);
  if (fixture.expected?.parts !== undefined) {
    expect(result.parts).toEqual(fixture.expected.parts);
  }
  if (fixture.expected?.usage !== undefined) {
    expect(result.usage).toEqual(fixture.expected.usage);
  }
  if (fixture.expected?.finishReason !== undefined) {
    expect(result.finishReason).toBe(fixture.expected.finishReason);
  }
}

async function closeContractDispatcher(
  dispatcher: MockAgent,
  scenario: ProviderContractScenario,
  httpBacked: boolean,
): Promise<void> {
  try {
    if (httpBacked && scenario !== "abort_signal") {
      dispatcher.assertNoPendingInterceptors();
    }
  } finally {
    await dispatcher.close();
  }
}

async function runProviderScenario(
  makeAdapter: ProviderContractAdapterFactory,
  fixture: ProviderContractFixture,
  httpBacked: boolean,
): Promise<void> {
  const dispatcher = new MockAgent();
  dispatcher.disableNetConnect();
  const baseUrl = "https://provider.test";
  const reply = httpBacked
    ? dispatcher
        .get(baseUrl)
        .intercept({ path: /.*/, method: "POST" })
        .reply(fixture.httpResponse.status, JSON.stringify(fixture.httpResponse.body), {
          headers: {
            "content-type": "application/json",
            ...fixture.httpResponse.headers,
          },
        })
    : undefined;
  if (fixture.scenario === "abort_signal") {
    reply?.delay(100);
  }
  let fetchCalled = false;
  const adapter = createContractAdapter(makeAdapter, fixture, { dispatcher, baseUrl }, () => {
    fetchCalled = true;
  });
  const controller = new AbortController();
  const context: ProviderContext = {
    signal: controller.signal,
    ids: { next: () => fixture.request.requestId },
    clock: { now: () => 0 },
  };

  try {
    const completion = adapter.complete(fixture.request, context);
    if (fixture.scenario === "abort_signal") {
      await assertAbortCompletion(
        completion,
        controller,
        httpBacked ? () => fetchCalled : undefined,
      );
    } else if (ERROR_EXPECTATIONS[fixture.scenario] !== undefined) {
      await assertProviderFailure(completion, fixture);
    } else {
      await assertProviderCompletion(completion, fixture);
    }
  } finally {
    await closeContractDispatcher(dispatcher, fixture.scenario, httpBacked);
  }
}

/**
 * Registers reusable HTTP-backed behavior tests for a provider adapter.
 *
 * @param name - Provider name used as the Vitest suite label.
 * @param makeAdapter - Factory that creates an adapter with injected mock HTTP.
 * @param fixtures - Scenario fixtures pairing normalized requests and responses.
 * @param options - Configure HTTP backing and the scenarios applicable to the adapter.
 *
 * Abort scenarios must reject with an `AbortError` or a `ProviderError` whose
 * code is `provider_timeout`, and must settle before the delayed response.
 * The suite yields one event-loop turn before aborting to allow SDK startup
 * microtasks to dispatch fetch and exercise in-flight cancellation.
 */
export function runProviderContract(
  name: string,
  makeAdapter: ProviderContractAdapterFactory,
  fixtures: readonly ProviderContractFixture[],
  options: ProviderContractOptions = {},
): void {
  const scenarios = options.scenarios ?? ProviderContractScenarioSchema.options;
  const parsedFixtures = parseContractFixtures(fixtures, scenarios);
  const httpBacked = options.httpBacked ?? true;
  describe(name, () => {
    for (const fixture of parsedFixtures) {
      it(fixture.scenario, async () => runProviderScenario(makeAdapter, fixture, httpBacked));
    }
  });
}
