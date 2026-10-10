// SPDX-License-Identifier: Apache-2.0
import { JsonValue, ModelRequestSchema } from "@harness/schemas";
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

/** Fixture pairing a normalized request and scenario with a provider HTTP response. */
export const ProviderContractFixtureSchema = z
  .object({
    scenario: ProviderContractScenarioSchema,
    request: ModelRequestSchema,
    httpResponse: ProviderContractHttpResponseSchema,
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

/**
 * Registers reusable HTTP-backed behavior tests for a provider adapter.
 *
 * @param name - Provider name used as the Vitest suite label.
 * @param makeAdapter - Factory that creates an adapter with injected mock HTTP.
 * @param fixtures - Scenario fixtures, each with a normalized request and HTTP response.
 */
export function runProviderContract(
  name: string,
  makeAdapter: ProviderContractAdapterFactory,
  fixtures: readonly ProviderContractFixture[],
): void {
  const parsedFixtures = z.array(ProviderContractFixtureSchema).parse(fixtures);

  describe(name, () => {
    for (const fixture of parsedFixtures) {
      it(fixture.scenario, async () => {
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
          .reply(fixture.httpResponse.status, JSON.stringify(fixture.httpResponse.body), {
            headers,
          });
        if (fixture.scenario === "abort_signal") {
          reply.delay(100);
        }

        const adapter = makeAdapter(
          {
            fetch: (input, init) => undiciFetch(input, { ...init, dispatcher }),
            dispatcher,
            baseUrl,
          },
          fixture,
        );
        const controller = new AbortController();
        const context: ProviderContext = {
          signal: controller.signal,
          ids: { next: () => fixture.request.requestId },
          clock: { now: () => 0 },
        };

        try {
          const completion = adapter.complete(fixture.request, context);
          if (fixture.scenario === "abort_signal") {
            controller.abort();
            await expect(completion).rejects.toBeDefined();
            return;
          }

          const expectedError = ERROR_EXPECTATIONS[fixture.scenario];
          if (expectedError !== undefined) {
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
            return;
          }

          const result = ProviderResultSchema.parse(await completion);
          if (fixture.scenario === "text_only") {
            expect(result.parts.some((part) => part.type === "text")).toBe(true);
          } else if (fixture.scenario === "tool_call") {
            expect(result.parts.some((part) => part.type === "tool_call")).toBe(true);
          } else if (fixture.scenario === "usage_mapping") {
            expect(result.usage.inputTokens + result.usage.outputTokens).toBeGreaterThan(0);
          }
        } finally {
          await dispatcher.close();
        }
      });
    }
  });
}
