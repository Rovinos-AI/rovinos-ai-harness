// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
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
import { AuditingVaultResolver, InMemoryVault, Token } from "@harness/vault";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PiiToolPort, Tokenizer } from "@harness/pii";
import * as telemetry from "@harness/telemetry";
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
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
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
      expect(
        result.events.filter(
          (event) => event.type === "pii_action" && event.action === "detokenized",
        ),
      ).toMatchObject([
        {
          type: "pii_action",
          boundary: "tool_input",
          action: "detokenized",
          toolId,
          entities: [{ type: "email", count: 1 }],
        },
      ]);
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
      transientVault: true,
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
        transientVault: true,
      }),
    ).rejects.toMatchObject({ code: "pii_disabled_in_production" });
  });

  // threat: T-10
  it.each(["tool", "createTool"])("rejects a pre-wrapped port supplied by %s", async (source) => {
    const piiConfig = PiiConfigSchema.parse({});
    const vault = new InMemoryVault();
    const wrapped = new PiiToolPort(makeTool([], null), {
      tokenizer: new Tokenizer({
        detectors: { detect: () => [] },
        policy: piiConfig,
        vault,
      }),
      config: piiConfig,
      resolver: new AuditingVaultResolver(vault, () => undefined),
    });

    await expect(
      createRuntime(config(), {
        store: new InMemoryEventStore(),
        ...(source === "tool" ? { tool: wrapped } : { createTool: () => wrapped }),
        transientVault: true,
        secretResolver,
      }),
    ).rejects.toMatchObject({ code: "pii_tool_port_already_wrapped" });
  });

  it("persists an injected-store vault and emits one metadata-only resolver audit after reopen", async () => {
    const directory = await dataDirectory();
    vi.stubEnv("HARNESS_DATA_DIR", directory);
    const emitSafeEventSpy = vi
      .spyOn(telemetry, "emitSafeEventToDefaultLogger")
      .mockImplementation(() => undefined);

    const runtime = await createRuntime(config(), {
      store: new InMemoryEventStore(),
      tool: makeTool([], null),
      model: scriptedModel({ value: email }),
      policy: allowAllPolicy,
      secretResolver,
    });
    let reopened: Awaited<ReturnType<typeof createRuntime>> | undefined;
    let runtimeClosed = false;
    try {
      const result = await runtime.run(email);
      const runId = result.events[0]?.runId;
      expect(runId).toBeDefined();
      expect(existsSync(join(directory, "vault.db"))).toBe(true);
      await runtime.close();
      runtimeClosed = true;

      reopened = await createRuntime(config(), {
        store: new InMemoryEventStore(),
        secretResolver,
      });
      if (runId === undefined) {
        throw new Error("Expected the run to have an ID.");
      }
      await expect(
        reopened.vault.resolve(runId, Token.parse("<EMAIL_1>"), { boundary: "ui" }),
      ).resolves.toBe(email);
      expect(emitSafeEventSpy).toHaveBeenCalledTimes(1);
      const audit = emitSafeEventSpy.mock.calls[0]?.[0];
      expect(audit).toMatchObject({
        runId,
        kind: "pii_action",
        boundary: "ui",
        action: "detokenized",
        entities: [{ type: "email", count: 1 }],
      });
      expect(Object.keys(audit ?? {}).sort()).toEqual(
        [
          "action",
          "boundary",
          "entities",
          "kind",
          "policyVersion",
          "runId",
          "seq",
          "spanId",
          "traceId",
          "ts",
        ].sort(),
      );
      expect(JSON.stringify(audit)).not.toContain(email);
    } finally {
      emitSafeEventSpy.mockRestore();
      if (reopened !== undefined) {
        await reopened.close();
      } else if (!runtimeClosed) {
        await runtime.close();
      }
    }
  });

  it("opens vault and store read-only without modifying either database", async () => {
    const directory = await dataDirectory();
    const runtime = await createRuntime(config(), {
      dataDir: directory,
      model: new FakeModelPort([completion([{ type: "text", text: "done" }])]),
      secretResolver,
    });
    let runId: ReturnType<typeof Id.parse> | undefined;
    try {
      const result = await runtime.run(email);
      runId = result.events[0]?.runId;
    } finally {
      await runtime.close();
    }
    if (runId === undefined) {
      throw new Error("Expected the run to have an ID.");
    }
    const vaultPath = join(directory, "vault.db");
    const storePath = join(directory, "harness.db");
    const vaultBefore = await readFile(vaultPath);
    const storeBefore = await readFile(storePath);
    const readOnlyRuntime = await createRuntime(config(), {
      dataDir: directory,
      readOnlyStore: true,
      secretResolver,
    });
    try {
      await expect(
        readOnlyRuntime.vault.resolve(runId, Token.parse("<EMAIL_1>"), { boundary: "ui" }),
      ).resolves.toBe(email);
    } finally {
      await readOnlyRuntime.close();
    }

    expect(await readFile(vaultPath)).toEqual(vaultBefore);
    expect(await readFile(storePath)).toEqual(storeBefore);
  });
});
