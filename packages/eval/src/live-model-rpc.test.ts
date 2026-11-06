// SPDX-License-Identifier: Apache-2.0
import { request as httpRequest } from "node:http";
import { stat } from "node:fs/promises";
import { dirname } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ModelCompletion, ModelPort } from "@rovinos/core";
import { Code, parseJson, JsonValue } from "@rovinos/schemas";
import { z } from "zod";
import { createLiveModelClient, startLiveModelGateway } from "./live-model-gateway.js";

const id = "00000000000000000000000000";
const request = { requestId: id, model: { provider: "test", model: "test" }, messages: [] };
const completion: ModelCompletion = {
  parts: [{ type: "text", text: "synthetic" }],
  usage: { inputTokens: 1, outputTokens: 1 },
  finishReason: "stop",
  provider: "test",
  model: "test",
  latencyMs: 0,
  schemaValid: true,
  repairAttempts: 0,
  fallbackDepth: 0,
  providerBlobs: [],
  enforcement: { valid: true, value: { result: "synthetic" }, rungUsed: "prompt" },
};
function raw(socketPath: string, value: unknown, path = "/complete"): Promise<string> {
  return new Promise((resolve, reject) => {
    const call = httpRequest(
      { socketPath, path, method: "POST", headers: { "content-type": "application/json" } },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          text += chunk;
        });
        response.on("end", () => {
          resolve(text);
        });
      },
    );
    call.once("error", reject);
    call.end(`${JSON.stringify(value)}${path === "/complete-tokenized" ? "\n" : ""}`);
  });
}
describe("live-model Unix socket RPC", () => {
  it("validates candidates inside the trial and sends only tokenized values back for repairs", async () => {
    const schema = z.object({ email: z.email() }).strict();
    const transform = vi.fn((_schema: z.ZodType, candidate: JsonValue) =>
      Promise.resolve({ ok: true as const, tokenized: candidate }),
    );
    const gateway = await startLiveModelGateway({
      complete: async (_input, context) => {
        expect(context.valueTransform).toBeTypeOf("function");
        const result = await context.valueTransform?.(schema, { email: "<EMAIL_1>" });
        expect(result).toEqual({ ok: true, tokenized: { email: "<EMAIL_1>" } });
        return {
          ...completion,
          enforcement: { valid: true, value: { email: "<EMAIL_1>" }, rungUsed: "native" },
        };
      },
    });
    try {
      const result = await createLiveModelClient(gateway.socketPath).complete(request, {
        runId: id,
        signal: new AbortController().signal,
        outputSchema: schema,
        valueTransform: transform,
      });
      expect(transform).toHaveBeenCalledWith(schema, { email: "<EMAIL_1>" });
      expect(result.enforcement).toMatchObject({ valid: true, value: { email: "<EMAIL_1>" } });
    } finally {
      await gateway.close();
    }
  });

  it("returns safe validation issues to host repairs before accepting a later candidate", async () => {
    const issues = [{ path: [], code: Code.parse("custom") }];
    const transform = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, issues })
      .mockResolvedValueOnce({ ok: true, tokenized: { result: "synthetic" } });
    const gateway = await startLiveModelGateway({
      complete: async (_input, context) => {
        expect(await context.valueTransform?.(JsonValue, null)).toEqual({ ok: false, issues });
        expect(await context.valueTransform?.(JsonValue, { result: "synthetic" })).toEqual({
          ok: true,
          tokenized: { result: "synthetic" },
        });
        return completion;
      },
    });
    try {
      await expect(
        createLiveModelClient(gateway.socketPath).complete(request, {
          runId: id,
          signal: new AbortController().signal,
          outputSchema: z.object({ result: z.string() }),
          valueTransform: transform,
        }),
      ).resolves.toMatchObject({ schemaValid: true });
      expect(transform).toHaveBeenCalledTimes(2);
    } finally {
      await gateway.close();
    }
  });

  it("sanitizes trial validator exceptions and rejects transforms without a schema", async () => {
    const gateway = await startLiveModelGateway({
      complete: async (_input, context) => {
        expect(await context.valueTransform?.(JsonValue, null)).toEqual({
          ok: false,
          issues: [{ path: [], code: "custom" }],
        });
        return completion;
      },
    });
    const valueTransform = () => Promise.reject(new Error("synthetic-vault-canary"));
    try {
      await expect(
        createLiveModelClient(gateway.socketPath).complete(request, {
          runId: id,
          signal: new AbortController().signal,
          outputSchema: z.object({ result: z.string() }),
          valueTransform,
        }),
      ).resolves.toMatchObject({ schemaValid: true });
      await expect(
        createLiveModelClient(gateway.socketPath).complete(request, {
          runId: id,
          signal: new AbortController().signal,
          valueTransform,
        }),
      ).rejects.toMatchObject({ code: "eval_live_request_invalid" });
    } finally {
      await gateway.close();
    }
  });

  it("serializes output schemas without functions and preserves host enforcement", async () => {
    let schemas = 0;
    const gateway = await startLiveModelGateway({
      complete: (input, context) => {
        expect(input.output?.schema).toMatchObject({ type: "object" });
        expect(context.outputSchema?.safeParse({ result: "synthetic" }).success).toBe(true);
        expect(context.outputSchema?.safeParse({ result: 123 }).success).toBe(false);
        schemas += 1;
        return Promise.resolve(completion);
      },
    });
    try {
      const result = await createLiveModelClient(gateway.socketPath).complete(request, {
        runId: id,
        signal: new AbortController().signal,
        outputSchema: z.object({ result: z.string() }).strict(),
      });
      expect(result.enforcement).toEqual(completion.enforcement);
      expect(schemas).toBe(1);
      expect(
        parseJson(
          JsonValue,
          await raw(gateway.socketPath, {
            request: {
              ...request,
              output: {
                name: "result",
                schema: { $ref: "https://evil.example.test/schema" },
                schemaHash: "a".repeat(64),
              },
            },
            runId: id,
          }),
        ),
      ).toEqual({ ok: false, code: "eval_live_request_invalid" });
      expect(schemas).toBe(1);
    } finally {
      await gateway.close();
    }
  });

  it("aborts active host requests and removes the socket on gateway shutdown", async () => {
    let started: (() => void) | undefined;
    let aborted: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const cancelled = new Promise<void>((resolve) => {
      aborted = resolve;
    });
    const lifetime = new AbortController();
    const gateway = await startLiveModelGateway(
      {
        complete: (_input, context) =>
          new Promise((_resolve, reject) => {
            context.signal.addEventListener(
              "abort",
              () => {
                aborted?.();
                reject(new Error("synthetic-credential-canary"));
              },
              { once: true },
            );
            started?.();
          }),
      },
      { signal: lifetime.signal },
    );
    const active = createLiveModelClient(gateway.socketPath).complete(request, {
      runId: id,
      signal: new AbortController().signal,
    });
    const rejected = active.then(
      () => {
        throw new Error("expected_rejection");
      },
      (error: unknown) => {
        expect(error).toMatchObject({ code: "eval_live_transport_failed" });
      },
    );
    await ready;
    lifetime.abort();
    await cancelled;
    await rejected;
    await gateway.close();
    await expect(stat(gateway.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("roundtrips strict completion fields and leaves host parent private", async () => {
    const gateway = await startLiveModelGateway({ complete: () => Promise.resolve(completion) });
    try {
      expect((await stat(dirname(gateway.socketPath))).mode & 0o777).toBe(0o700);
      expect((await stat(gateway.socketPath)).mode & 0o777).toBe(0o666);
      expect(
        await createLiveModelClient(gateway.socketPath).complete(request, {
          runId: id,
          signal: new AbortController().signal,
        }),
      ).toEqual(completion);
    } finally {
      await gateway.close();
    }
    await expect(stat(gateway.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
    await gateway.close();
  });

  it("rejects extra fields, arbitrary URLs, oversized bodies, and malformed envelopes", async () => {
    let calls = 0;
    const model: ModelPort = {
      complete: () => {
        calls += 1;
        return Promise.resolve(completion);
      },
    };
    const gateway = await startLiveModelGateway(model);
    try {
      for (const [value, path] of [
        [
          { request, runId: id, headers: { authorization: "synthetic-credential-canary" } },
          "/complete",
        ],
        [{ request, runId: id }, "https://evil.example.test/complete"],
        [{ request, runId: id, huge: "x".repeat(1_048_576) }, "/complete"],
        [{ request, runId: "invalid" }, "/complete"],
        [{ request, runId: id }, "/complete-tokenized"],
      ] as const) {
        const reply = await raw(gateway.socketPath, value, path);
        expect(parseJson(JsonValue, reply)).toEqual({
          ok: false,
          code: "eval_live_request_invalid",
        });
        expect(reply).not.toContain("synthetic-credential-canary");
      }
      expect(calls).toBe(0);
      expect(gateway.rejections).toBe(5);
    } finally {
      await gateway.close();
    }
  });

  it("sanitizes thrown provider errors", async () => {
    const gateway = await startLiveModelGateway({
      complete: () => Promise.reject(new Error("synthetic-credential-canary")),
    });
    try {
      await expect(
        createLiveModelClient(gateway.socketPath).complete(request, {
          runId: id,
          signal: new AbortController().signal,
        }),
      ).rejects.toMatchObject({
        code: "eval_live_provider_failed",
        message: "eval_live_provider_failed",
      });
    } finally {
      await gateway.close();
    }
  });

  it("aborts host work on client disconnect", async () => {
    let started: (() => void) | undefined;
    let aborted: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const cancelled = new Promise<void>((resolve) => {
      aborted = resolve;
    });
    const gateway = await startLiveModelGateway({
      complete: (_input, context) =>
        new Promise((_resolve, reject) => {
          context.signal.addEventListener(
            "abort",
            () => {
              aborted?.();
              reject(new Error("synthetic"));
            },
            { once: true },
          );
          started?.();
        }),
    });
    try {
      const controller = new AbortController();
      const active = createLiveModelClient(gateway.socketPath).complete(request, {
        runId: id,
        signal: controller.signal,
      });
      await ready;
      controller.abort();
      await expect(active).rejects.toMatchObject({ code: "eval_live_cancelled" });
      await cancelled;
    } finally {
      await gateway.close();
    }
  });
});
