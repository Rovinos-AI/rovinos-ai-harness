// SPDX-License-Identifier: Apache-2.0
import { parseJson } from "@harness/schemas";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { runTestComposeCommand } from "../scripts/ci/network-isolation.js";

const fixtureResultsSchema = z
  .object({
    trusted: z
      .object({
        callSpanId: z.string().nullable(),
        traceparent: z.string().nullable(),
        receivedTraceparent: z.string().nullable(),
        hasBaggage: z.boolean(),
        childParentSpanId: z.string().nullable(),
        serverSpanParentMatches: z.boolean(),
      })
      .strict(),
    external: z
      .object({
        receivedTraceparent: z.string().nullable(),
        hasBaggage: z.boolean(),
        childParentSpanId: z.string().nullable(),
      })
      .strict(),
    privacy: z
      .object({
        outcome: z.enum(["ok", "error"]),
        rawContainsCanary: z.boolean(),
        toolResultRecorded: z.boolean(),
        eventsContainCanary: z.boolean(),
        spansContainCanary: z.boolean(),
        logsContainCanary: z.boolean(),
      })
      .strict(),
    oversized: z
      .object({
        outcome: z.enum(["ok", "error"]),
        errorCode: z.string().nullable(),
      })
      .strict(),
    cancellation: z
      .object({
        outcome: z.enum(["ok", "error"]),
        errorCode: z.string().nullable(),
      })
      .strict(),
    resume: z
      .object({
        crashType: z.string().nullable(),
        toolIntentRecorded: z.boolean(),
        toolResultRecorded: z.boolean(),
        resumedStatus: z.string(),
        counter: z.number().nullable(),
      })
      .strict(),
  })
  .strict();

type FixtureResults = z.infer<typeof fixtureResultsSchema>;

async function runFixtureClient(): Promise<FixtureResults> {
  const stdout = await runTestComposeCommand([
    "exec",
    "--no-TTY",
    "harness",
    "node",
    "--experimental-strip-types",
    "--disable-warning=ExperimentalWarning",
    "/app/mcp-integration-client.mjs",
  ]);
  return parseJson(fixtureResultsSchema, stdout.trim());
}

function fixtureResults(results: FixtureResults | undefined): FixtureResults {
  if (results === undefined) {
    throw new Error("The sample MCP integration client did not return results.");
  }
  return results;
}

describe("sample MCP server integration", () => {
  let results: FixtureResults | undefined;

  beforeAll(async () => {
    results = await runFixtureClient();
  }, 180_000);

  it("propagates only trusted trace context and verifies real server parent linkage", () => {
    const trusted = fixtureResults(results).trusted;
    expect(trusted.callSpanId).not.toBeNull();
    expect(trusted.receivedTraceparent).toBe(trusted.traceparent);
    expect(trusted.childParentSpanId).toBe(trusted.callSpanId);
    expect(trusted.serverSpanParentMatches).toBe(true);
    expect(trusted.hasBaggage).toBe(false);
  });

  it("does not send trace context to external servers", () => {
    expect(fixtureResults(results).external).toEqual({
      receivedTraceparent: null,
      hasBaggage: false,
      childParentSpanId: null,
    });
  });

  it("keeps server error canaries out of events, spans, and logs", () => {
    expect(fixtureResults(results).privacy).toEqual({
      outcome: "error",
      rawContainsCanary: true,
      toolResultRecorded: true,
      eventsContainCanary: false,
      spansContainCanary: false,
      logsContainCanary: false,
    });
  });

  it("maps a 2 MiB tool result to result_too_large", () => {
    expect(fixtureResults(results).oversized).toEqual({
      outcome: "error",
      errorCode: "result_too_large",
    });
  });

  it("cancels a slow tool call when its signal is aborted", () => {
    expect(fixtureResults(results).cancellation).toEqual({
      outcome: "error",
      errorCode: "mcp_timeout",
    });
  });

  it("executes a non-idempotent message once when resuming after a crash", () => {
    expect(fixtureResults(results).resume).toEqual({
      crashType: "simulated_crash",
      toolIntentRecorded: true,
      toolResultRecorded: false,
      resumedStatus: "suspended",
      counter: 1,
    });
  });
});
