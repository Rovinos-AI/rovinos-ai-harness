// SPDX-License-Identifier: Apache-2.0
import {
  Code,
  JsonValue,
  ModelRequestSchema,
  ModelUsageSchema,
  PartSchema,
} from "@harness/schemas";
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

function parseContractFixtures(fixtures: readonly ProviderContractFixture[]) {
  const parsedFixtures = z.array(ProviderContractFixtureSchema).parse(fixtures);
  const scenarios = new Set(parsedFixtures.map((fixture) => fixture.scenario));
  if (scenarios.size !== parsedFixtures.length) {
    throw new Error("Provider contract fixtures must not contain duplicate scenarios.");
  }
  const missingScenarios = ProviderContractScenarioSchema.options.filter(
    (scenario) => !scenarios.has(scenario),
  );
  if (missingScenarios.length > 0) {
    throw new Error(`Provider contract fixtures are missing: ${missingScenarios.join(", ")}.`);
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
 * Yields one event-loop turn before aborting so SDK adapters can dispatch fetch
 * from their startup microtasks; the assertion then exercises in-flight cancellation.
 */
async function assertAbortCompletion(
  completion: Promise<unknown>,
  controller: AbortController,
  didFetch: () => boolean,
): Promise<void> {
  const startedAt = performance.now();
  // SDK-backed adapters may dispatch fetch in a microtask after complete() is called.
  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort();
  const error = await completion.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(didFetch()).toBe(true);
  expect(
    (error instanceof Error && error.name === "AbortError") ||
      (error instanceof ProviderError && error.code === "provider_timeout"),
  ).toBe(true);
  expect(performance.now() - startedAt).toBeLessThan(100);
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
): Promise<void> {
  try {
    if (scenario !== "abort_signal") {
      dispatcher.assertNoPendingInterceptors();
    }
  } finally {
    await dispatcher.close();
  }
}

async function runProviderScenario(
  makeAdapter: ProviderContractAdapterFactory,
  fixture: ProviderContractFixture,
): Promise<void> {
  const dispatcher = new MockAgent();
  dispatcher.disableNetConnect();
  const baseUrl = "https://provider.test";
  const headers = {
    "content-type": "application/json",
    ...fixture.httpResponse.headers,
  };
  const reply = dispatcher
    .get(baseUrl)
    .intercept({ path: /.*/, method: "POST" })
    .reply(fixture.httpResponse.status, JSON.stringify(fixture.httpResponse.body), { headers });
  if (fixture.scenario === "abort_signal") {
    reply.delay(100);
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
      await assertAbortCompletion(completion, controller, () => fetchCalled);
    } else if (ERROR_EXPECTATIONS[fixture.scenario] !== undefined) {
      await assertProviderFailure(completion, fixture);
    } else {
      await assertProviderCompletion(completion, fixture);
    }
  } finally {
    await closeContractDispatcher(dispatcher, fixture.scenario);
  }
}

/**
 * Registers reusable HTTP-backed behavior tests for a provider adapter.
 *
 * @param name - Provider name used as the Vitest suite label.
 * @param makeAdapter - Factory that creates an adapter with injected mock HTTP.
 * @param fixtures - Scenario fixtures, each with a normalized request and HTTP response.
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
): void {
  const parsedFixtures = parseContractFixtures(fixtures);
  describe(name, () => {
    for (const fixture of parsedFixtures) {
      it(fixture.scenario, async () => runProviderScenario(makeAdapter, fixture));
    }
  });
}
