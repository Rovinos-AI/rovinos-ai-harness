// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import type { ModelRequest } from "@rovinos/schemas";
import { AdapterRegistry, ModelGateway, type ProviderAdapter } from "@rovinos/models";
import { validateWithTokens } from "@rovinos/pii";
import { AuditingVaultResolver, InMemoryVault } from "@rovinos/vault";
import { createCanaries } from "@rovinos/eval";
import { z } from "zod";

const runId = "00000000000000000000000001";

describe("token-aware validation canary", () => {
  it("keeps raw-value paths out of validation issues and repair prompts", async () => {
    const canary = createCanaries("token-validation-canary").email.value;
    const vault = new InMemoryVault();
    const token = await vault.put(runId, "email", canary);
    const resolver = new AuditingVaultResolver(vault, () => undefined);
    const refinement = z.string().superRefine((value, context) => {
      context.addIssue({ code: "custom", path: [value], message: "invalid" });
    });
    const recordKey = z
      .string()
      .transform((value) => ({ [value]: "value" }))
      .pipe(
        z.record(z.string(), z.string()).superRefine((record, context) => {
          const key = Object.keys(record)[0];
          if (key !== undefined) {
            context.addIssue({ code: "custom", path: [key], message: "invalid" });
          }
        }),
      );

    const refinementResult = await validateWithTokens(refinement, token, { runId, resolver });
    const recordResult = await validateWithTokens(recordKey, token, { runId, resolver });

    expect(refinementResult).toMatchObject({
      ok: false,
      issues: [{ path: ["*"] }],
    });
    expect(recordResult).toMatchObject({
      ok: false,
      issues: [{ path: ["*"] }],
    });
    expect(JSON.stringify([refinementResult, recordResult])).not.toContain(canary);

    const capturedRequests: ModelRequest[] = [];
    const provider: ProviderAdapter = {
      provider: "openai",
      kind: "openai",
      complete: (request) => {
        capturedRequests.push(request);
        return Promise.resolve({
          parts: [{ type: "text", text: JSON.stringify(token) }],
          usage: { inputTokens: 1, outputTokens: 1 },
          finishReason: "stop",
          latencyMs: 1,
        });
      },
    };
    const gateway = new ModelGateway(
      new AdapterRegistry([provider]),
      { ids: { next: () => runId }, clock: { now: () => 0 } },
      { maxRung: "native" },
    );
    let validationCalls = 0;
    const completion = await gateway.complete(
      {
        requestId: runId,
        model: { provider: "openai", model: "gpt-test" },
        messages: [{ role: "user", parts: [{ type: "text", text: "validate" }] }],
      },
      {
        runId,
        signal: new AbortController().signal,
        outputSchema: z.string(),
        valueTransform: async (_schema, value) => {
          validationCalls += 1;
          if (validationCalls > 1) {
            return { ok: true, tokenized: value };
          }
          return validateWithTokens(recordKey, value, { runId, resolver });
        },
      },
    );

    const repair = capturedRequests[1]?.messages.at(-1);
    expect(repair).toBeDefined();
    expect(JSON.stringify(repair)).not.toContain(canary);
    expect(JSON.stringify(repair)).toContain("[*]");
    expect(completion.schemaValid).toBe(true);
  });
});
