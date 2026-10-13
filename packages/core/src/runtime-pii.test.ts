// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Code,
  Id,
  KeysConfigSchema,
  PiiConfigSchema,
  RunConfigSchema,
  type JsonValue,
} from "@harness/schemas";
import { InMemoryEventStore } from "@harness/store";
import { Token } from "@harness/vault";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelCompletion, ModelToolCall, ToolPort } from "./ports.js";
import { createRuntime } from "./runtime.js";
import type { RuntimeConfig } from "./runtime-config.js";
import { FakeModelPort } from "./testing/fake-model.js";
import { allowAllPolicy } from "./testing/allow-policy.js";

const email = "runtime-canary@example.test";
const toolId = Code.parse("test.echo");
const keys = KeysConfigSchema.parse({
  currentKeyId: "runtime-test",
  keys: [{ id: "runtime-test", secret: "env:RUNTIME_TEST_KEY" }],
});
const secretResolver = {
  resolve: () => Promise.resolve({ reveal: () => Buffer.alloc(32, 19).toString("base64") }),
};
const runConfig = RunConfigSchema.parse({});

let directories: string[] = [];

function completion(parts: ModelCompletion["parts"]): ModelCompletion {
  return {
    parts,
    usage: { inputTokens: 1, outputTokens: 1 },
    finishReason: parts.some((part) => part.type === "tool_call") ? "tool_calls" : "stop",
    provider: "test",
    model: "test",
    latencyMs: 0,
    schemaValid: true,
    repairAttempts: 0,
    fallbackDepth: 0,
    providerBlobs: null,
  };
}

function scriptedModel(args: JsonValue): FakeModelPort {
  const call: ModelToolCall = {
    callId: Id.parse("11111111111111111111111111"),
    toolId,
    args,
  };
  return new FakeModelPort([
    completion([{ type: "tool_call", ...call }]),
    completion([{ type: "text", text: "completed" }]),
  ]);
}

function makeTool(received: JsonValue[], output: JsonValue): ToolPort {
  return {
    describe: (id) => (id === toolId ? { idempotent: true, timeoutMs: 1_000 } : undefined),
    execute: (call) => {
      received.push(call.args);
      return Promise.resolve({ outcome: "ok", result: output });
    },
  };
}

async function dataDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "harness-runtime-pii-"));
  directories.push(directory);
  return directory;
}

function config(pii = PiiConfigSchema.parse({})): RuntimeConfig {
  return { run: runConfig, keys, pii };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
  directories = [];
});

describe("createRuntime PII composition", () => {
  it("detokenizes only allowlisted arguments and tokenizes tool output before recording", async () => {
    const received: JsonValue[] = [];
    const store = new InMemoryEventStore();
    const directory = await dataDirectory();
    const runtime = await createRuntime(
      config(
        PiiConfigSchema.parse({
          detokenize: [{ toolId, args: ["/allowed"] }],
          custom: [{ name: "tag", pattern: "TAG-[0-9]{4}" }],
        }),
      ),
      {
        dataDir: directory,
        store,
        tool: makeTool(received, { echo: email }),
        model: scriptedModel({ allowed: email, private: email }),
        policy: allowAllPolicy,
        secretResolver,
      },
    );

    let reopened: Awaited<ReturnType<typeof createRuntime>> | undefined;
    let runtimeClosed = false;
    try {
      const result = await runtime.run("start");
      const runId = result.events[0]?.runId;
      expect(runId).toBeDefined();
      expect(received).toEqual([{ allowed: email, private: "<EMAIL_1>" }]);
      expect(JSON.stringify(result.events)).not.toContain(email);
      expect(JSON.stringify(result.events)).toContain("<EMAIL_1>");
      expect("put" in runtime.vault).toBe(false);
      await runtime.close();
      runtimeClosed = true;

      reopened = await createRuntime(config(), {
        dataDir: directory,
        store: new InMemoryEventStore(),
        secretResolver,
      });
      if (runId === undefined) {
        throw new Error("Expected the run to have an ID.");
      }
      await expect(
        reopened.vault.resolve(runId, Token.parse("<EMAIL_1>"), { boundary: "ui" }),
      ).resolves.toBe(email);
    } finally {
      if (reopened !== undefined) {
        await reopened.close();
      } else if (!runtimeClosed) {
        await runtime.close();
      }
    }
  });

  it("leaves the raw tool port unwrapped when PII is disabled outside production", async () => {
    const received: JsonValue[] = [];
    const runtime = await createRuntime(config(PiiConfigSchema.parse({ enabled: false })), {
      dataDir: await dataDirectory(),
      store: new InMemoryEventStore(),
      tool: makeTool(received, null),
      model: scriptedModel({ value: email }),
      policy: allowAllPolicy,
      secretResolver,
    });

    try {
      await runtime.run("start");
      expect(received).toEqual([{ value: email }]);
    } finally {
      await runtime.close();
    }
  });

  it("rejects disabling PII in production before opening runtime resources", async () => {
    vi.stubEnv("NODE_ENV", "production");

    await expect(
      createRuntime(config(PiiConfigSchema.parse({ enabled: false })), {
        store: new InMemoryEventStore(),
      }),
    ).rejects.toMatchObject({ code: "pii_disabled_in_production" });
  });
});
